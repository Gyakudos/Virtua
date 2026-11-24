import type {
  AvatarConfig, BackupPayload, BackupSummary, BridgeStatus, CalendarImportResult,
  ChatRequest, OllamaHealth, OllamaModel, RagSource, SpokenAudio, StreamHandlers,
  UpdateInfo, VrmFileInfo, VoiceConfig, VoiceStatus
} from '../shared/types'
import { BUILD_VERSION } from '../shared/version'
import { createApiProxy } from './apiContract'
import { readLinkConfig } from './linkedApi'
import { bytesFromBase64, bytesToBase64, callNative, nativeAvailable } from './native'
import * as store from './localStore'

export interface NativeModel {
  name: string
  path: string
  size?: number
}

export interface NativeAvatar {
  name: string
  path: string
  size?: number
}

interface ImportedAvatar {
  fileName: string
  path: string
  dataBase64?: string
}

interface ImportedModel {
  name: string
  fileName: string
  path: string
  size: number
}

const vrmCache = new Map<string, VrmFileInfo>()

function jsonSetting<T>(key: string, fallback: T): T {
  const raw = store.setting(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function avatarConfig(): AvatarConfig {
  return jsonSetting<AvatarConfig>('avatar.config', {
    visible: false,
    quality: 'low',
    vrmPath: null,
    zoom: 1
  })
}

function voiceConfig(): VoiceConfig {
  return jsonSetting<VoiceConfig>('voice.config', {
    ttsEngine: 'sapi',
    sapiVoice: '',
    sapiRate: 0,
    piperExecutable: '',
    piperModel: '',
    piperConfig: '',
    sttLanguage: 'en'
  })
}

function voiceStatus(): VoiceStatus {
  return {
    sapi: false,
    whisperModel: 'android',
    whisperReady: false,
    piperConfigured: false,
    sampleRate: 16000
  }
}

function bridgeStatus(): BridgeStatus {
  return {
    enabled: false,
    bindLan: false,
    port: 8787,
    host: '127.0.0.1',
    token: '',
    urls: [],
    running: false,
    desktopConnected: false,
    phoneConnected: false,
    devices: []
  }
}

function updateInfo(): UpdateInfo {
  return {
    current: BUILD_VERSION,
    latest: BUILD_VERSION,
    tag: '',
    name: 'Virtua for Android',
    notes: 'Manual GitHub update checks are available in the desktop app only.',
    url: '',
    publishedAt: null,
    newer: false
  }
}

export function summarizePayload(payload: BackupPayload): BackupSummary {
  return {
    conversations: payload.conversations.length,
    messages: payload.conversations.reduce((total, item) => total + (item.messages?.length ?? 0), 0),
    personas: payload.personas.length,
    characters: payload.characters.length,
    notes: payload.notes.length,
    tasks: payload.tasks.length,
    reminders: payload.reminders.length,
    calendarEvents: payload.calendarEvents.length,
    settings: payload.settings.length,
    avatars: payload.avatars?.length ?? 0,
    models: payload.modelFiles?.length ?? 0
  }
}

function pathMatches(path: string, avatar: ImportedAvatar): boolean {
  if (!path) return false
  if (path === avatar.path || path === avatar.fileName) return true
  const name = path.split(/[\\/]/).pop() ?? ''
  return name === avatar.fileName
}

function remapAvatars(payload: BackupPayload, avatars: ImportedAvatar[]): BackupPayload {
  if (avatars.length === 0) return payload
  for (const character of payload.characters) {
    const match = avatars.find((avatar) => pathMatches(character.avatarPath ?? '', avatar))
    if (match) character.avatarPath = match.path
  }
  for (const item of payload.settings) {
    if (item.key !== 'avatar.config') continue
    try {
      const config = JSON.parse(item.value) as AvatarConfig
      const match = avatars.find((avatar) => pathMatches(config.vrmPath ?? '', avatar))
      if (match) {
        config.vrmPath = match.path
        item.value = JSON.stringify(config)
      }
    } catch {
      // Leave malformed avatar settings untouched.
    }
  }
  payload.avatars = avatars.map((avatar) => ({ sourcePath: avatar.path, fileName: avatar.path }))
  return payload
}

/** Save VRM bytes delivered by a PC push into the phone's app-private avatar folder. */
async function importAvatarFiles(payload: BackupPayload): Promise<ImportedAvatar[]> {
  const files = payload.avatarFiles ?? []
  if (files.length === 0 || !nativeAvailable()) return []
  const imported: ImportedAvatar[] = []
  for (const file of files) {
    try {
      const saved = await callNative<{ name: string; path: string }>('saveAvatar', {
        fileName: file.fileName,
        dataBase64: file.dataBase64
      })
      imported.push({ fileName: saved.name, path: saved.path, dataBase64: file.dataBase64 })
      vrmCache.set(saved.path, {
        name: saved.name,
        path: saved.path,
        data: bytesFromBase64(file.dataBase64)
      })
    } catch (error) {
      console.warn('[mobile] could not import an avatar from the PC snapshot:', error)
    }
  }
  return imported
}

interface ModelTransferBegin {
  name: string
  path: string
  tempPath?: string
  size: number
  skipped: boolean
}

interface ModelImportResult {
  imported: ImportedModel[]
  errors: string[]
}

const MODEL_CHUNK_BYTES = 1024 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stream Ollama GGUF files from the PC bridge into app-private phone storage. */
async function importModelFiles(payload: BackupPayload): Promise<ModelImportResult> {
  const imported: ImportedModel[] = []
  const errors: string[] = []
  const files = payload.modelFiles ?? []
  if (files.length === 0) return { imported, errors }

  const link = readLinkConfig()
  if (!nativeAvailable() || !link.url || !link.token) {
    const reason = !nativeAvailable()
      ? 'Android native bridge is unavailable'
      : 'No active desktop link is configured'
    errors.push(`${reason}; cannot import ${files.length} model(s)`)
    return { imported, errors }
  }

  const origin = link.url.trim().replace(/\/+$/, '')
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')

  for (const file of files) {
    let tempPath = ''
    try {
      const response = await fetch(
        `${origin}/model?name=${encodeURIComponent(file.name)}&token=${encodeURIComponent(link.token)}`,
        { cache: 'no-store' }
      )
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
      }
      const size = Number(response.headers.get('content-length') ?? file.size) || file.size
      if (!response.body) throw new Error('The PC returned no model data.')

      const begin = await callNative<ModelTransferBegin>('beginModel', {
        fileName: file.fileName,
        size
      })
      if (begin.skipped) {
        imported.push({ name: file.name, fileName: begin.name, path: begin.path, size: begin.size })
        continue
      }
      tempPath = begin.tempPath ?? ''
      if (!tempPath) throw new Error('The phone did not return a temporary download path.')

      // Buffer small network reads into ~1 MB writes so multi-GB models need far fewer bridge calls.
      let pending = new Uint8Array(0)
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return
        await callNative('writeModelChunk', { tempPath, dataBase64: bytesToBase64(pending) })
        pending = new Uint8Array(0)
      }

      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        const merged = new Uint8Array(pending.length + value.length)
        merged.set(pending, 0)
        merged.set(value, pending.length)
        pending = merged
        if (pending.length >= MODEL_CHUNK_BYTES) await flush()
      }
      await flush()

      const saved = await callNative<NativeModel>('finishModel', {
        tempPath,
        targetPath: begin.path,
        size
      })
      tempPath = ''
      imported.push({ name: file.name, fileName: saved.name, path: saved.path, size: saved.size ?? size })
    } catch (error) {
      if (tempPath) await callNative('cancelModel', { tempPath }).catch(() => undefined)
      const detail = errorMessage(error)
      errors.push(`${file.name}: ${detail}`)
      console.warn(`[mobile] could not import model ${file.name}:`, error)
    }
  }
  return { imported, errors }
}

