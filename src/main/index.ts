import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import { BUILD_VERSION } from '../shared/version'
import type {
  AgentMessage, AvatarConfig, ChatRequest, ConnectorKind, ConnectorRunRequest, ConversationKind, DevRunRequest,
  PendingApproval, Persona, Character, RagResult, VoiceConfig
} from '../shared/types'
import { bridgeConfig, bridgeStatus, setBridgeBindLan, setBridgeEnabled, startBridge, stopBridge } from './bridge'
import { chatOnce, chatStream, getHealth } from './ollama'
import { runAgent } from './agent'
import * as avatar from './avatar'
import * as calendar from './calendar'
import * as polish from './polish'
import * as voice from './voice'
import * as connectors from './connectors'
import * as dev from './dev'
import * as images from './images'
import { EMBED_MODEL, indexFolder, retrieve } from './rag'
import * as store from './storage'
import * as updates from './update'

const activeRequests = new Map<string, AbortController>()
const activeAgents = new Map<string, AbortController>()
const activeIndexes = new Map<string, AbortController>()
const activeDevRuns = new Map<string, AbortController>()
const activeConnectorRuns = new Map<string, AbortController>()
const pendingApprovals = new Map<string, {
  requestId: string
  resolve: (approved: boolean) => void
  timeout: NodeJS.Timeout
}>()
let rpWindow: BrowserWindow | null = null

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function makeApprovalRequester(requestId: string, sender: WebContents, channel = 'agent:approval-request') {
  return (approval: PendingApproval): Promise<boolean> => new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(approval.callId)
      resolve(false)
    }, 120000)
    pendingApprovals.set(approval.callId, { requestId, resolve, timeout })
    sender.send(channel, { requestId, approval })
  })
}

function clearApprovalsFor(requestId: string): void {
  for (const [callId, pending] of pendingApprovals) {
    if (pending.requestId === requestId) {
      clearTimeout(pending.timeout)
      pendingApprovals.delete(callId)
      pending.resolve(false)
    }
  }
}

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((window) =>
    !window.isDestroyed() && !window.webContents.getURL().includes('view=rp')
  )
}

function rendererQuery(view?: 'rp'): string {
  return view ? `?view=${view}` : ''
}

