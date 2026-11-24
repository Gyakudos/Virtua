export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface OllamaModel {
  name: string
  size?: number
  modifiedAt?: string
}

export type OllamaHealth =
  | { status: 'online'; models: OllamaModel[]; url: string }
  | { status: 'offline'; url: string; error: string }
  | { status: 'checking'; url: string }

export interface ChatRequest {
  requestId: string
  model: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  stream: boolean
}

export interface StreamChunkPayload {
  requestId: string
  chunk: string
}

export interface StreamDonePayload {
  requestId: string
}

export interface StreamErrorPayload {
  requestId: string
  error: string
}

export interface StreamHandlers {
  onChunk: (chunk: string) => void
  onDone: () => void
  onError: (error: string) => void
}

export type ConversationKind = 'assistant' | 'rp'

export interface Conversation {
  id: string
  kind: ConversationKind
  title: string
  personaId: string | null
  characterId: string | null
  createdAt: number
  updatedAt: number
  archived: boolean
}

export interface StoredMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  pinned: boolean
}

export interface Persona {
  id: string
  name: string
  systemPrompt: string
  builtin: boolean
  createdAt: number
}

export type TraitMap = Record<string, number>

export interface CharacterRule {
  id: string
  condition: string
  action: string
  enabled: boolean
}

