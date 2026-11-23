import { dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { AvatarConfig, VrmFileInfo } from '../shared/types'
import * as store from './storage'

const CONFIG_KEY = 'avatar.config'
const DEFAULT_CONFIG: AvatarConfig = { visible: false, quality: 'low', vrmPath: null, zoom: 1 }

function clampZoom(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_CONFIG.zoom
  return Math.round(Math.max(0.6, Math.min(2.5, n)) * 100) / 100
}

export function getAvatarConfig(): AvatarConfig {
  const raw = store.getSetting(CONFIG_KEY)
  if (!raw) return { ...DEFAULT_CONFIG }
  try {
    const parsed = JSON.parse(raw) as Partial<AvatarConfig>
    return {
      visible: typeof parsed.visible === 'boolean' ? parsed.visible : DEFAULT_CONFIG.visible,
      quality: parsed.quality === 'high' ? 'high' : 'low',
      vrmPath: typeof parsed.vrmPath === 'string' ? parsed.vrmPath : null,
      zoom: clampZoom(parsed.zoom)
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function setAvatarConfig(config: AvatarConfig): void {
  store.setSetting(CONFIG_KEY, JSON.stringify(config))
}

export function readVrm(path: string): VrmFileInfo {
  if (extname(path).toLowerCase() !== '.vrm') throw new Error('Only .vrm files are supported.')
  const data = readFileSync(path)
  return { name: basename(path), path, data: new Uint8Array(data) }
}

export async function pickVrm(): Promise<VrmFileInfo | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a VRM avatar (stays on this device)',
    filters: [{ name: 'VRM avatar', extensions: ['vrm'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readVrm(result.filePaths[0])
}
