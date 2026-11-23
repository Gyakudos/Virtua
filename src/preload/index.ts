import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentHandlers,
  BackupPayload,
  BackupSummary,
  BridgeConfig,
  BridgeStatus,
  UpdateInfo,
  AgentRequest,
  AvatarConfig,
  CalendarEvent,
  CalendarImportResult,
  Character,
  ChatRequest,
  CommandResult,
  Conversation,
  ConnectorInfo,
  ConnectorKind,
  ConnectorRunHandlers,
  ConnectorRunRequest,
  ConversationKind,
  DevRunHandlers,
  DevRunRequest,
  Note,
  OcrResult,
  OllamaHealth,
  PendingApproval,
  Persona,
  ScreenSourceInfo,
  BookmarkEntry,
  RagHandlers,
  SpokenAudio,
  TranscriptionResult,
  RepoInfo,
  RagProgress,
  RagResult,
  RagSource,
  Reminder,
  StoredMessage,
  StreamChunkPayload,
  StreamDonePayload,
  StreamErrorPayload,
  StreamHandlers,
  Task,
  ToolActivity,
  ToolAuditEntry,
  VoiceConfig,
  VoiceStatus,
  VrmFileInfo
} from '../shared/types'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  update: {
    check: (): Promise<UpdateInfo> => ipcRenderer.invoke('update:check'),
    open: (url: string): Promise<void> => ipcRenderer.invoke('update:open', url)
  },

  sync: {
    pull: (): Promise<BackupPayload> => ipcRenderer.invoke('sync:pull'),
    push: (payload: BackupPayload): Promise<BackupSummary> => ipcRenderer.invoke('sync:push', payload)
  },

  bridge: {
    config: (): Promise<BridgeConfig> => ipcRenderer.invoke('bridge:config'),
    status: (): Promise<BridgeStatus> => ipcRenderer.invoke('bridge:status'),
    setEnabled: (enabled: boolean, bindLan?: boolean): Promise<BridgeStatus> =>
      ipcRenderer.invoke('bridge:setEnabled', enabled, bindLan),
    setBindLan: (bindLan: boolean): Promise<BridgeStatus> =>
      ipcRenderer.invoke('bridge:setBindLan', bindLan)
  },

  health: (): Promise<OllamaHealth> => ipcRenderer.invoke('ollama:health'),

  chatOnce: (request: ChatRequest): Promise<string> =>
    ipcRenderer.invoke('ollama:chatOnce', request),

  chatStream: (request: ChatRequest, handlers: StreamHandlers): (() => void) => {
    const onChunk = (_event: unknown, payload: StreamChunkPayload): void => {
      if (payload.requestId === request.requestId) handlers.onChunk(payload.chunk)
    }
    const onDone = (_event: unknown, payload: StreamDonePayload): void => {
      if (payload.requestId === request.requestId) handlers.onDone()
    }
    const onError = (_event: unknown, payload: StreamErrorPayload): void => {
      if (payload.requestId === request.requestId) handlers.onError(payload.error)
    }

    ipcRenderer.on('ollama:chunk', onChunk)
    ipcRenderer.on('ollama:done', onDone)
    ipcRenderer.on('ollama:error', onError)
    ipcRenderer.send('ollama:chatStream', request)

    return () => {
      ipcRenderer.removeListener('ollama:chunk', onChunk)
      ipcRenderer.removeListener('ollama:done', onDone)
      ipcRenderer.removeListener('ollama:error', onError)
    }
  },

  cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('ollama:cancel', requestId),

  agent: {
    run: (request: AgentRequest, handlers: AgentHandlers): (() => void) => {
      const onChunk = (_event: unknown, payload: { requestId: string; chunk: string }): void => {
        if (payload.requestId === request.requestId) handlers.onChunk(payload.chunk)
      }
      const onTool = (_event: unknown, payload: { requestId: string; activity: ToolActivity }): void => {
        if (payload.requestId === request.requestId) handlers.onTool(payload.activity)
      }
      const onApproval = (_event: unknown, payload: { requestId: string; approval: PendingApproval }): void => {
        if (payload.requestId === request.requestId) handlers.onApprovalRequest(payload.approval)
      }
      const onDone = (_event: unknown, payload: { requestId: string }): void => {
        if (payload.requestId === request.requestId) handlers.onDone()
      }
      const onError = (_event: unknown, payload: { requestId: string; error: string }): void => {
        if (payload.requestId === request.requestId) handlers.onError(payload.error)
      }

      ipcRenderer.on('agent:chunk', onChunk)
      ipcRenderer.on('agent:tool', onTool)
      ipcRenderer.on('agent:approval-request', onApproval)
      ipcRenderer.on('agent:done', onDone)
      ipcRenderer.on('agent:error', onError)
      ipcRenderer.send('agent:run', request)

      return () => {
        ipcRenderer.removeListener('agent:chunk', onChunk)
        ipcRenderer.removeListener('agent:tool', onTool)
        ipcRenderer.removeListener('agent:approval-request', onApproval)
        ipcRenderer.removeListener('agent:done', onDone)
        ipcRenderer.removeListener('agent:error', onError)
      }
    },
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('agent:cancel', requestId),
    approve: (callId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('agent:approval-response', callId, approved)
  },

  connectors: {
    list: (): Promise<ConnectorInfo[]> => ipcRenderer.invoke('connectors:list'),
    grant: (appId: string, kind: ConnectorKind, scope = ''): Promise<void> =>
      ipcRenderer.invoke('connectors:grant', appId, kind, scope),
    revoke: (appId: string, kind: ConnectorKind): Promise<void> =>
      ipcRenderer.invoke('connectors:revoke', appId, kind),
    operaBookmarks: (): Promise<BookmarkEntry[]> => ipcRenderer.invoke('connectors:operaBookmarks'),
    vscodeSettings: (): Promise<{ settings: Record<string, unknown>; extensions: string[] }> =>
      ipcRenderer.invoke('connectors:vscodeSettings'),
    listWindows: (): Promise<ScreenSourceInfo[]> => ipcRenderer.invoke('connectors:listWindows'),
    run: (request: ConnectorRunRequest, handlers: ConnectorRunHandlers): (() => void) => {
      const onApproval = (_event: unknown, payload: { requestId: string; approval: PendingApproval }): void => {
        if (payload.requestId === request.requestId) handlers.onApprovalRequest(payload.approval)
      }
      const onDone = (_event: unknown, payload: { requestId: string; result: string }): void => {
        if (payload.requestId === request.requestId) handlers.onDone(payload.result)
      }
      const onError = (_event: unknown, payload: { requestId: string; error: string }): void => {
        if (payload.requestId === request.requestId) handlers.onError(payload.error)
      }

      ipcRenderer.on('connector:approval-request', onApproval)
      ipcRenderer.on('connector:done', onDone)
      ipcRenderer.on('connector:error', onError)
      ipcRenderer.send('connectors:run', request)

      return () => {
        ipcRenderer.removeListener('connector:approval-request', onApproval)
        ipcRenderer.removeListener('connector:done', onDone)
        ipcRenderer.removeListener('connector:error', onError)
      }
    },
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('connectors:cancel', requestId)
  },

  dev: {
    listRepos: (): Promise<RepoInfo[]> => ipcRenderer.invoke('dev:listRepos'),
    gitStatus: (repoPath: string): Promise<CommandResult> => ipcRenderer.invoke('dev:gitStatus', repoPath),
    gitDiff: (repoPath: string, statOnly?: boolean): Promise<CommandResult> =>
      ipcRenderer.invoke('dev:gitDiff', repoPath, statOnly),
    runTests: (request: DevRunRequest, handlers: DevRunHandlers): (() => void) => {
      const onApproval = (_event: unknown, payload: { requestId: string; approval: PendingApproval }): void => {
        if (payload.requestId === request.requestId) handlers.onApprovalRequest(payload.approval)
      }
      const onOutput = (_event: unknown, payload: { requestId: string; chunk: string }): void => {
        if (payload.requestId === request.requestId) handlers.onOutput(payload.chunk)
      }
      const onDone = (_event: unknown, payload: {
        requestId: string; exitCode: number | null; ok: boolean
      }): void => {
        if (payload.requestId === request.requestId) {
          handlers.onDone({ exitCode: payload.exitCode, ok: payload.ok })
        }
      }
      const onError = (_event: unknown, payload: { requestId: string; error: string }): void => {
        if (payload.requestId === request.requestId) handlers.onError(payload.error)
      }

      ipcRenderer.on('dev:approval-request', onApproval)
      ipcRenderer.on('dev:output', onOutput)
      ipcRenderer.on('dev:done', onDone)
      ipcRenderer.on('dev:error', onError)
      ipcRenderer.send('dev:runTests', request)

      return () => {
        ipcRenderer.removeListener('dev:approval-request', onApproval)
        ipcRenderer.removeListener('dev:output', onOutput)
        ipcRenderer.removeListener('dev:done', onDone)
        ipcRenderer.removeListener('dev:error', onError)
      }
    },
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('dev:cancel', requestId)
  },

  rag: {
    listSources: (): Promise<RagSource[]> => ipcRenderer.invoke('rag:listSources'),
    model: (): Promise<string> => ipcRenderer.invoke('rag:model'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('rag:pickFolder'),
    index: (requestId: string, folder: string, handlers: RagHandlers): (() => void) => {
      const onProgress = (_event: unknown, progress: RagProgress): void => {
        if (progress.requestId === requestId) handlers.onProgress(progress)
      }
      const onDone = (_event: unknown, payload: { requestId: string }): void => {
        if (payload.requestId === requestId) handlers.onDone()
      }
      const onError = (_event: unknown, payload: { requestId: string; error: string }): void => {
        if (payload.requestId === requestId) handlers.onError(payload.error)
      }

      ipcRenderer.on('rag:progress', onProgress)
      ipcRenderer.on('rag:done', onDone)
      ipcRenderer.on('rag:error', onError)
      ipcRenderer.send('rag:index', { requestId, folder })

      return () => {
        ipcRenderer.removeListener('rag:progress', onProgress)
        ipcRenderer.removeListener('rag:done', onDone)
        ipcRenderer.removeListener('rag:error', onError)
      }
    },
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('rag:cancel', requestId),
    removeSource: (id: string): Promise<void> => ipcRenderer.invoke('rag:removeSource', id),
    retrieve: (query: string, topK?: number): Promise<RagResult[]> =>
      ipcRenderer.invoke('rag:retrieve', query, topK),
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke('rag:getEnabled'),
    setEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('rag:setEnabled', enabled)
  },

  system: {
    shortcutStatus: (): Promise<boolean> => ipcRenderer.invoke('system:shortcutStatus'),
    shortcutCreate: (): Promise<string> => ipcRenderer.invoke('system:shortcutCreate'),
    shortcutRemove: (): Promise<void> => ipcRenderer.invoke('system:shortcutRemove'),
    hotkeyStatus: (): Promise<boolean> => ipcRenderer.invoke('system:hotkeyStatus'),
    hotkey: (): Promise<string> => ipcRenderer.invoke('system:hotkey'),
    backup: (): Promise<string> => ipcRenderer.invoke('system:backup'),
    restore: (): Promise<BackupSummary | null> => ipcRenderer.invoke('system:restore'),
    exportMobileBundle: (): Promise<{ path: string; avatars: number } | null> =>
      ipcRenderer.invoke('system:exportMobileBundle'),
    getTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('system:getTheme'),
    setTheme: (theme: 'dark' | 'light'): Promise<void> => ipcRenderer.invoke('system:setTheme', theme)
  },

  calendar: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('calendar:pick'),
    import: (path: string): Promise<CalendarImportResult> => ipcRenderer.invoke('calendar:import', path),
    list: (): Promise<CalendarEvent[]> => ipcRenderer.invoke('calendar:list'),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('calendar:delete', id)
  },

  voice: {
    config: (): Promise<VoiceConfig> => ipcRenderer.invoke('voice:config'),
    setConfig: (config: VoiceConfig): Promise<void> => ipcRenderer.invoke('voice:setConfig', config),
    status: (): Promise<VoiceStatus> => ipcRenderer.invoke('voice:status'),
    speak: (text: string): Promise<SpokenAudio> => ipcRenderer.invoke('voice:speak', text),
    stop: (): Promise<void> => ipcRenderer.invoke('voice:stop'),
    transcribe: (samples: Float32Array, language?: string): Promise<TranscriptionResult> =>
      ipcRenderer.invoke('voice:transcribe', samples, language)
  },

  avatar: {
    getConfig: (): Promise<AvatarConfig> => ipcRenderer.invoke('avatar:getConfig'),
    setConfig: (config: AvatarConfig): Promise<void> => ipcRenderer.invoke('avatar:setConfig', config),
    pickVrm: (): Promise<VrmFileInfo | null> => ipcRenderer.invoke('avatar:pickVrm'),
    readVrm: (path: string): Promise<VrmFileInfo> => ipcRenderer.invoke('avatar:readVrm', path)
  },

  store: {
    listConversations: (kind?: ConversationKind, includeArchived?: boolean): Promise<Conversation[]> =>
      ipcRenderer.invoke('store:listConversations', kind, includeArchived),
    createConversation: (
      kind: ConversationKind,
      title: string,
      personaId: string | null,
      characterId: string | null
    ): Promise<Conversation> =>
      ipcRenderer.invoke('store:createConversation', kind, title, personaId, characterId),
    renameConversation: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('store:renameConversation', id, title),
    archiveConversation: (id: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke('store:archiveConversation', id, archived),
    deleteConversation: (id: string): Promise<void> =>
      ipcRenderer.invoke('store:deleteConversation', id),

    listMessages: (conversationId: string): Promise<StoredMessage[]> =>
      ipcRenderer.invoke('store:listMessages', conversationId),
    addMessage: (conversationId: string, role: 'user' | 'assistant', content: string): Promise<StoredMessage> =>
      ipcRenderer.invoke('store:addMessage', conversationId, role, content),
    updateMessage: (id: string, content: string): Promise<void> =>
      ipcRenderer.invoke('store:updateMessage', id, content),
    pinMessage: (id: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke('store:pinMessage', id, pinned),
    deleteMessage: (id: string): Promise<void> =>
      ipcRenderer.invoke('store:deleteMessage', id),
    exportConversation: (id: string): Promise<string> =>
      ipcRenderer.invoke('store:exportConversation', id),

    listPersonas: (): Promise<Persona[]> => ipcRenderer.invoke('store:listPersonas'),
    upsertPersona: (persona: Persona): Promise<void> => ipcRenderer.invoke('store:upsertPersona', persona),
    deletePersona: (id: string): Promise<void> => ipcRenderer.invoke('store:deletePersona', id),

    listCharacters: (): Promise<Character[]> => ipcRenderer.invoke('store:listCharacters'),
    upsertCharacter: (character: Character): Promise<void> => ipcRenderer.invoke('store:upsertCharacter', character),
    deleteCharacter: (id: string): Promise<void> => ipcRenderer.invoke('store:deleteCharacter', id),

    searchNotes: (query: string): Promise<Note[]> => ipcRenderer.invoke('store:searchNotes', query),
    createNote: (title: string, content: string, tags: string[]): Promise<Note> =>
      ipcRenderer.invoke('store:createNote', title, content, tags),
    listTasks: (status?: string): Promise<Task[]> => ipcRenderer.invoke('store:listTasks', status),
    createTask: (title: string, dueAt: string | null, priority: string): Promise<Task> =>
      ipcRenderer.invoke('store:createTask', title, dueAt, priority),
    completeTask: (idOrTitle: string): Promise<Task | null> =>
      ipcRenderer.invoke('store:completeTask', idOrTitle),
    listReminders: (): Promise<Reminder[]> => ipcRenderer.invoke('store:listReminders'),
    createReminder: (title: string, fireAt: string | null): Promise<Reminder> =>
      ipcRenderer.invoke('store:createReminder', title, fireAt),
    listToolAudit: (limit?: number): Promise<ToolAuditEntry[]> =>
      ipcRenderer.invoke('store:listToolAudit', limit)
  },

  images: {
    ocrClipboard: (): Promise<OcrResult> => ipcRenderer.invoke('images:ocrClipboard'),
    ocrFile: (path: string): Promise<OcrResult> => ipcRenderer.invoke('images:ocrFile', path)
  },

  window: {
    openRP: (): Promise<void> => ipcRenderer.invoke('window:openRP'),
    minimizeRP: (): Promise<void> => ipcRenderer.invoke('window:minimizeRP'),
    closeRP: (): Promise<void> => ipcRenderer.invoke('window:closeRP'),
    setAlwaysOnTop: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('window:setAlwaysOnTop', enabled)
  }
}

contextBridge.exposeInMainWorld('api', api)
