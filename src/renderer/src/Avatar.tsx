import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AvatarConfig, AvatarState, RendererInfo } from '../../shared/types'

interface AvatarProps {
  state: AvatarState
  config: AvatarConfig
  onPatch: (patch: Partial<AvatarConfig>) => void
  /** Live 0..1 amplitude from the currently playing local speech audio. */
  getMouthLevel?: () => number
}

/**
 * VRM models load in a T-pose. Normalized human bones use a rest pose where
 * the upper arms point along ±X, so a positive Z rotation lowers the left arm
 * and a negative Z rotation lowers the right one. The numbers below were
 * tuned against the local VRM 0 model's actual bone positions.
 */
const IDLE_LEFT_UPPER_Z = 1.2
const IDLE_RIGHT_UPPER_Z = -1.2
const IDLE_UPPER_X = 0.18
const IDLE_LEFT_LOWER_Z = -0.35
const IDLE_RIGHT_LOWER_Z = 0.35

function applyIdlePose(vrm: VRM, blend: number, t: number): void {
  if (blend <= 0) return
  const humanoid = vrm.humanoid
  if (!humanoid) return
  const breathe = Math.sin(t * 1.25) * 0.012
  const sway = Math.sin(t * 0.7) * 0.02

  const set = (name: 'leftUpperArm' | 'rightUpperArm' | 'leftLowerArm' | 'rightLowerArm', x: number, z: number): void => {
    const node = humanoid.getNormalizedBoneNode(name)
    if (node) node.rotation.set(x * blend, 0, z * blend)
  }

  set('leftUpperArm', IDLE_UPPER_X + breathe, IDLE_LEFT_UPPER_Z + sway)
  set('rightUpperArm', IDLE_UPPER_X + breathe, IDLE_RIGHT_UPPER_Z - sway)
  set('leftLowerArm', 0, IDLE_LEFT_LOWER_Z)
  set('rightLowerArm', 0, IDLE_RIGHT_LOWER_Z)

  const chest = humanoid.getNormalizedBoneNode('chest')
  if (chest) chest.rotation.x = breathe * 0.5 * blend
}

const ZOOM_MIN = 0.6
const ZOOM_MAX = 2.5

function clampZoom(value: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1
  return Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n)) * 100) / 100
}

function detectRenderer(): RendererInfo {
  const probe = document.createElement('canvas')
  const gl = (probe.getContext('webgl2') ?? probe.getContext('webgl')) as WebGLRenderingContext | null
  if (!gl) return { webgl: false, renderer: 'WebGL unavailable', software: true }
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER))
  const software = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer)
  return { webgl: true, renderer, software }
}

