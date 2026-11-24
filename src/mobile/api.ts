import type { AvatarConfig, BackupPayload, BackupSummary, VrmFileInfo } from '../shared/types'
import { createLinkedApi, readLinkConfig, type LinkConfig, type LinkStatus } from './linkedApi'
import { createLocalApi, importPayloadWithAvatars } from './localApi'
import * as store from './localStore'
import type { MobileControls, MobileMode } from './mobile'
import { bytesToBase64, consumePairIntent, scanQrCode } from './native'
import { parsePairLink } from './pairing'

const MODE_KEY = 'virtua.mode'
export const AVATAR_MODE_NOTICE_KEY = 'virtua.avatar.modeNotice'

function storedMode(): MobileMode {
  const value = localStorage.getItem(MODE_KEY)
  return value === 'linked' ? 'linked' : 'local'
}

function persistMode(mode: MobileMode): void {
  localStorage.setItem(MODE_KEY, mode)
}

export function installMobileApi(): { mode: MobileMode; controls: MobileControls } {
  const params = new URLSearchParams(location.search)
  let paired = consumePairIntent()
  if (!paired) {
    const queryPair = params.get('pair')
    if (queryPair) {
      try { paired = parsePairLink(queryPair) } catch { paired = null }
    }
  }
  if (paired) {
    persistMode('linked')
    localStorage.setItem('virtua.link.url', paired.url)
    localStorage.setItem('virtua.link.token', paired.token)
  }

  const query = params.get('mode')
  const mode: MobileMode = paired ? 'linked' : (query === 'local' || query === 'linked' ? query : storedMode())
  if (!paired && (query === 'local' || query === 'linked')) persistMode(mode)

  const local = createLocalApi()
  const linked = createLinkedApi(mode === 'linked', local.api)
  window.api = mode === 'linked' ? linked.api : local.api
  let modeSwitching = false

  /** Carry the desktop's current VRM into phone storage before leaving linked mode. */
  const copyAvatarToPhone = async (): Promise<void> => {
    try {
      const config = await linked.api.avatar.getConfig() as AvatarConfig
      if (!config.vrmPath) {
        localStorage.setItem(AVATAR_MODE_NOTICE_KEY, 'Desktop is using the 2D sprite; this phone kept its own avatar.')
        return
      }
      const file = await linked.api.avatar.readVrm(config.vrmPath) as VrmFileInfo
      const name = file.name || config.vrmPath.split(/[\\/]/).pop() || 'avatar.vrm'
      const saved = await local.controller.saveAvatar(name, bytesToBase64(file.data))
      await local.api.avatar.setConfig({ ...config, vrmPath: saved.path, visible: true })
      localStorage.setItem(AVATAR_MODE_NOTICE_KEY, `Copied ${saved.name} to this phone.`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      localStorage.setItem(AVATAR_MODE_NOTICE_KEY, `Could not copy the desktop VRM to this phone: ${detail}`)
    }
  }

  const importPayload = async (payload: BackupPayload): Promise<BackupSummary> =>
    importPayloadWithAvatars(payload)

  const controls: MobileControls = {
    mode: () => mode,
    setMode: async (next) => {
      if (modeSwitching || next === mode) return
      modeSwitching = true
      try {
        if (next === 'local' && mode === 'linked') await copyAvatarToPhone()
        persistMode(next)
        const url = new URL(location.href)
        url.searchParams.set('mode', next)
        location.href = url.toString()
      } finally {
        modeSwitching = false
      }
    },
    // The paired bridge is available in both modes: Phone mode only changes where chat runs.
    // Keeping these controls on the linked API lets Portable Sync work without leaving Phone mode.
    linkStatus: () => linked.controller.status(),
    linkError: () => linked.controller.error(),
    onLinkStatus: (listener) => linked.controller.onStatus(listener),
    linkConfig: () => mode === 'linked' ? linked.controller.config() : readLinkConfig(),
    trustedDevices: () => linked.api.bridge.devices(),
    revokeDevice: async (id) => { await linked.api.bridge.revokeDevice(id) },
    allowDevice: async (id) => { await linked.api.bridge.allowDevice(id) },
    scanQr: () => scanQrCode(),
    reconnectLink: () => linked.controller.reconnect(),
    setLink: (config: LinkConfig) => {
      linked.controller.setConfig(config)
    },
    models: () => local.controller.models(),
    pickModel: () => local.controller.pickModel(),
    avatarFiles: () => local.controller.avatars(),
    importBundle: () => local.controller.importBundle(),
    exportBundle: () => local.controller.exportBundle(),
    importPayload,
    pull: async () => {
      // Always pull from the paired PC bridge, even while in Phone mode. The local API's
      // sync.pull is a SAF bundle import, not a desktop transfer.
      const payload = await linked.api.sync.pull() as BackupPayload
      return importPayload(payload)
    },
    push: async () => {
      const payload = store.exportBundle()
      await linked.api.sync.push(payload)
    }
  }

  window.virtuaMobile = controls
  return { mode, controls }
}
