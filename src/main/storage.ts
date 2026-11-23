import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import type {
  BackupPayload,
  BackupSummary,
  CalendarEvent,
  Character,
  Conversation,
  ConversationKind,
  Note,
  Persona,
  RagSource,
  Reminder,
  StoredMessage,
  Task,
  ToolAuditEntry
} from '../shared/types'

let database: DatabaseSync | null = null

function db(): DatabaseSync {
  if (database) return database

  const directory = join(app.getPath('userData'), 'data')
  mkdirSync(directory, { recursive: true })
  const instance = new DatabaseSync(join(directory, 'assistant.db'))
  instance.exec('PRAGMA foreign_keys = ON')
  instance.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      persona_id TEXT,
      character_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_path TEXT NOT NULL DEFAULT '',
      persona_prompt TEXT NOT NULL DEFAULT '',
      backstory TEXT NOT NULL DEFAULT '',
      greeting TEXT NOT NULL DEFAULT '',
      traits TEXT NOT NULL DEFAULT '{}',
      rules TEXT NOT NULL DEFAULT '[]',
      memory TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      due_at TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      fire_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      start_at TEXT,
      end_at TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_audit (
      id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      approved INTEGER NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_permissions (
      app_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, kind)
    );
    CREATE TABLE IF NOT EXISTS rag_sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      indexed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS rag_documents (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      path TEXT NOT NULL,
      hash TEXT NOT NULL,
      title TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_id, path),
      FOREIGN KEY (source_id) REFERENCES rag_sources(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      FOREIGN KEY (document_id) REFERENCES rag_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES rag_sources(id) ON DELETE CASCADE
    );
  `)

  database = instance
  seedDefaults(instance)
  return instance
}

function seedDefaults(instance: DatabaseSync): void {
  const personaCount = instance.prepare('SELECT COUNT(*) AS count FROM personas').get() as { count: number }
  if (personaCount.count === 0) {
    const now = Date.now()
    const personas: Array<[string, string, string]> = [
      ['general', 'General', 'You are a helpful, thoughtful local assistant. Be clear and concise.'],
      ['productivity', 'Productivity', 'You are a personal productivity assistant. Help with tasks, notes, reminders, and planning. Keep replies short and actionable.'],
      ['code', 'Code', 'You are a senior software engineer. Give precise, practical answers with code examples when useful. Prefer local files and tools over assumptions.'],
      ['study', 'Study', 'You are a patient tutor. Explain concepts step by step, use simple analogies, and check understanding.']
    ]
    const insert = instance.prepare(
      'INSERT INTO personas (id, name, system_prompt, builtin, created_at) VALUES (?, ?, ?, 1, ?)'
    )
    for (const [id, name, prompt] of personas) insert.run(id, name, prompt, now)
  }

  const characterCount = instance.prepare('SELECT COUNT(*) AS count FROM characters').get() as { count: number }
  if (characterCount.count === 0) {
    const now = Date.now()
    instance.prepare(`
      INSERT INTO characters
        (id, name, avatar_path, persona_prompt, backstory, greeting, traits, rules, memory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'aster',
      'Aster',
      '',
      'You are Aster, a curious and gentle companion. Speak warmly, with short sentences and a little playful humor. Stay in character unless the user says OOC.',
      'A quiet observer who collects stories from the people they meet.',
      'Oh — hello! I did not expect company. What brings you here?',
      JSON.stringify({ warmth: 75, curiosity: 80, humor: 55, shyness: 45, formality: 20, energy: 60 }),
      JSON.stringify([
        { id: 'r1', condition: 'curiosity>=70', action: 'End replies with one relevant follow-up question.', enabled: true },
        { id: 'r2', condition: 'shyness>=60', action: 'Use shorter sentences and avoid overly direct language.', enabled: true }
      ]),
      'No shared memories yet.',
      now,
      now
    )
  }
}

type ConversationRow = {
  id: string; kind: string; title: string; persona_id: string | null; character_id: string | null
  created_at: number; updated_at: number; archived: number
}

type MessageRow = {
  id: string; conversation_id: string; role: string; content: string; created_at: number; pinned: number
}

type PersonaRow = { id: string; name: string; system_prompt: string; builtin: number; created_at: number }

