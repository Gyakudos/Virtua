import type { BackupPayload, BackupSummary } from '../shared/types'
import { createLinkedApi, readLinkConfig, type LinkConfig, type LinkStatus } from './linkedApi'
import { createLocalApi, importPayloadWithAvatars } from './localApi'
import * as store from './localStore'
import type { MobileControls, MobileMode } from './mobile'
import { consumePairIntent, scanQrCode } from './native'
import { parsePairLink } from './pairing'

const MODE_KEY = 'virtua.mode'

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

  const importPayload = async (payload: BackupPayload): Promise<BackupSummary> =>
    importPayloadWithAvatars(payload)

  const controls: MobileControls = {
    mode: () => mode,
    setMode: (next) => {
      persistMode(next)
      const url = new URL(location.href)
      url.searchParams.set('mode', next)
      location.href = url.toString()
    },
    linkStatus: () => mode === 'linked' ? linked.controller.status() : 'unconfigured',
    linkError: () => mode === 'linked' ? linked.controller.error() : '',
    onLinkStatus: (listener) => mode === 'linked'
      ? linked.controller.onStatus(listener)
      : () => undefined,
    linkConfig: () => mode === 'linked' ? linked.controller.config() : readLinkConfig(),
    trustedDevices: () => window.api.bridge.devices(),
    revokeDevice: async (id) => { await window.api.bridge.revokeDevice(id) },
    allowDevice: async (id) => { await window.api.bridge.allowDevice(id) },
    scanQr: () => scanQrCode(),
    reconnectLink: () => {
      if (mode === 'linked') linked.controller.reconnect()
    },
    setLink: (config: LinkConfig) => {
      if (mode === 'linked') {
        linked.controller.setConfig(config)
        return
      }
      localStorage.setItem('virtua.link.url', config.url.trim())
      localStorage.setItem('virtua.link.token', config.token.trim())
      const url = new URL(location.href)
      url.searchParams.set('mode', 'linked')
      location.href = url.toString()
    },
    models: () => local.controller.models(),
    pickModel: () => local.controller.pickModel(),
    avatarFiles: () => local.controller.avatars(),
    importBundle: () => local.controller.importBundle(),
    exportBundle: () => local.controller.exportBundle(),
    importPayload,
    pull: async () => {
      const payload = await window.api.sync.pull() as BackupPayload
      return importPayload(payload)
    },
    push: async () => {
      const payload = store.exportBundle()
      await window.api.sync.push(payload)
    }
  }

  window.virtuaMobile = controls
  return { mode, controls }
}
