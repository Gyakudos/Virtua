/// <reference types="vite/client" />

import type {
  AgentHandlers,
  BackupPayload,
  BackupSummary,
  BridgeConfig,
  BridgeStatus,
  PairingQr,
  UpdateInfo,
  AgentRequest,
  AvatarConfig,
  CalendarEvent,
  CalendarImportResult,
  Character,
  BookmarkEntry,
  ChatRequest,
  CommandResult,
  ConnectorInfo,
  ConnectorKind,
  ConnectorRunHandlers,
  ConnectorRunRequest,
  Conversation,
  ConversationKind,
  DevRunHandlers,
  DevRunRequest,
  Note,
  OcrResult,
  OllamaHealth,
  PendingApproval,
  Persona,
  RagHandlers,
  ScreenSourceInfo,
  SpokenAudio,
  TranscriptionResult,
  RepoInfo,
  RagProgress,
  RagResult,
  RagSource,
  Reminder,
  StoredMessage,
  StreamHandlers,
  Task,
  ToolActivity,
  TrustedDevice,
  ToolAuditEntry,
  VoiceConfig,
  VoiceStatus,
  VrmFileInfo
} from '../../shared/types'

declare global {
  interface Window {
    api: {
      getVersion(): Promise<string>
      update: {
        check(): Promise<UpdateInfo>
        open(url: string): Promise<void>
      }
      sync: {
        pull(): Promise<BackupPayload>
        push(payload: BackupPayload): Promise<BackupSummary>
      }
      bridge: {
        config(): Promise<BridgeConfig>
        status(): Promise<BridgeStatus>
        setEnabled(enabled: boolean, bindLan?: boolean): Promise<BridgeStatus>
        setBindLan(bindLan: boolean): Promise<BridgeStatus>
        pairQr(): Promise<PairingQr>
        devices(): Promise<TrustedDevice[]>
        revokeDevice(id: string): Promise<BridgeStatus>
        allowDevice(id: string): Promise<BridgeStatus>
      }
      health(): Promise<OllamaHealth>
      chatOnce(request: ChatRequest): Promise<string>
      chatStream(request: ChatRequest, handlers: StreamHandlers): () => void
      cancel(requestId: string): Promise<void>
      agent: {
        run(request: AgentRequest, handlers: AgentHandlers): () => void
        cancel(requestId: string): Promise<void>
        approve(callId: string, approved: boolean): Promise<void>
      }
      connectors: {
        list(): Promise<ConnectorInfo[]>
        grant(appId: string, kind: ConnectorKind, scope?: string): Promise<void>
        revoke(appId: string, kind: ConnectorKind): Promise<void>
        operaBookmarks(): Promise<BookmarkEntry[]>
        vscodeSettings(): Promise<{ settings: Record<string, unknown>; extensions: string[] }>
        listWindows(): Promise<ScreenSourceInfo[]>
        run(request: ConnectorRunRequest, handlers: ConnectorRunHandlers): () => void
        cancel(requestId: string): Promise<void>
      }
      dev: {
        listRepos(): Promise<RepoInfo[]>
        gitStatus(repoPath: string): Promise<CommandResult>
        gitDiff(repoPath: string, statOnly?: boolean): Promise<CommandResult>
        runTests(request: DevRunRequest, handlers: DevRunHandlers): () => void
        cancel(requestId: string): Promise<void>
      }
      rag: {
        listSources(): Promise<RagSource[]>
        model(): Promise<string>
        pickFolder(): Promise<string | null>
        index(requestId: string, folder: string, handlers: RagHandlers): () => void
        cancel(requestId: string): Promise<void>
        removeSource(id: string): Promise<void>
        retrieve(query: string, topK?: number): Promise<RagResult[]>
        getEnabled(): Promise<boolean>
        setEnabled(enabled: boolean): Promise<void>
      }
      system: {
        shortcutStatus(): Promise<boolean>
        shortcutCreate(): Promise<string>
        shortcutRemove(): Promise<void>
        hotkeyStatus(): Promise<boolean>
        hotkey(): Promise<string>
        backup(): Promise<string>
        restore(): Promise<BackupSummary | null>
        exportMobileBundle(): Promise<{ path: string; avatars: number } | null>
        getTheme(): Promise<'dark' | 'light'>
        setTheme(theme: 'dark' | 'light'): Promise<void>
      }
      calendar: {
        pick(): Promise<string | null>
        import(path: string): Promise<CalendarImportResult>
        list(): Promise<CalendarEvent[]>
        delete(id: string): Promise<void>
      }
      voice: {
        config(): Promise<VoiceConfig>
        setConfig(config: VoiceConfig): Promise<void>
        status(): Promise<VoiceStatus>
        speak(text: string): Promise<SpokenAudio>
        stop(): Promise<void>
        transcribe(samples: Float32Array, language?: string): Promise<TranscriptionResult>
      }
      avatar: {
        getConfig(): Promise<AvatarConfig>
        setConfig(config: AvatarConfig): Promise<void>
        pickVrm(): Promise<VrmFileInfo | null>
        readVrm(path: string): Promise<VrmFileInfo>
      }
      store: {
        listConversations(kind?: ConversationKind, includeArchived?: boolean): Promise<Conversation[]>
        createConversation(
          kind: ConversationKind,
          title: string,
          personaId: string | null,
          characterId: string | null
        ): Promise<Conversation>
        renameConversation(id: string, title: string): Promise<void>
        archiveConversation(id: string, archived: boolean): Promise<void>
        deleteConversation(id: string): Promise<void>
        listMessages(conversationId: string): Promise<StoredMessage[]>
        addMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<StoredMessage>
        updateMessage(id: string, content: string): Promise<void>
        pinMessage(id: string, pinned: boolean): Promise<void>
        deleteMessage(id: string): Promise<void>
        exportConversation(id: string): Promise<string>
        listPersonas(): Promise<Persona[]>
        upsertPersona(persona: Persona): Promise<void>
        deletePersona(id: string): Promise<void>
        listCharacters(): Promise<Character[]>
        upsertCharacter(character: Character): Promise<void>
        deleteCharacter(id: string): Promise<void>
        searchNotes(query: string): Promise<Note[]>
        createNote(title: string, content: string, tags: string[]): Promise<Note>
        listTasks(status?: string): Promise<Task[]>
        createTask(title: string, dueAt: string | null, priority: string): Promise<Task>
        completeTask(idOrTitle: string): Promise<Task | null>
        listReminders(): Promise<Reminder[]>
        createReminder(title: string, fireAt: string | null): Promise<Reminder>
        listToolAudit(limit?: number): Promise<ToolAuditEntry[]>
      }
      images: {
        ocrClipboard(): Promise<OcrResult>
        ocrFile(path: string): Promise<OcrResult>
      }
      window: {
        openRP(): Promise<void>
        minimizeRP(): Promise<void>
        closeRP(): Promise<void>
        setAlwaysOnTop(enabled: boolean): Promise<boolean>
      }
    }
  }
}

export {}
