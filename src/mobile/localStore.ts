import type {
  BackupPayload, Character, Conversation, ConversationKind, Note, Persona, Reminder,
  StoredMessage, Task, ToolAuditEntry
} from '../shared/types'

const KEY = 'virtua.local.v1'

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function defaults(): BackupPayload {
  const now = Date.now()
  return {
    app: 'virtual-assistant',
    build: 'mobile',
    exportedAt: new Date().toISOString(),
    format: 2,
    conversations: [],
    personas: [
      { id: 'general', name: 'General', systemPrompt: 'You are a helpful, thoughtful local assistant. Be clear and concise.', builtin: true, createdAt: now },
      { id: 'productivity', name: 'Productivity', systemPrompt: 'You are a personal productivity assistant. Help with tasks, notes, reminders, and planning. Keep replies short and actionable.', builtin: true, createdAt: now },
      { id: 'code', name: 'Code', systemPrompt: 'You are a senior software engineer. Give precise, practical answers with code examples when useful.', builtin: true, createdAt: now },
      { id: 'study', name: 'Study', systemPrompt: 'You are a patient tutor. Explain concepts step by step, use simple analogies, and check understanding.', builtin: true, createdAt: now }
    ],
    characters: [{
      id: 'aster',
      name: 'Aster',
      avatarPath: '',
      personaPrompt: 'You are Aster, a curious and gentle companion. Speak warmly, with short sentences and a little playful humor. Stay in character unless the user says OOC.',
      backstory: 'A quiet observer who collects stories from the people they meet.',
      greeting: 'Oh — hello! I did not expect company. What brings you here?',
      traits: { warmth: 75, curiosity: 80, humor: 55, shyness: 45, formality: 20, energy: 60 },
      rules: [],
      memory: 'No shared memories yet.',
      createdAt: now,
      updatedAt: now
    }],
    notes: [],
    tasks: [],
    reminders: [],
    calendarEvents: [],
    audit: [],
    ragSources: [],
    appPermissions: [],
    settings: [
      { key: 'ui.theme', value: 'dark' },
      { key: 'avatar.config', value: JSON.stringify({ visible: false, quality: 'low', vrmPath: null, zoom: 1 }) },
      { key: 'voice.config', value: JSON.stringify({ ttsEngine: 'sapi', sapiVoice: '', sapiRate: 0, piperExecutable: '', piperModel: '', piperConfig: '', sttLanguage: 'en' }) },
      { key: 'rag.enabled', value: 'false' }
    ]
  }
}

let cache: BackupPayload | null = null

export function data(): BackupPayload {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    cache = raw ? JSON.parse(raw) as BackupPayload : defaults()
  } catch {
    cache = defaults()
  }
  if (!cache.conversations) cache = defaults()
  save()
  return cache
}

export function save(): void {
  if (cache) localStorage.setItem(KEY, JSON.stringify(cache))
}

export function exportBundle(): BackupPayload {
  return JSON.parse(JSON.stringify(data())) as BackupPayload
}

export function importBundle(payload: BackupPayload): void {
  if (!payload || !Array.isArray(payload.conversations)) throw new Error('Invalid backup payload.')
  cache = JSON.parse(JSON.stringify(payload)) as BackupPayload
  save()
}

export function reset(): void {
  cache = defaults()
  save()
}

export function setting(key: string): string | null {
  return data().settings.find((item) => item.key === key)?.value ?? null
}

export function setSetting(key: string, value: string): void {
  const current = data()
  const existing = current.settings.find((item) => item.key === key)
  if (existing) existing.value = value
  else current.settings.push({ key, value })
  save()
}