/** Import a snapshot that may contain avatar bytes (local bridge pull or phone port.receive). */
export async function importPayloadWithAvatars(payload: BackupPayload): Promise<BackupSummary> {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.conversations)) {
    throw new Error('Invalid backup payload.')
  }
  const [importedAvatars, modelResult] = await Promise.all([
    importAvatarFiles(payload),
    importModelFiles(payload)
  ])
  const next = remapAvatars(payload, importedAvatars)
  store.importBundle(next)
  return {
    ...summarizePayload(next),
    models: modelResult.imported.length,
    modelErrors: modelResult.errors
  }
}

function silentWav(): Uint8Array {
  const bytes = new Uint8Array(44)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, 0, true)
  return bytes
}

export interface LocalController {
  status(): 'ready' | 'native-unavailable'
  models(): Promise<NativeModel[]>
  pickModel(): Promise<NativeModel>
  avatars(): Promise<NativeAvatar[]>
  saveAvatar(fileName: string, dataBase64: string): Promise<NativeAvatar>
  beginModel(fileName: string, size: number): Promise<ModelTransferBegin>
  writeModelChunk(tempPath: string, dataBase64: string): Promise<void>
  finishModel(tempPath: string, targetPath: string, size: number): Promise<NativeModel>
  cancelModel(tempPath: string): Promise<void>
  importBundle(): Promise<BackupSummary>
  exportBundle(): Promise<void>
}