type CharacterRow = {
  id: string; name: string; avatar_path: string; persona_prompt: string; backstory: string
  greeting: string; traits: string; rules: string; memory: string; created_at: number; updated_at: number
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    kind: row.kind as ConversationKind,
    title: row.title,
    personaId: row.persona_id,
    characterId: row.character_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived)
  }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as StoredMessage['role'],
    content: row.content,
    createdAt: row.created_at,
    pinned: Boolean(row.pinned)
  }
}

function toPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    builtin: Boolean(row.builtin),
    createdAt: row.created_at
  }
}

function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    avatarPath: row.avatar_path,
    personaPrompt: row.persona_prompt,
    backstory: row.backstory,
    greeting: row.greeting,
    traits: JSON.parse(row.traits) as Character['traits'],
    rules: JSON.parse(row.rules) as Character['rules'],
    memory: row.memory,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listConversations(kind?: ConversationKind, includeArchived = false): Conversation[] {
  let sql = 'SELECT * FROM conversations'
  const clauses: string[] = []
  if (kind) clauses.push('kind = ?')
  if (!includeArchived) clauses.push('archived = 0')
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
  sql += ' ORDER BY updated_at DESC'
  const params = kind ? (includeArchived ? [kind] : [kind]) : []
  return (db().prepare(sql).all(...params) as ConversationRow[]).map(toConversation)
}

