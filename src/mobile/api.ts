import type { BackupPayload, BackupSummary } from '../shared/types'
import { createLinkedApi, readLinkConfig, type LinkConfig, type LinkStatus } from './linkedApi'
import { createLocalApi, summarizePayload } from './localApi'
import * as store from './localStore'
import type { MobileControls, MobileMode } from './mobile'

const MODE_KEY = 'virtua.mode'

function storedMode(): MobileMode {
  const value = localStorage.getItem(MODE_KEY)
  return value === 'linked' ? 'linked' : 'local'
}

function persistMode(mode: MobileMode): void {
  localStorage.setItem(MODE_KEY, mode)
}

export function installMobileApi(): { mode: MobileMode; controls: MobileControls } {
  const query = new URLSearchParams(location.search).get('mode')
  const mode: MobileMode = query === 'local' || query === 'linked' ? query : storedMode()
  if (query === 'local' || query === 'linked') persistMode(mode)

  const local = createLocalApi()
  const linked = createLinkedApi(mode === 'linked')
  window.api = mode === 'linked' ? linked.api : local.api

  const importPayload = async (payload: BackupPayload): Promise<BackupSummary> => {
    store.importBundle(payload)
    return summarizePayload(payload)
  }

  const controls: MobileControls = {
    mode: () => mode,
    setMode: (next) => {
      persistMode(next)
      const url = new URL(location.href)
      url.searchParams.set('mode', next)
      location.href = url.toString()
    },
    linkStatus: () => mode === 'linked' ? linked.controller.status() : 'unconfigured',
    onLinkStatus: (listener) => mode === 'linked'
      ? linked.controller.onStatus(listener)
      : () => undefined,
    linkConfig: () => mode === 'linked' ? linked.controller.config() : readLinkConfig(),
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