export function listConversations(kind?: ConversationKind, includeArchived = false): Conversation[] {
  return data().conversations
    .filter((item) => (!kind || item.kind === kind) && (includeArchived || !item.archived))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createConversation(kind: ConversationKind, title: string, personaId: string | null, characterId: string | null): Conversation {
  const now = Date.now()
  const conversation: Conversation & { messages: StoredMessage[] } = {
    id: newId('conv'), kind, title, personaId, characterId, createdAt: now, updatedAt: now, archived: false, messages: []
  }
  data().conversations.push(conversation)
  save()
  return stripMessages(conversation)
}

export function renameConversation(id: string, title: string): void {
  const conversation = data().conversations.find((item) => item.id === id)
  if (conversation) { conversation.title = title; conversation.updatedAt = Date.now(); save() }
}

export function archiveConversation(id: string, archived: boolean): void {
  const conversation = data().conversations.find((item) => item.id === id)
  if (conversation) { conversation.archived = archived; conversation.updatedAt = Date.now(); save() }
}

export function deleteConversation(id: string): void {
  const current = data()
  current.conversations = current.conversations.filter((item) => item.id !== id)
  save()
}

function stripMessages(conversation: Conversation & { messages?: StoredMessage[] }): Conversation {
  const { messages: _messages, ...rest } = conversation
  return rest
}

export function listMessages(conversationId: string): StoredMessage[] {
  const conversation = data().conversations.find((item) => item.id === conversationId)
  return conversation?.messages?.slice().sort((a, b) => a.createdAt - b.createdAt) ?? []
}

export function addMessage(conversationId: string, role: 'user' | 'assistant', content: string): StoredMessage {
  const conversation = data().conversations.find((item) => item.id === conversationId)
  if (!conversation) throw new Error('Conversation not found.')
  const message: StoredMessage = { id: newId('msg'), conversationId, role, content, createdAt: Date.now(), pinned: false }
  conversation.messages = conversation.messages ?? []
  conversation.messages.push(message)
  conversation.updatedAt = Date.now()
  save()
  return message
}

export function updateMessage(id: string, content: string): void {
  for (const conversation of data().conversations) {
    const message = conversation.messages?.find((item) => item.id === id)
    if (message) { message.content = content; save(); return }
  }
}

export function pinMessage(id: string, pinned: boolean): void {
  for (const conversation of data().conversations) {
    const message = conversation.messages?.find((item) => item.id === id)
    if (message) { message.pinned = pinned; save(); return }
  }
}

export function deleteMessage(id: string): void {
  for (const conversation of data().conversations) {
    const before = conversation.messages?.length ?? 0
    conversation.messages = (conversation.messages ?? []).filter((item) => item.id !== id)
    if (conversation.messages.length !== before) { save(); return }
  }
}

export function listPersonas(): Persona[] {
  return data().personas.slice().sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))
}

export function upsertPersona(persona: Persona): void {
  const current = data()
  const index = current.personas.findIndex((item) => item.id === persona.id)
  if (index >= 0) current.personas[index] = persona
  else current.personas.push(persona)
  save()
}

export function deletePersona(id: string): void {
  const current = data()
  current.personas = current.personas.filter((item) => item.id !== id || item.builtin)
  save()
}

export function listCharacters(): Character[] {
  return data().characters.slice().sort((a, b) => a.name.localeCompare(b.name))
}

export function upsertCharacter(character: Character): void {
  const current = data()
  const index = current.characters.findIndex((item) => item.id === character.id)
  const next = { ...character, updatedAt: Date.now() }
  if (index >= 0) current.characters[index] = next
  else current.characters.push(next)
  save()
}

export function deleteCharacter(id: string): void {
  const current = data()
  current.characters = current.characters.filter((item) => item.id !== id)
  save()
}

export function searchNotes(query: string): Note[] {
  const needle = query.trim().toLowerCase()
  return data().notes
    .filter((note) => !needle || `${note.title} ${note.content} ${note.tags.join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createNote(title: string, content: string, tags: string[] = []): Note {
  const now = Date.now()
  const note: Note = { id: newId('note'), title, content, tags, createdAt: now, updatedAt: now }
  data().notes.push(note)
  save()
  return note
}

export function listTasks(status = 'all'): Task[] {
  return data().tasks
    .filter((item) => status === 'all' || item.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function createTask(title: string, dueAt: string | null, priority: string): Task {
  const task: Task = { id: newId('task'), title, dueAt, priority, status: 'open', createdAt: Date.now(), completedAt: null }
  data().tasks.push(task)
  save()
  return task
}

export function completeTask(idOrTitle: string): Task | null {
  const task = data().tasks.find((item) => item.id === idOrTitle || item.title.toLowerCase() === idOrTitle.toLowerCase())
  if (!task) return null
  task.status = 'done'
  task.completedAt = Date.now()
  save()
  return task
}

export function listReminders(): Reminder[] {
  return data().reminders.slice().sort((a, b) => b.createdAt - a.createdAt)
}

export function createReminder(title: string, fireAt: string | null): Reminder {
  const reminder: Reminder = { id: newId('rem'), title, fireAt, status: 'pending', createdAt: Date.now() }
  data().reminders.push(reminder)
  save()
  return reminder
}

export function listToolAudit(limit = 50): ToolAuditEntry[] {
  return data().audit.slice(-limit).reverse()
}

export function logAudit(tool: string, args: unknown, result: string): ToolAuditEntry {
  const entry: ToolAuditEntry = { id: newId('audit'), tool, args, approved: true, result, createdAt: Date.now() }
  data().audit.push(entry)
  save()
  return entry
}