export function createConversation(kind: ConversationKind, title: string, personaId: string | null, characterId: string | null): Conversation {
  const now = Date.now()
  const id = `${now}-${Math.random().toString(16).slice(2)}`
  db().prepare(`
    INSERT INTO conversations (id, kind, title, persona_id, character_id, created_at, updated_at, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, kind, title, personaId, characterId, now, now)
  return { id, kind, title, personaId, characterId, createdAt: now, updatedAt: now, archived: false }
}

export function renameConversation(id: string, title: string): void {
  db().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id)
}

export function setConversationArchived(id: string, archived: boolean): void {
  db().prepare('UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, Date.now(), id)
}

export function deleteConversation(id: string): void {
  db().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

function touchConversation(id: string): void {
  db().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function listMessages(conversationId: string): StoredMessage[] {
  return (db().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as MessageRow[]).map(toMessage)
}

export function addMessage(conversationId: string, role: StoredMessage['role'], content: string): StoredMessage {
  const message: StoredMessage = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    conversationId,
    role,
    content,
    createdAt: Date.now(),
    pinned: false
  }
  db().prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, pinned)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(message.id, conversationId, role, content, message.createdAt)
  touchConversation(conversationId)
  return message
}

export function updateMessage(id: string, content: string): void {
  db().prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id)
}

export function setMessagePinned(id: string, pinned: boolean): void {
  db().prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
}

export function deleteMessage(id: string): void {
  db().prepare('DELETE FROM messages WHERE id = ?').run(id)
}

export function listPersonas(): Persona[] {
  return (db().prepare('SELECT * FROM personas ORDER BY builtin DESC, name ASC').all() as PersonaRow[]).map(toPersona)
}

export function upsertPersona(persona: Persona): void {
  db().prepare(`
    INSERT INTO personas (id, name, system_prompt, builtin, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, system_prompt = excluded.system_prompt
  `).run(persona.id, persona.name, persona.systemPrompt, persona.builtin ? 1 : 0, persona.createdAt)
}

export function deletePersona(id: string): void {
  db().prepare('DELETE FROM personas WHERE id = ? AND builtin = 0').run(id)
}

export function listCharacters(): Character[] {
  return (db().prepare('SELECT * FROM characters ORDER BY name ASC').all() as CharacterRow[]).map(toCharacter)
}

export function upsertCharacter(character: Character): void {
  db().prepare(`
    INSERT INTO characters
      (id, name, avatar_path, persona_prompt, backstory, greeting, traits, rules, memory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      avatar_path = excluded.avatar_path,
      persona_prompt = excluded.persona_prompt,
      backstory = excluded.backstory,
      greeting = excluded.greeting,
      traits = excluded.traits,
      rules = excluded.rules,
      memory = excluded.memory,
      updated_at = excluded.updated_at
  `).run(
    character.id,
    character.name,
    character.avatarPath,
    character.personaPrompt,
    character.backstory,
    character.greeting,
    JSON.stringify(character.traits),
    JSON.stringify(character.rules),
    character.memory,
    character.createdAt,
    Date.now()
  )
}

export function deleteCharacter(id: string): void {
  db().prepare('DELETE FROM characters WHERE id = ?').run(id)
}

export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function listSettings(): Array<{ key: string; value: string }> {
  return db().prepare('SELECT key, value FROM settings ORDER BY key').all() as unknown as Array<{ key: string; value: string }>
}

export function setSetting(key: string, value: string): void {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Build the portable snapshot consumed by desktop restore and the Android importer. */
export function buildBackupPayload(build: string): BackupPayload {
  return {
    app: 'virtual-assistant',
    build,
    exportedAt: new Date().toISOString(),
    format: 2,
    conversations: listConversations(undefined, true).map((conversation) => ({
      ...conversation,
      messages: listMessages(conversation.id)
    })),
    personas: listPersonas(),
    characters: listCharacters(),
    notes: searchNotes(''),
    tasks: listTasks('all'),
    reminders: listReminders(),
    calendarEvents: listCalendarEvents(),
    audit: listToolAudit(10000),
    ragSources: listRagSources().map((source) => ({ ...source, status: 'idle', chunkCount: 0, indexedAt: null, error: null })),
    appPermissions: listAppPermissions(),
    settings: listSettings()
  }
}

function payloadArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBool(value: unknown): boolean {
  return value === true || value === 1
}

function jsonField(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? (fallback === '{}' ? {} : []))
}

/**
 * Replace all local data with a validated backup snapshot. Runs in one transaction,
 * so a malformed bundle cannot leave a half-restored database.
 */
export function restoreBackup(input: unknown): BackupSummary {
  if (!input || typeof input !== 'object') throw new Error('Backup file is not a JSON object.')
  const payload = input as Partial<BackupPayload>
  if (payload.app && payload.app !== 'virtual-assistant') {
    throw new Error(`Unrecognized backup app: ${payload.app}`)
  }
  if (!Array.isArray(payload.conversations) || !Array.isArray(payload.characters)) {
    throw new Error('Backup file is missing conversations or characters.')
  }

  const conversations = payloadArray<Conversation & { messages?: StoredMessage[] }>(payload.conversations)
  const personas = payloadArray<Persona>(payload.personas)
  const characters = payloadArray<Character>(payload.characters)
  const notes = payloadArray<Note>(payload.notes)
  const tasks = payloadArray<Task>(payload.tasks)
  const reminders = payloadArray<Reminder>(payload.reminders)
  const calendarEvents = payloadArray<CalendarEvent>(payload.calendarEvents)
  const audit = payloadArray<ToolAuditEntry>(payload.audit)
  const ragSources = payloadArray<RagSource>(payload.ragSources)
  const appPermissions = payloadArray<BackupPayload['appPermissions'][number]>(payload.appPermissions)
  const settings = payloadArray<BackupPayload['settings'][number]>(payload.settings)
  const avatars = payloadArray<NonNullable<BackupPayload['avatars']>[number]>(payload.avatars)

  const instance = db()
  instance.exec('BEGIN')
  try {
    instance.exec(`
      DELETE FROM rag_chunks;
      DELETE FROM rag_documents;
      DELETE FROM rag_sources;
      DELETE FROM messages;
      DELETE FROM conversations;
      DELETE FROM personas;
      DELETE FROM characters;
      DELETE FROM notes;
      DELETE FROM tasks;
      DELETE FROM reminders;
      DELETE FROM calendar_events;
      DELETE FROM tool_audit;
      DELETE FROM app_permissions;
      DELETE FROM settings;
    `)

    const insertConversation = instance.prepare(`
      INSERT OR REPLACE INTO conversations
        (id, kind, title, persona_id, character_id, created_at, updated_at, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertMessage = instance.prepare(`
      INSERT OR REPLACE INTO messages (id, conversation_id, role, content, created_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    let messageCount = 0
    for (const conversation of conversations) {
      const id = asString(conversation.id, newId('conv'))
      insertConversation.run(
        id,
        conversation.kind === 'rp' ? 'rp' : 'assistant',
        asString(conversation.title, 'Untitled'),
        asNullableString(conversation.personaId),
        asNullableString(conversation.characterId),
        asNumber(conversation.createdAt, Date.now()),
        asNumber(conversation.updatedAt, Date.now()),
        asBool(conversation.archived) ? 1 : 0
      )
      for (const message of payloadArray<StoredMessage>(conversation.messages)) {
        insertMessage.run(
          asString(message.id, newId('msg')),
          id,
          message.role === 'assistant' ? 'assistant' : 'user',
          asString(message.content),
          asNumber(message.createdAt, Date.now()),
          asBool(message.pinned) ? 1 : 0
        )
        messageCount += 1
      }
    }

    const insertPersona = instance.prepare(`
      INSERT OR REPLACE INTO personas (id, name, system_prompt, builtin, created_at) VALUES (?, ?, ?, ?, ?)
    `)
    for (const persona of personas) {
      insertPersona.run(
        asString(persona.id, newId('persona')),
        asString(persona.name, 'Unnamed'),
        asString(persona.systemPrompt),
        asBool(persona.builtin) ? 1 : 0,
        asNumber(persona.createdAt, Date.now())
      )
    }

    const insertCharacter = instance.prepare(`
      INSERT OR REPLACE INTO characters
        (id, name, avatar_path, persona_prompt, backstory, greeting, traits, rules, memory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const character of characters) {
      const now = Date.now()
      insertCharacter.run(
        asString(character.id, newId('char')),
        asString(character.name, 'Unnamed'),
        asString(character.avatarPath),
        asString(character.personaPrompt),
        asString(character.backstory),
        asString(character.greeting),
        jsonField(character.traits, '{}'),
        jsonField(character.rules, '[]'),
        asString(character.memory),
        asNumber(character.createdAt, now),
        asNumber(character.updatedAt, now)
      )
    }

    const insertNote = instance.prepare(`
      INSERT OR REPLACE INTO notes (id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const note of notes) {
      insertNote.run(
        asString(note.id, newId('note')),
        asString(note.title),
        asString(note.content),
        JSON.stringify(payloadArray<string>(note.tags)),
        asNumber(note.createdAt, Date.now()),
        asNumber(note.updatedAt, Date.now())
      )
    }

    const insertTask = instance.prepare(`
      INSERT OR REPLACE INTO tasks (id, title, due_at, priority, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const task of tasks) {
      insertTask.run(
        asString(task.id, newId('task')),
        asString(task.title),
        asNullableString(task.dueAt),
        asString(task.priority, 'normal'),
        asString(task.status, 'open'),
        asNumber(task.createdAt, Date.now()),
        task.completedAt === null || task.completedAt === undefined ? null : asNumber(task.completedAt, Date.now())
      )
    }

    const insertReminder = instance.prepare(`
      INSERT OR REPLACE INTO reminders (id, title, fire_at, status, created_at) VALUES (?, ?, ?, ?, ?)
    `)
    for (const reminder of reminders) {
      insertReminder.run(
        asString(reminder.id, newId('rem')),
        asString(reminder.title),
        asNullableString(reminder.fireAt),
        asString(reminder.status, 'pending'),
        asNumber(reminder.createdAt, Date.now())
      )
    }

    const insertCalendar = instance.prepare(`
      INSERT OR REPLACE INTO calendar_events
        (id, uid, title, description, start_at, end_at, all_day, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const event of calendarEvents) {
      insertCalendar.run(
        asString(event.id, newId('cal')),
        asString(event.uid, newId('cal-uid')),
        asString(event.title),
        asString(event.description),
        asNullableString(event.startAt),
        asNullableString(event.endAt),
        asBool(event.allDay) ? 1 : 0,
        asString(event.source),
        asNumber(event.createdAt, Date.now())
      )
    }

    const insertAudit = instance.prepare(`
      INSERT OR REPLACE INTO tool_audit (id, tool, args, approved, result, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const entry of audit) {
      insertAudit.run(
        asString(entry.id, newId('audit')),
        asString(entry.tool),
        JSON.stringify(entry.args ?? {}),
        asBool(entry.approved) ? 1 : 0,
        asString(entry.result),
        asNumber(entry.createdAt, Date.now())
      )
    }

    // Chunks/embeddings are not carried in backups. Keep the source list, but mark it
    // for re-indexing instead of pretending the vectors are present.
    const insertRagSource = instance.prepare(`
      INSERT OR REPLACE INTO rag_sources
        (id, path, label, file_count, chunk_count, created_at, indexed_at, status, error)
      VALUES (?, ?, ?, ?, 0, ?, NULL, 'idle', NULL)
    `)
    for (const source of ragSources) {
      insertRagSource.run(
        asString(source.id, newId('src')),
        asString(source.path),
        asString(source.label),
        asNumber(source.fileCount),
        asNumber(source.createdAt, Date.now())
      )
    }

    const insertPermission = instance.prepare(`
      INSERT OR REPLACE INTO app_permissions (app_id, kind, scope, granted_at) VALUES (?, ?, ?, ?)
    `)
    for (const permission of appPermissions) {
      insertPermission.run(
        asString(permission.app_id),
        asString(permission.kind),
        asString(permission.scope),
        asNumber(permission.granted_at, Date.now())
      )
    }

    const insertSetting = instance.prepare(`
      INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
    `)
    for (const setting of settings) {
      insertSetting.run(asString(setting.key), asString(setting.value))
    }

    instance.exec('COMMIT')
    return {
      conversations: conversations.length,
      messages: messageCount,
      personas: personas.length,
      characters: characters.length,
      notes: notes.length,
      tasks: tasks.length,
      reminders: reminders.length,
      calendarEvents: calendarEvents.length,
      settings: settings.length,
      avatars: avatars.length
    }
  } catch (error) {
    instance.exec('ROLLBACK')
    throw error
  }
}

export function exportConversationMarkdown(id: string): string {
  const conversation = db().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
  if (!conversation) return ''
  const messages = listMessages(id)
  const lines = [`# ${conversation.title}`, '', ...messages.flatMap((message) => [
    `## ${message.role === 'user' ? 'You' : 'Assistant'}`,
    message.content,
    ''
  ])]
  return lines.join('\n')
}

type NoteRow = { id: string; title: string; content: string; tags: string; created_at: number; updated_at: number }
type TaskRow = {
  id: string; title: string; due_at: string | null; priority: string; status: string
  created_at: number; completed_at: number | null
}
type ReminderRow = { id: string; title: string; fire_at: string | null; status: string; created_at: number }
type AuditRow = { id: string; tool: string; args: string; approved: number; result: string; created_at: number }

type CalendarEventRow = {
  id: string; uid: string; title: string; description: string
  start_at: string | null; end_at: string | null; all_day: number; source: string; created_at: number
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createNote(title: string, content: string, tags: string[] = []): Note {
  const now = Date.now()
  const note: Note = { id: newId('note'), title, content, tags, createdAt: now, updatedAt: now }
  db().prepare(`
    INSERT INTO notes (id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(note.id, note.title, note.content, JSON.stringify(tags), now, now)
  return note
}

export function searchNotes(query: string): Note[] {
  const rows = db().prepare('SELECT * FROM notes ORDER BY updated_at DESC').all() as NoteRow[]
  const needle = query.trim().toLowerCase()
  return rows
    .map((row) => ({
      id: row.id, title: row.title, content: row.content, tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at, updatedAt: row.updated_at
    }))
    .filter((note) => !needle || `${note.title} ${note.content} ${note.tags.join(' ')}`.toLowerCase().includes(needle))
}

export function createTask(title: string, dueAt: string | null = null, priority = 'normal'): Task {
  const task: Task = {
    id: newId('task'), title, dueAt, priority, status: 'open', createdAt: Date.now(), completedAt: null
  }
  db().prepare(`
    INSERT INTO tasks (id, title, due_at, priority, status, created_at, completed_at) VALUES (?, ?, ?, ?, 'open', ?, NULL)
  `).run(task.id, task.title, task.dueAt, task.priority, task.createdAt)
  return task
}

export function listTasks(status = 'all'): Task[] {
  const sql = status === 'all' ? 'SELECT * FROM tasks ORDER BY created_at DESC' : 'SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC'
  const rows = (status === 'all' ? db().prepare(sql).all() : db().prepare(sql).all(status)) as TaskRow[]
  return rows.map((row) => ({
    id: row.id, title: row.title, dueAt: row.due_at, priority: row.priority, status: row.status,
    createdAt: row.created_at, completedAt: row.completed_at
  }))
}

export function completeTask(idOrTitle: string): Task | null {
  const row = db().prepare('SELECT * FROM tasks WHERE id = ? OR LOWER(title) = LOWER(?)').get(idOrTitle, idOrTitle) as TaskRow | undefined
  if (!row) return null
  const completedAt = Date.now()
  db().prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(completedAt, row.id)
  return {
    id: row.id, title: row.title, dueAt: row.due_at, priority: row.priority, status: 'done',
    createdAt: row.created_at, completedAt
  }
}

export function createReminder(title: string, fireAt: string | null = null): Reminder {
  const reminder: Reminder = { id: newId('rem'), title, fireAt, status: 'pending', createdAt: Date.now() }
  db().prepare('INSERT INTO reminders (id, title, fire_at, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(reminder.id, reminder.title, reminder.fireAt, reminder.status, reminder.createdAt)
  return reminder
}

export function listReminders(): Reminder[] {
  return (db().prepare('SELECT * FROM reminders ORDER BY created_at DESC').all() as ReminderRow[]).map((row) => ({
    id: row.id, title: row.title, fireAt: row.fire_at, status: row.status, createdAt: row.created_at
  }))
}

function toCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: Boolean(row.all_day),
    source: row.source,
    createdAt: row.created_at
  }
}

export function listCalendarEvents(): CalendarEvent[] {
  const rows = db().prepare('SELECT * FROM calendar_events ORDER BY start_at IS NULL, start_at, created_at DESC')
    .all() as CalendarEventRow[]
  return rows.map(toCalendarEvent)
}

/** Inserts events by UID; already-imported UIDs are skipped, so re-importing is safe. */
export function importCalendarEvents(events: CalendarEvent[]): { imported: number; skipped: number } {
  const insert = db().prepare(`
    INSERT OR IGNORE INTO calendar_events
      (id, uid, title, description, start_at, end_at, all_day, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let imported = 0
  let skipped = 0
  for (const event of events) {
    const result = insert.run(
      event.id, event.uid, event.title, event.description,
      event.startAt, event.endAt, event.allDay ? 1 : 0, event.source, event.createdAt
    )
    if (result.changes > 0) imported += 1
    else skipped += 1
  }
  return { imported, skipped }
}

export function deleteCalendarEvent(id: string): void {
  db().prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
}

export function logTool(tool: string, args: unknown, approved: boolean, result: string): ToolAuditEntry {
  const entry: ToolAuditEntry = {
    id: newId('audit'), tool, args, approved, result, createdAt: Date.now()
  }
  db().prepare('INSERT INTO tool_audit (id, tool, args, approved, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entry.id, entry.tool, JSON.stringify(args ?? {}), approved ? 1 : 0, result, entry.createdAt)
  return entry
}

export function listToolAudit(limit = 50): ToolAuditEntry[] {
  const rows = db().prepare('SELECT * FROM tool_audit ORDER BY created_at DESC LIMIT ?').all(limit) as AuditRow[]
  return rows.map((row) => ({
    id: row.id,
    tool: row.tool,
    args: JSON.parse(row.args) as unknown,
    approved: Boolean(row.approved),
    result: row.result,
    createdAt: row.created_at
  }))
}

type RagSourceRow = {
  id: string; path: string; label: string; file_count: number; chunk_count: number
  created_at: number; indexed_at: number | null; status: string; error: string | null
}
type RagDocumentRow = { id: string; source_id: string; path: string; hash: string; title: string; chunk_count: number }
export type RagChunkRecord = {
  id: string; source_id: string; path: string; title: string; chunk_index: number
  content: string; embedding: Uint8Array
}
export interface RagDocumentInput {
  path: string
  hash: string
  title: string
  chunks: Array<{ index: number; content: string; embedding: Buffer }>
}

function toRagSource(row: RagSourceRow): RagSource {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    fileCount: row.file_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
    status: row.status as RagSource['status'],
    error: row.error
  }
}

export interface AppPermissionRow {
  app_id: string
  kind: string
  scope: string
  granted_at: number
}

export function listAppPermissions(): AppPermissionRow[] {
  return db().prepare('SELECT * FROM app_permissions ORDER BY app_id, kind').all() as unknown as AppPermissionRow[]
}

export function hasAppPermission(appId: string, kind: string): boolean {
  const row = db().prepare('SELECT 1 FROM app_permissions WHERE app_id = ? AND kind = ?')
    .get(appId, kind) as { 1: number } | undefined
  return Boolean(row)
}

export function grantAppPermission(appId: string, kind: string, scope = ''): void {
  db().prepare(`
    INSERT INTO app_permissions (app_id, kind, scope, granted_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(app_id, kind) DO UPDATE SET scope = excluded.scope, granted_at = excluded.granted_at
  `).run(appId, kind, scope, Date.now())
}

export function revokeAppPermission(appId: string, kind: string): void {
  db().prepare('DELETE FROM app_permissions WHERE app_id = ? AND kind = ?').run(appId, kind)
}

export function listRagSources(): RagSource[] {
  return (db().prepare('SELECT * FROM rag_sources ORDER BY created_at DESC').all() as RagSourceRow[])
    .map(toRagSource)
}

export function upsertRagSource(path: string, label: string): RagSource {
  const instance = db()
  const existing = instance.prepare('SELECT * FROM rag_sources WHERE path = ?').get(path) as RagSourceRow | undefined
  if (existing) {
    instance.prepare('UPDATE rag_sources SET label = ?, status = ?, error = NULL WHERE id = ?')
      .run(label, 'indexing', existing.id)
    return toRagSource({ ...existing, label, status: 'indexing', error: null })
  }
  const source: RagSource = {
    id: newId('src'), path, label, fileCount: 0, chunkCount: 0,
    createdAt: Date.now(), indexedAt: null, status: 'indexing', error: null
  }
  instance.prepare(`
    INSERT INTO rag_sources (id, path, label, file_count, chunk_count, created_at, indexed_at, status, error)
    VALUES (?, ?, ?, 0, 0, ?, NULL, 'indexing', NULL)
  `).run(source.id, source.path, source.label, source.createdAt)
  return source
}

export function setRagSourceStatus(id: string, status: RagSource['status'], error: string | null = null): void {
  db().prepare("UPDATE rag_sources SET status = ?, error = ?, indexed_at = CASE WHEN ? = 'idle' THEN indexed_at ELSE ? END WHERE id = ?")
    .run(status, error, status, Date.now(), id)
}

export function deleteRagSource(id: string): void {
  db().prepare('DELETE FROM rag_sources WHERE id = ?').run(id)
}

export function refreshRagSourceCounts(id: string): void {
  db().prepare(`
    UPDATE rag_sources SET
      file_count = (SELECT COUNT(*) FROM rag_documents WHERE source_id = ?),
      chunk_count = (SELECT COALESCE(SUM(chunk_count), 0) FROM rag_documents WHERE source_id = ?)
    WHERE id = ?
  `).run(id, id, id)
}

export function listRagDocuments(sourceId: string): RagDocumentRow[] {
  return db().prepare('SELECT * FROM rag_documents WHERE source_id = ?').all(sourceId) as RagDocumentRow[]
}

export function deleteRagDocument(id: string): void {
  db().prepare('DELETE FROM rag_documents WHERE id = ?').run(id)
}

export function replaceRagDocument(sourceId: string, document: RagDocumentInput): void {
  const instance = db()
  instance.exec('BEGIN')
  try {
    instance.prepare('DELETE FROM rag_documents WHERE source_id = ? AND path = ?').run(sourceId, document.path)
    const documentId = newId('ragdoc')
    instance.prepare(`
      INSERT INTO rag_documents (id, source_id, path, hash, title, chunk_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(documentId, sourceId, document.path, document.hash, document.title, document.chunks.length, Date.now())

    const insert = instance.prepare(`
      INSERT INTO rag_chunks (id, document_id, source_id, path, title, chunk_index, content, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const chunk of document.chunks) {
      insert.run(newId('chunk'), documentId, sourceId, document.path, document.title, chunk.index, chunk.content, chunk.embedding)
    }
    instance.exec('COMMIT')
  } catch (error) {
    instance.exec('ROLLBACK')
    throw error
  }
}

export function listRagChunks(sourceIds?: string[]): RagChunkRecord[] {
  const instance = db()
  let rows: RagChunkRecord[]
  if (!sourceIds || sourceIds.length === 0) {
    rows = instance.prepare('SELECT * FROM rag_chunks').all() as RagChunkRecord[]
  } else {
    const placeholders = sourceIds.map(() => '?').join(',')
    rows = instance.prepare(`SELECT * FROM rag_chunks WHERE source_id IN (${placeholders})`)
      .all(...sourceIds) as RagChunkRecord[]
  }
  return rows.map((row) => ({ ...row, embedding: Buffer.from(row.embedding) }))
}