export function createLocalApi(): { api: Window['api']; controller: LocalController } {
  const importBundle = async (): Promise<BackupSummary> => {
    const result = await callNative<{ json: string; avatars: ImportedAvatar[] }>('importBundleFromSaf')
    const payload = JSON.parse(result.json) as BackupPayload
    const avatars = result.avatars ?? []
    for (const avatar of avatars) {
      if (!avatar.dataBase64) continue
      vrmCache.set(avatar.path, {
        name: avatar.fileName,
        path: avatar.path,
        data: bytesFromBase64(avatar.dataBase64)
      })
    }
    const next = remapAvatars(payload, avatars)
    store.importBundle(next)
    return summarizePayload(store.exportBundle())
  }

  const exportBundle = async (): Promise<void> => {
    const payload = store.exportBundle()
    await callNative('exportBundleToSaf', { json: JSON.stringify(payload) })
  }

  const invoke = async (path: string, args: unknown[]): Promise<unknown> => {
    switch (path) {
      case 'getVersion':
        return `${BUILD_VERSION} · phone`

      case 'health': {
        if (!nativeAvailable()) {
          return {
            status: 'offline',
            url: 'native',
            error: 'Open this build inside the Virtua Android app to use on-device GGUF models.'
          } satisfies OllamaHealth
        }
        try {
          const models = await callNative<NativeModel[]>('models')
          if (models.length === 0) {
            return { status: 'offline', url: 'native', error: 'No GGUF model imported yet.' } satisfies OllamaHealth
          }
          const mapped: OllamaModel[] = models.map((model) => ({
            name: model.name,
            size: model.size,
            modifiedAt: undefined
          }))
          return { status: 'online', url: 'native', models: mapped } satisfies OllamaHealth
        } catch (error) {
          return { status: 'offline', url: 'native', error: error instanceof Error ? error.message : String(error) } satisfies OllamaHealth
        }
      }

      case 'chatOnce': {
        const request = args[0] as ChatRequest
        const result = await callNative<{ text: string }>('complete', { request })
        return result.text
      }

      case 'cancel':
        await callNative('cancel', { requestId: String(args[0]) }).catch(() => undefined)
        return undefined

      case 'store.listConversations':
        return store.listConversations(args[0] as never, args[1] === true)
      case 'store.createConversation':
        return store.createConversation(args[0] as never, String(args[1]), (args[2] as string | null) ?? null, (args[3] as string | null) ?? null)
      case 'store.renameConversation':
        return store.renameConversation(String(args[0]), String(args[1]))
      case 'store.archiveConversation':
        return store.archiveConversation(String(args[0]), args[1] === true)
      case 'store.deleteConversation':
        return store.deleteConversation(String(args[0]))
      case 'store.listMessages':
        return store.listMessages(String(args[0]))
      case 'store.addMessage':
        return store.addMessage(String(args[0]), args[1] as 'user' | 'assistant', String(args[2]))
      case 'store.updateMessage':
        return store.updateMessage(String(args[0]), String(args[1]))
      case 'store.pinMessage':
        return store.pinMessage(String(args[0]), args[1] === true)
      case 'store.deleteMessage':
        return store.deleteMessage(String(args[0]))
      case 'store.exportConversation': {
        const id = String(args[0])
        const conversation = store.listConversations(undefined, true).find((item) => item.id === id)
        if (!conversation) return ''
        const lines = [`# ${conversation.title}`, '']
        for (const message of store.listMessages(id)) {
          lines.push(`## ${message.role === 'user' ? 'You' : 'Assistant'}`, '', message.content, '')
        }
        return lines.join('\n')
      }
      case 'store.listPersonas':
        return store.listPersonas()
      case 'store.upsertPersona':
        return store.upsertPersona(args[0] as never)
      case 'store.deletePersona':
        return store.deletePersona(String(args[0]))
      case 'store.listCharacters':
        return store.listCharacters()
      case 'store.upsertCharacter':
        return store.upsertCharacter(args[0] as never)
      case 'store.deleteCharacter':
        return store.deleteCharacter(String(args[0]))
      case 'store.searchNotes':
        return store.searchNotes(String(args[0] ?? ''))
      case 'store.createNote':
        return store.createNote(String(args[0]), String(args[1]), (args[2] as string[] | undefined) ?? [])
      case 'store.listTasks':
        return store.listTasks(typeof args[0] === 'string' ? args[0] : 'all')
      case 'store.createTask':
        return store.createTask(String(args[0]), (args[1] as string | null) ?? null, String(args[2] ?? 'normal'))
      case 'store.completeTask':
        return store.completeTask(String(args[0]))
      case 'store.listReminders':
        return store.listReminders()
      case 'store.createReminder':
        return store.createReminder(String(args[0]), (args[1] as string | null) ?? null)
      case 'store.listToolAudit':
        return store.listToolAudit(typeof args[0] === 'number' ? args[0] : 50)

      case 'rag.listSources':
        return store.data().ragSources as RagSource[]
      case 'rag.model':
        return store.setting('rag.model') ?? 'phone-gguf'
      case 'rag.pickFolder':
        return null
      case 'rag.cancel':
      case 'rag.removeSource':
        return undefined
      case 'rag.retrieve':
        return []
      case 'rag.getEnabled':
        return store.setting('rag.enabled') === 'true'
      case 'rag.setEnabled':
        return store.setSetting('rag.enabled', args[0] === true ? 'true' : 'false')

      case 'system.shortcutStatus':
      case 'system.hotkeyStatus':
        return false
      case 'system.shortcutCreate':
        return 'Not available on Android.'
      case 'system.shortcutRemove':
      case 'system.setTheme':
        if (path === 'system.setTheme') store.setSetting('ui.theme', String(args[0]))
        return undefined
      case 'system.hotkey':
        return 'none'
      case 'system.getTheme':
        return store.setting('ui.theme') === 'light' ? 'light' : 'dark'
      case 'system.backup':
        await exportBundle()
        return 'Mobile bundle exported.'
      case 'system.restore':
        return importBundle()
      case 'system.exportMobileBundle':
        await exportBundle()
        return { path: 'mobile export', avatars: 0 }

      case 'calendar.pick':
        return null
      case 'calendar.import':
        return { source: 'android', total: 0, imported: 0, skipped: 0, remindersCreated: 0 } satisfies CalendarImportResult
      case 'calendar.list':
        return store.data().calendarEvents
      case 'calendar.delete': {
        const current = store.data()
        current.calendarEvents = current.calendarEvents.filter((item) => item.id !== String(args[0]))
        store.save()
        return undefined
      }

      case 'voice.config':
        return voiceConfig()
      case 'voice.setConfig':
        store.setSetting('voice.config', JSON.stringify(args[0]))
        return undefined
      case 'voice.status':
        return voiceStatus()
      case 'voice.speak': {
        const result = await callNative<{ spoken: boolean }>('speak', { text: String(args[0]) })
        return { audio: silentWav(), mimeType: 'audio/wav', engine: 'sapi', characters: String(args[0]).length, spoken: result.spoken } satisfies SpokenAudio & { spoken: boolean }
      }
      case 'voice.stop':
        return undefined
      case 'voice.transcribe':
        return { text: '', durationMs: 0, engine: 'phone' }

      case 'avatar.getConfig':
        return avatarConfig()
      case 'avatar.setConfig':
        store.setSetting('avatar.config', JSON.stringify(args[0]))
        return undefined
      case 'avatar.pickVrm': {
        const result = await callNative<{ name: string; path: string; dataBase64: string }>('pickVrm')
        const info: VrmFileInfo = { name: result.name, path: result.path, data: bytesFromBase64(result.dataBase64) }
        vrmCache.set(info.path, info)
        return info
      }
      case 'avatar.readVrm': {
        const path = String(args[0])
        const cached = vrmCache.get(path)
        if (cached) return cached
        const result = await callNative<{ name: string; path: string; dataBase64: string }>('readVrm', { path })
        const info: VrmFileInfo = {
          name: result.name,
          path: result.path,
          data: bytesFromBase64(result.dataBase64)
        }
        vrmCache.set(info.path, info)
        return info
      }

      case 'images.ocrClipboard':
      case 'images.ocrFile':
        return { text: '', imagePath: String(args[0] ?? '') }

      case 'window.openRP':
      case 'window.minimizeRP':
      case 'window.closeRP':
        return undefined
      case 'window.setAlwaysOnTop':
        return false

      case 'connectors.list':
        return []
      case 'connectors.grant':
      case 'connectors.revoke':
      case 'connectors.cancel':
        return undefined
      case 'connectors.operaBookmarks':
        return []
      case 'connectors.vscodeSettings':
        return { settings: {}, extensions: [] }
      case 'connectors.listWindows':
        return []

      case 'dev.listRepos':
        return []
      case 'dev.gitStatus':
      case 'dev.gitDiff':
        return { exitCode: null, output: 'Git tools require the desktop bridge.' }
      case 'dev.cancel':
        return undefined

      case 'agent.cancel':
      case 'agent.approve':
        return undefined

      case 'bridge.config':
        return bridgeStatus()
      case 'bridge.status':
        return bridgeStatus()
      case 'bridge.setEnabled':
      case 'bridge.setBindLan':
        return bridgeStatus()
      case 'bridge.pairQr':
        throw new Error('The pairing QR is shown in the desktop Portable Sync panel.')
      case 'bridge.devices':
        return []
      case 'bridge.revokeDevice':
      case 'bridge.allowDevice':
        throw new Error('Trusted devices are managed in the desktop Portable Sync panel.')

      case 'update.check':
        return updateInfo()
      case 'update.open':
        return undefined

      case 'sync.pull':
        return importBundle()
      case 'sync.push':
        await exportBundle()
        return summarizePayload(store.exportBundle())

      case 'port.receive': {
        const payload = args[0] as BackupPayload
        if (!payload || typeof payload !== 'object') throw new Error('Invalid portable snapshot.')
        return await importPayloadWithAvatars(payload)
      }

      default:
        console.warn('[mobile] unsupported api call:', path)
        return undefined
    }
  }

  const subscribe = (path: string, args: unknown[]): (() => void) => {
    if (path === 'chatStream') {
      const request = args[0] as ChatRequest
      const handlers = args[1] as StreamHandlers
      void callNative<{ text: string }>('complete', { request }).then((result) => {
        handlers.onChunk(result.text || '')
        handlers.onDone()
      }).catch((error: unknown) => {
        handlers.onError(error instanceof Error ? error.message : String(error))
      })
      return () => void callNative('cancel', { requestId: request.requestId }).catch(() => undefined)
    }

    const handlers = args.find((arg) => arg && typeof arg === 'object') as
      { onError?: (error: string) => void } | undefined
    const message = path.startsWith('agent.')
      ? 'Agent mode requires the desktop bridge.'
      : `${path} is not available on the phone yet.`
    handlers?.onError?.(message)
    return () => undefined
  }

  const controller: LocalController = {
    status: () => nativeAvailable() ? 'ready' : 'native-unavailable',
    models: () => callNative<NativeModel[]>('models'),
    pickModel: async () => callNative<NativeModel>('pickModel'),
    avatars: () => callNative<NativeAvatar[]>('listAvatars'),
    saveAvatar: async (fileName, dataBase64) => {
      const saved = await callNative<NativeAvatar>('saveAvatar', { fileName, dataBase64 })
      vrmCache.set(saved.path, {
        name: saved.name,
        path: saved.path,
        data: bytesFromBase64(dataBase64)
      })
      return saved
    },
    beginModel: (fileName, size) => callNative<ModelTransferBegin>('beginModel', { fileName, size }),
    writeModelChunk: async (tempPath, dataBase64) => {
      await callNative('writeModelChunk', { tempPath, dataBase64 })
    },
    finishModel: (tempPath, targetPath, size) =>
      callNative<NativeModel>('finishModel', { tempPath, targetPath, size }),
    cancelModel: async (tempPath) => {
      await callNative('cancelModel', { tempPath })
    },
    importBundle,
    exportBundle
  }

  return {
    api: createApiProxy({ invoke, subscribe }),
    controller
  }
}