function loadRenderer(window: BrowserWindow, view?: 'rp'): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    window.loadURL(`${rendererUrl}${rendererQuery(view)}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: view ? { view } : undefined
    })
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: `Virtual Assistant ${BUILD_VERSION}`,
    backgroundColor: '#111318',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  loadRenderer(window)
}

function openChatRP(): void {
  if (rpWindow && !rpWindow.isDestroyed()) {
    rpWindow.focus()
    return
  }

  rpWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 380,
    minHeight: 480,
    title: 'ChatRP',
    backgroundColor: '#14121a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  rpWindow.on('closed', () => {
    rpWindow = null
  })

  loadRenderer(rpWindow, 'rp')
}

function registerIpc(): void {
  ipcMain.handle('app:getVersion', () => BUILD_VERSION)
  ipcMain.handle('ollama:health', () => getHealth())

  ipcMain.handle('ollama:chatOnce', async (_event, request: ChatRequest) => {
    const controller = new AbortController()
    activeRequests.set(request.requestId, controller)
    try {
      return await chatOnce(request.model, request.messages, controller.signal)
    } finally {
      activeRequests.delete(request.requestId)
    }
  })

  ipcMain.on('ollama:chatStream', async (event, request: ChatRequest) => {
    const controller = new AbortController()
    activeRequests.set(request.requestId, controller)

    try {
      await chatStream(
        request.model,
        request.messages,
        (chunk) => event.sender.send('ollama:chunk', { requestId: request.requestId, chunk }),
        controller.signal
      )
      event.sender.send('ollama:done', { requestId: request.requestId })
    } catch (error) {
      event.sender.send('ollama:error', {
        requestId: request.requestId,
        error: errorMessage(error)
      })
    } finally {
      activeRequests.delete(request.requestId)
    }
  })

  ipcMain.handle('ollama:cancel', (_event, requestId: string) => {
    activeRequests.get(requestId)?.abort()
    activeRequests.delete(requestId)
  })

  ipcMain.on('agent:run', async (event, request: {
    requestId: string
    model: string
    messages: AgentMessage[]
  }) => {
    const controller = new AbortController()
    activeAgents.set(request.requestId, controller)

    const requestApproval = makeApprovalRequester(request.requestId, event.sender)

    try {
      await runAgent({
        requestId: request.requestId,
        model: request.model,
        messages: request.messages,
        signal: controller.signal,
        sendChunk: (chunk) => event.sender.send('agent:chunk', { requestId: request.requestId, chunk }),
        sendTool: (activity) => event.sender.send('agent:tool', { requestId: request.requestId, activity }),
        requestApproval
      })
      event.sender.send('agent:done', { requestId: request.requestId })
    } catch (error) {
      event.sender.send('agent:error', { requestId: request.requestId, error: errorMessage(error) })
    } finally {
      activeAgents.delete(request.requestId)
      clearApprovalsFor(request.requestId)
    }
  })

  ipcMain.handle('agent:cancel', (_event, requestId: string) => {
    activeAgents.get(requestId)?.abort()
    activeAgents.delete(requestId)
  })

  ipcMain.handle('agent:approval-response', (_event, callId: string, approved: boolean) => {
    const pending = pendingApprovals.get(callId)
    if (!pending) return
    clearTimeout(pending.timeout)
    pendingApprovals.delete(callId)
    pending.resolve(approved)
  })

  ipcMain.handle('store:listConversations', (_event, kind?: ConversationKind, includeArchived?: boolean) =>
    store.listConversations(kind, includeArchived)
  )
  ipcMain.handle('store:createConversation', (_event, kind: ConversationKind, title: string, personaId: string | null, characterId: string | null) =>
    store.createConversation(kind, title, personaId, characterId)
  )
  ipcMain.handle('store:renameConversation', (_event, id: string, title: string) => store.renameConversation(id, title))
  ipcMain.handle('store:archiveConversation', (_event, id: string, archived: boolean) => store.setConversationArchived(id, archived))
  ipcMain.handle('store:deleteConversation', (_event, id: string) => store.deleteConversation(id))

  ipcMain.handle('store:listMessages', (_event, conversationId: string) => store.listMessages(conversationId))
  ipcMain.handle('store:addMessage', (_event, conversationId: string, role: 'user' | 'assistant', content: string) =>
    store.addMessage(conversationId, role, content)
  )
  ipcMain.handle('store:updateMessage', (_event, id: string, content: string) => store.updateMessage(id, content))
  ipcMain.handle('store:pinMessage', (_event, id: string, pinned: boolean) => store.setMessagePinned(id, pinned))
  ipcMain.handle('store:deleteMessage', (_event, id: string) => store.deleteMessage(id))
  ipcMain.handle('store:exportConversation', (_event, id: string) => store.exportConversationMarkdown(id))

  ipcMain.handle('store:listPersonas', () => store.listPersonas())
  ipcMain.handle('store:upsertPersona', (_event, persona: Persona) => store.upsertPersona(persona))
  ipcMain.handle('store:deletePersona', (_event, id: string) => store.deletePersona(id))

  ipcMain.handle('store:listCharacters', () => store.listCharacters())
  ipcMain.handle('store:upsertCharacter', (_event, character: Character) => store.upsertCharacter(character))
  ipcMain.handle('store:deleteCharacter', (_event, id: string) => store.deleteCharacter(id))

  ipcMain.handle('store:searchNotes', (_event, query: string) => store.searchNotes(query))
  ipcMain.handle('store:createNote', (_event, title: string, content: string, tags: string[]) =>
    store.createNote(title, content, tags)
  )
  ipcMain.handle('store:listTasks', (_event, status?: string) => store.listTasks(status))
  ipcMain.handle('store:createTask', (_event, title: string, dueAt: string | null, priority: string) =>
    store.createTask(title, dueAt, priority)
  )
  ipcMain.handle('store:completeTask', (_event, idOrTitle: string) => store.completeTask(idOrTitle))
  ipcMain.handle('store:listReminders', () => store.listReminders())
  ipcMain.handle('store:createReminder', (_event, title: string, fireAt: string | null) =>
    store.createReminder(title, fireAt)
  )
  ipcMain.handle('store:listToolAudit', (_event, limit?: number) => store.listToolAudit(limit))

  ipcMain.handle('rag:listSources', () => store.listRagSources())
  ipcMain.handle('rag:model', () => EMBED_MODEL)
  ipcMain.handle('rag:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder to index',
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.on('rag:index', async (event, request: { requestId: string; folder: string }) => {
    const controller = new AbortController()
    activeIndexes.set(request.requestId, controller)
    let reported = false

    try {
      await indexFolder(request.folder, request.requestId, {
        onProgress: (progress) => event.sender.send('rag:progress', progress),
        onDone: () => event.sender.send('rag:done', { requestId: request.requestId }),
        onError: (error) => {
          reported = true
          event.sender.send('rag:error', { requestId: request.requestId, error })
        }
      }, controller.signal)
    } catch (error) {
      if (!reported && !controller.signal.aborted) {
        event.sender.send('rag:error', { requestId: request.requestId, error: errorMessage(error) })
      }
    } finally {
      activeIndexes.delete(request.requestId)
    }
  })
  ipcMain.handle('rag:cancel', (_event, requestId: string) => {
    activeIndexes.get(requestId)?.abort()
    activeIndexes.delete(requestId)
  })
  ipcMain.handle('rag:removeSource', (_event, id: string) => store.deleteRagSource(id))
  ipcMain.handle('rag:retrieve', (_event, query: string, topK?: number): Promise<RagResult[]> =>
    retrieve(query, topK ?? 4)
  )
  ipcMain.handle('rag:getEnabled', () => store.getSetting('rag.enabled') !== 'false')
  ipcMain.handle('rag:setEnabled', (_event, enabled: boolean) => store.setSetting('rag.enabled', String(enabled)))

  ipcMain.handle('dev:listRepos', () => dev.listRepos())
  ipcMain.handle('dev:gitStatus', (_event, repoPath: string) => dev.gitStatus(repoPath))
  ipcMain.handle('dev:gitDiff', (_event, repoPath: string, statOnly?: boolean) => dev.gitDiff(repoPath, statOnly))
  ipcMain.on('dev:runTests', async (event, request: DevRunRequest) => {
    const controller = new AbortController()
    activeDevRuns.set(request.requestId, controller)
    const requestApproval = makeApprovalRequester(request.requestId, event.sender, 'dev:approval-request')

    try {
      const approved = await requestApproval({
        callId: `dev-${request.requestId}`,
        tool: 'tests.run',
        args: { repoPath: request.repoPath, command: request.command },
        risk: 'sensitive'
      })
      if (!approved) {
        event.sender.send('dev:error', { requestId: request.requestId, error: 'Denied by user' })
        return
      }

      const result = await dev.runAllowedCommand(request.repoPath, request.command, {
        onOutput: (chunk) => event.sender.send('dev:output', { requestId: request.requestId, chunk }),
        signal: controller.signal
      })
      event.sender.send('dev:done', {
        requestId: request.requestId,
        exitCode: result.exitCode,
        ok: result.exitCode === 0
      })
    } catch (error) {
      event.sender.send('dev:error', { requestId: request.requestId, error: errorMessage(error) })
    } finally {
      activeDevRuns.delete(request.requestId)
      clearApprovalsFor(request.requestId)
    }
  })
  ipcMain.handle('dev:cancel', (_event, requestId: string) => {
    activeDevRuns.get(requestId)?.abort()
    activeDevRuns.delete(requestId)
  })

  ipcMain.handle('connectors:list', () => connectors.listConnectors())
  ipcMain.handle('connectors:grant', (_event, appId: string, kind: ConnectorKind, scope = '') =>
    store.grantAppPermission(appId, kind, scope)
  )
  ipcMain.handle('connectors:revoke', (_event, appId: string, kind: ConnectorKind) =>
    store.revokeAppPermission(appId, kind)
  )
  ipcMain.handle('connectors:listWindows', () => connectors.listWindows())
  ipcMain.handle('connectors:operaBookmarks', () => connectors.readOperaBookmarks())
  ipcMain.handle('connectors:vscodeSettings', () => connectors.readVSCodeSettings())
  ipcMain.on('connectors:run', async (event, request: ConnectorRunRequest) => {
    const controller = new AbortController()
    activeConnectorRuns.set(request.requestId, controller)
    const requestApproval = makeApprovalRequester(request.requestId, event.sender, 'connector:approval-request')

    try {
      const approved = await requestApproval({
        callId: `connector-${request.requestId}`,
        tool: `${request.connectorId}.${request.action}`,
        args: request.args,
        risk: request.risk
      })
      if (!approved) {
        event.sender.send('connector:error', { requestId: request.requestId, error: 'Denied by user' })
        return
      }

      let result: unknown
      if (request.connectorId === 'app.control' && request.action === 'open') {
        result = connectors.controlApp(
          request.args.app as connectors.ControllableApp,
          request.args.target as string
        )
      } else if (request.connectorId === 'screen.read' && request.action === 'capture') {
        result = await connectors.readScreen(request.args.sourceId as string, request.requestId)
      } else {
        throw new Error(`Unknown connector action: ${request.connectorId}.${request.action}`)
      }
      event.sender.send('connector:done', { requestId: request.requestId, result: JSON.stringify(result, null, 2) })
    } catch (error) {
      event.sender.send('connector:error', { requestId: request.requestId, error: errorMessage(error) })
    } finally {
      activeConnectorRuns.delete(request.requestId)
      clearApprovalsFor(request.requestId)
    }
  })
  ipcMain.handle('connectors:cancel', (_event, requestId: string) => {
    activeConnectorRuns.get(requestId)?.abort()
    activeConnectorRuns.delete(requestId)
  })

  ipcMain.handle('images:ocrClipboard', () => images.ocrClipboard())
  ipcMain.handle('images:ocrFile', (_event, path: string) => images.ocrFile(path))

  ipcMain.handle('update:check', () => updates.checkForUpdate())
  ipcMain.handle('update:open', (_event, url: string) => updates.openUpdate(url))

  ipcMain.handle('sync:pull', () => store.buildBackupPayload(BUILD_VERSION))
  ipcMain.handle('sync:push', (_event, payload: unknown) => store.restoreBackup(payload))

  ipcMain.handle('bridge:config', () => bridgeConfig())
  ipcMain.handle('bridge:status', () => bridgeStatus())
  ipcMain.handle('bridge:setEnabled', (_event, enabled: boolean, bindLan?: boolean) =>
    setBridgeEnabled(enabled, bindLan))
  ipcMain.handle('bridge:setBindLan', (_event, bindLan: boolean) => setBridgeBindLan(bindLan))

  ipcMain.handle('system:shortcutStatus', () => polish.shortcutExists())
  ipcMain.handle('system:shortcutCreate', () => polish.createDesktopShortcut())
  ipcMain.handle('system:shortcutRemove', () => polish.removeDesktopShortcut())
  ipcMain.handle('system:hotkeyStatus', () => polish.hotkeyRegistered())
  ipcMain.handle('system:hotkey', () => polish.HOTKEY)
  ipcMain.handle('system:backup', () => polish.backupData())
  ipcMain.handle('system:restore', () => polish.restoreData())
  ipcMain.handle('system:exportMobileBundle', () => polish.exportMobileBundle())
  ipcMain.handle('system:getTheme', () => polish.getTheme())
  ipcMain.handle('system:setTheme', (_event, theme: 'dark' | 'light') => polish.setTheme(theme))

  ipcMain.handle('calendar:pick', () => calendar.pickIcs())
  ipcMain.handle('calendar:import', (_event, path: string) => calendar.importIcs(path))
  ipcMain.handle('calendar:list', () => store.listCalendarEvents())
  ipcMain.handle('calendar:delete', (_event, id: string) => store.deleteCalendarEvent(id))

  ipcMain.handle('voice:config', () => voice.getVoiceConfig())
  ipcMain.handle('voice:setConfig', (_event, config: VoiceConfig) => voice.setVoiceConfig(config))
  ipcMain.handle('voice:status', () => voice.status())
  ipcMain.handle('voice:speak', (_event, text: string) => voice.speak(text))
  ipcMain.handle('voice:stop', () => voice.stopSpeech())
  ipcMain.handle('voice:transcribe', (_event, samples: Float32Array, language?: string) =>
    voice.transcribe(samples, language))

  ipcMain.handle('avatar:getConfig', () => avatar.getAvatarConfig())
  ipcMain.handle('avatar:setConfig', (_event, config: AvatarConfig) => avatar.setAvatarConfig(config))
  ipcMain.handle('avatar:pickVrm', () => avatar.pickVrm())
  ipcMain.handle('avatar:readVrm', (_event, path: string) => avatar.readVrm(path))

  ipcMain.handle('window:openRP', () => openChatRP())
  ipcMain.handle('window:minimizeRP', () => rpWindow?.minimize())
  ipcMain.handle('window:closeRP', () => rpWindow?.close())
  ipcMain.handle('window:setAlwaysOnTop', (_event, enabled: boolean) => {
    rpWindow?.setAlwaysOnTop(enabled)
    return Boolean(rpWindow?.isAlwaysOnTop())
  })
}

app.whenReady().then(() => {
  // Voice capture is the only permission the app needs. Everything else stays
  // local; no other origin is loaded in the renderer.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  registerIpc()
  startBridge()
  createMainWindow()

  polish.setupTray({
    onShow: () => {
      const window = mainWindow()
      window?.show()
      window?.focus()
    },
    onOpenRP: () => openChatRP()
  })
  polish.registerHotkey(() => {
    const window = mainWindow()
    if (!window) {
      createMainWindow()
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  polish.startReminders()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('will-quit', () => {
  polish.unregisterHotkey()
  polish.stopReminders()
  stopBridge()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