export default function Avatar({ state, config, onPatch, getMouthLevel }: AvatarProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mouthElRef = useRef<HTMLSpanElement | null>(null)
  const mouthReaderRef = useRef<(() => number) | undefined>(getMouthLevel)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const lookTargetRef = useRef<THREE.Object3D | null>(null)
  const vrmRef = useRef<VRM | null>(null)
  const stateRef = useRef<AvatarState>(state)
  const qualityRef = useRef(config.quality)
  const zoomRef = useRef(clampZoom(config.zoom))
  const yawBaseRef = useRef(0)
  const poseBlendRef = useRef(0)
  const patchRef = useRef(onPatch)
  const [rendererInfo, setRendererInfo] = useState<RendererInfo | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { mouthReaderRef.current = getMouthLevel }, [getMouthLevel])
  useEffect(() => { patchRef.current = onPatch }, [onPatch])
  useEffect(() => {
    zoomRef.current = clampZoom(config.zoom)
  }, [config.zoom])

  const setZoom = (value: number): void => {
    patchRef.current({ zoom: clampZoom(value) })
  }

  // Mouse wheel over the preview zooms without scrolling the surrounding UI.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const step = event.deltaY < 0 ? 0.1 : -0.1
      setZoom(zoomRef.current + step)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  // The 2D fallback mouth follows the same amplitude as the VRM shape key.
  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const mouth = mouthElRef.current
      if (!mouth) return
      const level = Math.max(0, Math.min(1, mouthReaderRef.current?.() ?? 0))
      mouth.style.height = `${4 + level * 9}px`
      mouth.style.width = `${18 + level * 5}px`
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    qualityRef.current = config.quality
    const renderer = rendererRef.current
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.quality === 'low' ? 1 : 2))
    }
  }, [config.quality])

  // One WebGL scene for the lifetime of the panel. State and quality are read
  // from refs so the render loop never needs to be rebuilt.
  useEffect(() => {
    const info = detectRenderer()
    setRendererInfo(info)
    if (!info.webgl || !canvasRef.current || !stageRef.current) return

    const canvas = canvasRef.current
    const stage = stageRef.current
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 30)
    camera.position.set(0, 1.45, 1.6)
    camera.lookAt(0, 1.35, 0)

    const ambient = new THREE.AmbientLight(0xffffff, 1.7)
    const key = new THREE.DirectionalLight(0xffffff, 1.3)
    key.position.set(1, 2, 2)
    scene.add(ambient, key)

    const lookTarget = new THREE.Object3D()
    lookTarget.position.set(0, 1.4, 1.2)
    scene.add(lookTarget)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: qualityRef.current === 'high',
        powerPreference: qualityRef.current === 'low' ? 'low-power' : 'default'
      })
    } catch (error) {
      setRendererInfo({ webgl: false, renderer: error instanceof Error ? error.message : String(error), software: true })
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, qualityRef.current === 'low' ? 1 : 2))
    renderer.setClearColor(0x000000, 0)

    sceneRef.current = scene
    cameraRef.current = camera
    rendererRef.current = renderer
    lookTargetRef.current = lookTarget

    const resize = (): void => {
      const width = Math.max(1, stage.clientWidth)
      const height = Math.max(1, stage.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)

    const clock = new THREE.Clock()
    let frame = 0
    let lastFrame = 0
    let nextBlink = 2 + Math.random() * 3
    let blinkUntil = 0

    const animate = (): void => {
      frame = requestAnimationFrame(animate)
      const now = performance.now()
      if (now - lastFrame < (qualityRef.current === 'low' ? 33 : 16)) return
      lastFrame = now

      const delta = Math.min(clock.getDelta(), 0.1)
      const t = clock.elapsedTime

      // Keep the face centered while zooming: scale the camera's offset from
      // the look-at point instead of changing the field of view.
      const zoom = zoomRef.current
      const focusY = 1.35
      camera.position.set(0, focusY + (1.45 - focusY) / zoom, 1.6 / zoom)
      camera.lookAt(0, focusY, 0)

      const vrm = vrmRef.current
      if (vrm) {
        const em = vrm.expressionManager
        const current = stateRef.current

        if (em) {
          if (em.getExpressionTrackName('blink')) {
            if (t >= nextBlink) {
              blinkUntil = t + 0.13
              nextBlink = t + 2.5 + Math.random() * 3.5
            }
            em.setValue('blink', t < blinkUntil ? 1 : 0)
          }
          const mouth = Math.max(0, Math.min(1, mouthReaderRef.current?.() ?? 0))
          if (em.getExpressionTrackName('aa')) {
            em.setValue('aa', current === 'speaking' ? 0.08 + mouth * 0.85 : 0)
          }
          if (em.getExpressionTrackName('oh')) {
            em.setValue('oh', current === 'speaking' ? mouth * 0.5 : 0)
          }
          if (em.getExpressionTrackName('sad')) {
            em.setValue('sad', current === 'error' ? 0.6 : 0)
          }
        }

        const targetTilt = current === 'thinking' ? -0.1 : current === 'error' ? 0.06 : 0
        vrm.scene.rotation.z += (targetTilt - vrm.scene.rotation.z) * 0.08
        const sway = current === 'idle' || current === 'listening' ? Math.sin(t * 0.35) * 0.05 : 0
        const targetYaw = yawBaseRef.current + sway
        vrm.scene.rotation.y += (targetYaw - vrm.scene.rotation.y) * 0.05
        const bob = current === 'speaking'
          ? Math.abs(Math.sin(t * 8)) * 0.018
          : Math.sin(t * 1.6) * 0.006
        vrm.scene.position.y = bob

        if (poseBlendRef.current < 1) {
          poseBlendRef.current = Math.min(1, poseBlendRef.current + delta * 2)
        }
        applyIdlePose(vrm, poseBlendRef.current, t)
        vrm.update(delta)
      }

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      const activeVrm = vrmRef.current
      if (activeVrm) {
        scene.remove(activeVrm.scene)
        VRMUtils.deepDispose(activeVrm.scene)
        vrmRef.current = null
      }
      sceneRef.current = null
      cameraRef.current = null
      rendererRef.current = null
      lookTargetRef.current = null
      renderer.dispose()
    }
  }, [])

  // Load the chosen VRM from disk through the main process (no network, no
  // renderer filesystem access). Re-loads whenever the saved path changes.
  useEffect(() => {
    if (!config.vrmPath || !sceneRef.current) {
      setLoaded(false)
      const previous = vrmRef.current
      if (previous && sceneRef.current) {
        sceneRef.current.remove(previous.scene)
        VRMUtils.deepDispose(previous.scene)
        vrmRef.current = null
      }
      yawBaseRef.current = 0
      poseBlendRef.current = 0
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    const run = async (): Promise<void> => {
      try {
        const file = await window.api.avatar.readVrm(config.vrmPath as string)
        const scene = sceneRef.current
        if (!scene || cancelled) return

        const existing = vrmRef.current
        if (existing) {
          scene.remove(existing.scene)
          VRMUtils.deepDispose(existing.scene)
          vrmRef.current = null
        }

        const loader = new GLTFLoader()
        loader.register((parser) => new VRMLoaderPlugin(parser))
        const buffer = new Uint8Array(file.data).buffer
        const gltf = await loader.parseAsync(buffer, '')
        const vrm = gltf.userData.vrm as VRM | undefined
        if (!vrm) throw new Error('That file is not a valid VRM model.')

        if (cancelled) {
          VRMUtils.deepDispose(vrm.scene)
          return
        }
        // VRM 0.x models face -Z; VRM 1.x face +Z. Normalize before adding.
        VRMUtils.rotateVRM0(vrm)
        yawBaseRef.current = vrm.scene.rotation.y
        scene.add(vrm.scene)
        if (vrm.lookAt && lookTargetRef.current) vrm.lookAt.target = lookTargetRef.current
        vrmRef.current = vrm
        poseBlendRef.current = 0
        setLoaded(true)
      } catch (error) {
        if (!cancelled) {
          setLoaded(false)
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [config.vrmPath])

  const pick = async (): Promise<void> => {
    try {
      const file = await window.api.avatar.pickVrm()
      if (file) onPatch({ vrmPath: file.path, visible: true })
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = lookTargetRef.current
    const stage = stageRef.current
    if (!target || !stage) return
    const rect = stage.getBoundingClientRect()
    const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1
    target.position.set(nx * 0.7, 1.42 - ny * 0.35, 1.2)
  }

  const showFallback = !rendererInfo?.webgl || !loaded

  return (
    <div className="avatar-panel">
      <div className="avatar-head">
        <strong>Avatar</strong>
        <span className={`avatar-state avatar-state--${state}`}>{state}</span>
        <span className="spacer" />
        <button type="button" className="icon" title="Hide avatar" onClick={() => onPatch({ visible: false })}>×</button>
      </div>

      <div className="avatar-stage" ref={stageRef} onMouseMove={onMouseMove}>
        <canvas
          ref={canvasRef}
          className="avatar-canvas"
          style={{ display: rendererInfo?.webgl ? 'block' : 'none' }}
        />
        {showFallback && (
          <div className="avatar-fallback">
            <div className="avatar-fallback-scale" style={{ transform: `scale(${clampZoom(config.zoom)})` }}>
              <div className={`avatar-2d avatar-2d--${state}`}>
                <div className="avatar-2d-head">
                  <span className="avatar-eye" />
                  <span className="avatar-eye" />
                  <span className="avatar-mouth" ref={mouthElRef} />
                </div>
                <div className="avatar-2d-body" />
              </div>
            </div>
            <small className="muted">
              {rendererInfo?.webgl
                ? (loading ? 'Loading local VRM…' : '2D fallback · load a .vrm file')
                : 'WebGL unavailable · 2D fallback'}
            </small>
          </div>
        )}
      </div>

      <div className="avatar-controls">
        <button type="button" className="small primary" onClick={() => void pick()}>Load .vrm</button>
        {config.vrmPath && (
          <button type="button" className="small" onClick={() => onPatch({ vrmPath: null })}>Clear</button>
        )}
        <label className="field">
          <span>Quality</span>
          <select
            value={config.quality}
            onChange={(event) => onPatch({ quality: event.target.value === 'high' ? 'high' : 'low' })}
          >
            <option value="low">Low (30 FPS)</option>
            <option value="high">High (60 FPS)</option>
          </select>
        </label>
        <div className="avatar-zoom" title="Scroll over the preview to zoom">
          <span className="avatar-zoom-label">Zoom</span>
          <button type="button" className="small" aria-label="Zoom out" onClick={() => setZoom(config.zoom - 0.1)}>−</button>
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.05}
            value={clampZoom(config.zoom)}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <button type="button" className="small" aria-label="Zoom in" onClick={() => setZoom(config.zoom + 0.1)}>+</button>
          <button type="button" className="small" title="Reset zoom" onClick={() => setZoom(1)}>↺</button>
          <span className="avatar-zoom-value">{Math.round(clampZoom(config.zoom) * 100)}%</span>
        </div>
      </div>

      <div className="avatar-meta">
        <small className="muted" title={config.vrmPath ?? ''}>
          {config.vrmPath ? config.vrmPath.split(/[\\/]/).pop() : 'No VRM selected'}
        </small>
        {rendererInfo && <small className="muted" title={rendererInfo.renderer}>
          {rendererInfo.software ? 'software renderer' : 'hardware renderer'} · {rendererInfo.renderer.slice(0, 42)}
        </small>}
        {loadError && <small className="banner banner--error">{loadError}</small>}
        <small className="muted">Local file only · no upload · check the model's license</small>
      </div>
    </div>
  )
}