export interface Character {
  id: string
  name: string
  avatarPath: string
  personaPrompt: string
  backstory: string
  greeting: string
  traits: TraitMap
  rules: CharacterRule[]
  memory: string
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface Task {
  id: string
  title: string
  dueAt: string | null
  priority: string
  status: string
  createdAt: number
  completedAt: number | null
}

export interface Reminder {
  id: string
  title: string
  fireAt: string | null
  status: string
  createdAt: number
}

export interface ToolAuditEntry {
  id: string
  tool: string
  args: unknown
  approved: boolean
  result: string
  createdAt: number
}

export type ToolRisk = 'safe' | 'write' | 'sensitive'

export interface PendingApproval {
  callId: string
  tool: string
  args: unknown
  risk: ToolRisk
}

export interface ToolActivity {
  callId: string
  tool: string
  args: unknown
  status: 'calling' | 'done' | 'denied' | 'error'
  result?: string
}

export interface ToolCall {
  id: string
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
}

export interface AgentRequest {
  requestId: string
  model: string
  messages: AgentMessage[]
}

export interface AgentHandlers {
  onChunk: (chunk: string) => void
  onTool: (activity: ToolActivity) => void
  onApprovalRequest: (approval: PendingApproval) => void
  onDone: () => void
  onError: (error: string) => void
}

export interface RagSource {
  id: string
  path: string
  label: string
  fileCount: number
  chunkCount: number
  createdAt: number
  indexedAt: number | null
  status: 'idle' | 'indexing' | 'error'
  error: string | null
}

export interface RagResult {
  chunkId: string
  sourceId: string
  path: string
  title: string
  snippet: string
  score: number
}

export interface RagProgress {
  requestId: string
  phase: 'scanning' | 'embedding' | 'saving' | 'done' | 'error'
  current: number
  total: number
  message: string
}

export interface RagHandlers {
  onProgress: (progress: RagProgress) => void
  onDone: () => void
  onError: (error: string) => void
}

export interface RepoInfo {
  path: string
  label: string
  isGit: boolean
  fileCount: number
  chunkCount: number
}

export interface CommandResult {
  exitCode: number | null
  output: string
}

export interface DevRunRequest {
  requestId: string
  repoPath: string
  command: string
}

export interface DevRunHandlers {
  onApprovalRequest: (approval: PendingApproval) => void
  onOutput: (chunk: string) => void
  onDone: (result: { exitCode: number | null; ok: boolean }) => void
  onError: (error: string) => void
}

export type ConnectorKind = 'read' | 'control' | 'screen'

export interface ConnectorInfo {
  id: string
  name: string
  kind: ConnectorKind
  description: string
  detected: boolean
  granted: boolean
  path: string
}

export interface BookmarkEntry {
  name: string
  url: string
  folder: string
}

export interface ScreenSourceInfo {
  id: string
  name: string
}

export interface OcrResult {
  text: string
  imagePath: string
  width?: number
  height?: number
}

export interface ConnectorRunRequest {
  requestId: string
  connectorId: string
  action: string
  args: Record<string, unknown>
  risk: ToolRisk
}

export interface ConnectorRunHandlers {
  onApprovalRequest: (approval: PendingApproval) => void
  onDone: (result: string) => void
  onError: (error: string) => void
}

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'
export type AvatarQuality = 'low' | 'high'

export interface AvatarConfig {
  visible: boolean
  quality: AvatarQuality
  vrmPath: string | null
  /** Camera zoom for the VRM/2D preview: 0.6 (far) .. 2.5 (close). */
  zoom: number
}

export interface VrmFileInfo {
  name: string
  path: string
  data: Uint8Array
}

export interface RendererInfo {
  webgl: boolean
  renderer: string
  software: boolean
}

export interface CalendarEvent {
  id: string
  uid: string
  title: string
  description: string
  startAt: string | null
  endAt: string | null
  allDay: boolean
  source: string
  createdAt: number
}

export interface CalendarImportResult {
  source: string
  total: number
  imported: number
  skipped: number
  remindersCreated: number
}

export type TtsEngine = 'sapi' | 'piper'

export interface VoiceConfig {
  ttsEngine: TtsEngine
  sapiVoice: string
  sapiRate: number
  piperExecutable: string
  piperModel: string
  piperConfig: string
  sttLanguage: string
}

export interface VoiceStatus {
  sapi: boolean
  whisperModel: string
  whisperReady: boolean
  piperConfigured: boolean
  sampleRate: number
}

export interface SpokenAudio {
  audio: Uint8Array
  mimeType: string
  engine: TtsEngine
  characters: number
}

/** Versioned, portable snapshot used for backup/restore and Android migration. */
export interface BackupPayload {
  app: string
  build: string
  exportedAt: string
  format: number
  conversations: Array<Conversation & { messages: StoredMessage[] }>
  personas: Persona[]
  characters: Character[]
  notes: Note[]
  tasks: Task[]
  reminders: Reminder[]
  calendarEvents: CalendarEvent[]
  audit: ToolAuditEntry[]
  ragSources: RagSource[]
  appPermissions: Array<{ app_id: string; kind: string; scope: string; granted_at: number }>
  settings: Array<{ key: string; value: string }>
  /** Present in Android bundles: copied .vrm files referenced by avatar settings/characters. */
  avatars?: Array<{ sourcePath: string; fileName: string }>
  /** Base64 VRM bytes sent over the local bridge so a PC push also delivers avatars. */
  avatarFiles?: Array<{ fileName: string; dataBase64: string }>
  /** Ollama GGUF model metadata sent over the local bridge; bytes stream from the PC on demand. */
  modelFiles?: Array<{ name: string; fileName: string; digest: string; size: number }>
}

export interface BackupSummary {
  conversations: number
  messages: number
  personas: number
  characters: number
  notes: number
  tasks: number
  reminders: number
  calendarEvents: number
  settings: number
  avatars: number
  models?: number
  /** Non-fatal GGUF transfer failures, surfaced in the sync message. */
  modelErrors?: string[]
}

export interface BridgeConfig {
  enabled: boolean
  bindLan: boolean
  port: number
  host: string
  token: string
  urls: string[]
}

export interface TrustedDevice {
  id: string
  name: string
  platform: string
  pairedAt: number
  lastSeenAt: number
  revoked: boolean
  connected: boolean
}

export interface BridgeStatus extends BridgeConfig {
  running: boolean
  desktopConnected: boolean
  phoneConnected: boolean
  devices: TrustedDevice[]
}

export interface PairingQr {
  dataUrl: string
  payload: string
  url: string
}

export interface UpdateInfo {
  current: string
  latest: string
  tag: string
  name: string
  notes: string
  url: string
  publishedAt: string | null
  newer: boolean
}

export interface TranscriptionResult {
  text: string
  durationMs: number
  engine: string
}
