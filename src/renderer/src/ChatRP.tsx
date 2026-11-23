import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Avatar from './Avatar'
import { clipboardHasImage, insertPastedImage } from './imagePaste'
import type { AvatarConfig, AvatarState, Character, Conversation, OllamaHealth, StoredMessage, TraitMap } from '../../shared/types'

const TRAIT_KEYS = [
  'warmth', 'curiosity', 'humor', 'shyness', 'formality', 'energy', 'empathy', 'stubbornness', 'playfulness', 'patience'
]

function isChatModel(name: string): boolean {
  return !/embed|minilm|bge|gte[-_/]?e5|rerank|nomic/i.test(name.toLowerCase())
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function emptyCharacter(): Character {
  const now = Date.now()
  return {
    id: `char-${makeId()}`,
    name: 'New character',
    avatarPath: '',
    personaPrompt: '',
    backstory: '',
    greeting: 'Hello!',
    traits: { warmth: 50, curiosity: 60, humor: 40, shyness: 30 },
    rules: [],
    memory: '',
    createdAt: now,
    updatedAt: now
  }
}

function buildPrompt(character: Character, ooc: boolean): string {
  const traits = Object.entries(character.traits)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}: ${value}/100`)
    .join(', ')
  const rules = character.rules
    .filter((rule) => rule.enabled)
    .map((rule) => `- When ${rule.condition}: ${rule.action}`)
    .join('\n')

  return [
    `You are ${character.name}, roleplaying with the user.`,
    character.personaPrompt,
    character.backstory ? `Backstory: ${character.backstory}` : '',
    traits ? `Personality traits: ${traits}. Let these shape your tone, word choice, and behavior.` : '',
    rules ? `Behavior rules:\n${rules}` : '',
    character.memory ? `Shared memory: ${character.memory}` : '',
    'Stay in character unless the user explicitly says OOC. Use *asterisks* for actions and narration.',
    ooc ? 'The user is speaking OOC right now; respond out of character while keeping your personality.' : ''
  ].filter(Boolean).join('\n')
}

export default function ChatRP() {
  const [version, setVersion] = useState('')
  const [health, setHealth] = useState<OllamaHealth | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Character | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [input, setInput] = useState('')
  const [imageMessage, setImageMessage] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [ooc, setOoc] = useState(false)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [showAvatar, setShowAvatar] = useState(true)
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>({
    visible: true, quality: 'low', vrmPath: null, zoom: 1
  })
  const [avatarState, setAvatarState] = useState<AvatarState>('idle')
  const [error, setError] = useState<string | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const cancelledRef = useRef(false)
  const partialRef = useRef('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const importRef = useRef<HTMLInputElement | null>(null)
  const avatarErrorTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    const [appVersion, ollamaHealth, people, convs, savedAvatar] = await Promise.all([
      window.api.getVersion(),
      window.api.health(),
      window.api.store.listCharacters(),
      window.api.store.listConversations('rp'),
      window.api.avatar.getConfig()
    ])
    setVersion(appVersion)
    setHealth(ollamaHealth)
    setCharacters(people)
    setConversations(convs)
    setAvatarConfig(savedAvatar)
    if (ollamaHealth.status === 'online' && !selectedModel) {
      setSelectedModel(ollamaHealth.models.find((model) => isChatModel(model.name))?.name ?? '')
    }
  }, [selectedModel])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!streaming) setAvatarState(input.trim() ? 'listening' : 'idle')
  }, [input, streaming])

  useEffect(() => () => {
    if (avatarErrorTimerRef.current !== null) window.clearTimeout(avatarErrorTimerRef.current)
  }, [])

  const openCharacter = async (character: Character): Promise<void> => {
    setSelectedId(character.id)
    setDraft({ ...character })
    setError(null)
    const existing = conversations.find((conversation) => conversation.characterId === character.id)
    if (existing) {
      setActiveId(existing.id)
      setMessages(await window.api.store.listMessages(existing.id))
      return
    }
    const conversation = await window.api.store.createConversation('rp', `${character.name} · roleplay`, null, character.id)
    const greeting = await window.api.store.addMessage(conversation.id, 'assistant', character.greeting)
    setConversations((previous) => [conversation, ...previous])
    setActiveId(conversation.id)
    setMessages([greeting])
  }

  const generate = (conversationId: string, assistantId: string, history: StoredMessage[], character: Character): void => {
    const request = {
      requestId: makeId(),
      model: selectedModel,
      messages: [
        { role: 'system' as const, content: buildPrompt(character, ooc) },
        ...history.map((message) => ({ role: message.role, content: message.content }))
      ]
    }

    requestIdRef.current = request.requestId
    cancelledRef.current = false
    partialRef.current = ''
    setStreaming(true)
    setAvatarState('thinking')

    const finish = async (): Promise<void> => {
      const content = partialRef.current
      await window.api.store.updateMessage(assistantId, content)
      setMessages((previous) => previous.map((message) => (message.id === assistantId ? { ...message, content } : message)))
      setStreaming(false)
      setAvatarState('idle')
      requestIdRef.current = null
    }

    window.api.chatStream({ ...request, stream: true }, {
      onChunk: (chunk) => {
        if (partialRef.current === '') setAvatarState('speaking')
        partialRef.current += chunk
        const content = partialRef.current
        setMessages((previous) => previous.map((message) => (message.id === assistantId ? { ...message, content } : message)))
      },
      onDone: () => { void finish() },
      onError: (message) => {
        if (!cancelledRef.current) {
          setError(message)
          void finish().then(() => {
            setAvatarState('error')
            if (avatarErrorTimerRef.current !== null) window.clearTimeout(avatarErrorTimerRef.current)
            avatarErrorTimerRef.current = window.setTimeout(() => setAvatarState('idle'), 1600)
          })
        } else {
          void finish()
        }
      }
    })
  }

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!clipboardHasImage(event.clipboardData)) return
    event.preventDefault()
    setImageBusy(true)
    setImageMessage('Reading pasted image with local OCR…')
    void insertPastedImage(input)
      .then(({ text, message }) => {
        setInput(text)
        setImageMessage(message)
      })
      .catch((error) => setImageMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setImageBusy(false))
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || streaming || !draft || !activeId) return
    if (!selectedModel) {
      setError('No local model found. Seed a model into Ollama first.')
      return
    }

    setError(null)
    setInput('')
    const content = ooc ? `[OOC] ${text}` : text
    const userMessage = await window.api.store.addMessage(activeId, 'user', content)
    const assistantMessage = await window.api.store.addMessage(activeId, 'assistant', '')
    const history = [...messages, userMessage]
    setMessages((previous) => [...previous, userMessage, assistantMessage])
    generate(activeId, assistantMessage.id, history, draft)
  }

  const stop = (): void => {
    cancelledRef.current = true
    const requestId = requestIdRef.current
    if (requestId) void window.api.cancel(requestId)
  }

  const saveCharacter = async (): Promise<void> => {
    if (!draft) return
    await window.api.store.upsertCharacter(draft)
    await refresh()
    setShowEditor(false)
  }

  const exportCharacter = (): void => {
    if (!draft) return
    download(`${draft.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.json`, JSON.stringify(draft, null, 2), 'application/json')
  }

  const importCharacter = async (file: File): Promise<void> => {
    try {
      const parsed = JSON.parse(await file.text()) as Character
      if (!parsed.id || !parsed.name) throw new Error('Invalid character card')
      await window.api.store.upsertCharacter(parsed)
      await refresh()
      setShowEditor(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const updateTrait = (key: string, value: number): void => {
    if (!draft) return
    const traits: TraitMap = { ...draft.traits, [key]: value }
    setDraft({ ...draft, traits })
  }

  // The RP window reuses the same VRM renderer as the main assistant, but the
  // model path belongs to the selected character card, not the global config.
  const patchAvatar = (patch: Partial<AvatarConfig>): void => {
    if (patch.vrmPath !== undefined) {
      if (draft) {
        const updated = { ...draft, avatarPath: patch.vrmPath ?? '', updatedAt: Date.now() }
        setDraft(updated)
        setCharacters((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
        void window.api.store.upsertCharacter(updated)
      } else {
        // With no character selected, the RP window manages the shared avatar.
        const next = { ...avatarConfig, vrmPath: patch.vrmPath }
        setAvatarConfig(next)
        void window.api.avatar.setConfig(next)
      }
      return
    }
    const next = { ...avatarConfig, ...patch }
    setAvatarConfig(next)
    void window.api.avatar.setConfig(next)
  }

  const renderBody = (content: string): ReactNode => {
    if (content.startsWith('*') && content.endsWith('*') && content.length > 2) {
      return <em>{content.slice(1, -1)}</em>
    }
    return content
  }

  return (
    <div className="app rp-app">
      <header className="rp-head">
        <div className="rp-title">
          <span className="rp-avatar">{draft?.name?.[0] ?? 'C'}</span>
          <div>
            <strong>ChatRP</strong>
            <small>{draft ? `with ${draft.name}` : 'choose a character'} · build {version}</small>
          </div>
        </div>
        <div className="rp-window-controls">
          <button type="button" className="icon" title="Always on top" onClick={() => {
            void window.api.window.setAlwaysOnTop(!alwaysOnTop).then(setAlwaysOnTop)
          }}>{alwaysOnTop ? '📌' : '📍'}</button>
          <button type="button" className="icon" title="Minimize" onClick={() => void window.api.window.minimizeRP()}>─</button>
          <button type="button" className="icon" title="Close" onClick={() => void window.api.window.closeRP()}>×</button>
        </div>
      </header>

      <div className="rp-toolbar">
        <select value={selectedId ?? ''} onChange={(event) => {
          const character = characters.find((item) => item.id === event.target.value)
          if (character) void openCharacter(character)
        }}>
          <option value="">Select character…</option>
          {characters.map((character) => (
            <option key={character.id} value={character.id}>{character.name}</option>
          ))}
        </select>
        <button type="button" className="small" onClick={() => { setDraft(emptyCharacter()); setSelectedId(null); setShowEditor(true) }}>New</button>
        <button type="button" className="small" onClick={() => setShowEditor((value) => !value)}>Edit</button>
        <button type="button" className="small" title="Show the VRM in ChatRP (character model, or the main avatar before selecting one)" onClick={() => setShowAvatar((value) => !value)}>
          {showAvatar ? 'Hide avatar' : 'Show avatar'}
        </button>
        <span className="spacer" />
        <label className="checkbox">
          <input type="checkbox" checked={ooc} onChange={(event) => setOoc(event.target.checked)} />
          <span>OOC</span>
        </label>
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {showEditor && draft && (
        <div className="rp-editor">
          <div className="editor-head">
            <strong>Character / behavior editor</strong>
            <button type="button" className="icon" onClick={() => setShowEditor(false)}>×</button>
          </div>
          <label className="rp-field">Name
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="rp-field">Avatar path (.vrm / image)
            <input value={draft.avatarPath} onChange={(event) => setDraft({ ...draft, avatarPath: event.target.value })} placeholder="C:\\avatars\\character.vrm" />
          </label>
          <label className="rp-field">Persona prompt
            <textarea rows={3} value={draft.personaPrompt} onChange={(event) => setDraft({ ...draft, personaPrompt: event.target.value })} />
          </label>
          <label className="rp-field">Backstory
            <textarea rows={2} value={draft.backstory} onChange={(event) => setDraft({ ...draft, backstory: event.target.value })} />
          </label>
          <label className="rp-field">Greeting
            <input value={draft.greeting} onChange={(event) => setDraft({ ...draft, greeting: event.target.value })} />
          </label>

          <div className="rp-section-title">Personality traits</div>
          <div className="trait-grid">
            {TRAIT_KEYS.map((key) => (
              <label key={key} className="trait">
                <span>{key}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={draft.traits[key] ?? 50}
                  onChange={(event) => updateTrait(key, Number(event.target.value))}
                />
                <b>{draft.traits[key] ?? 50}</b>
              </label>
            ))}
          </div>

          <div className="rp-section-title">Behavior rules</div>
          {draft.rules.map((rule) => (
            <div key={rule.id} className="rule-row">
              <input
                value={rule.condition}
                placeholder="curiosity>=70"
                onChange={(event) => setDraft({
                  ...draft,
                  rules: draft.rules.map((item) => item.id === rule.id ? { ...item, condition: event.target.value } : item)
                })}
              />
              <input
                value={rule.action}
                placeholder="Ask a follow-up question"
                onChange={(event) => setDraft({
                  ...draft,
                  rules: draft.rules.map((item) => item.id === rule.id ? { ...item, action: event.target.value } : item)
                })}
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => setDraft({
                    ...draft,
                    rules: draft.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item)
                  })}
                />
                <span>on</span>
              </label>
              <button type="button" className="icon" onClick={() => setDraft({
                ...draft,
                rules: draft.rules.filter((item) => item.id !== rule.id)
              })}>×</button>
            </div>
          ))}
          <button type="button" className="small" onClick={() => setDraft({
            ...draft,
            rules: [...draft.rules, { id: makeId(), condition: '', action: '', enabled: true }]
          })}>+ Add rule</button>

          <label className="rp-field">Shared memory
            <textarea rows={3} value={draft.memory} onChange={(event) => setDraft({ ...draft, memory: event.target.value })} />
          </label>

          <div className="editor-actions">
            <button type="button" className="primary small" onClick={() => void saveCharacter()}>Save character</button>
            <button type="button" className="small" onClick={exportCharacter}>Export JSON</button>
            <button type="button" className="small" onClick={() => importRef.current?.click()}>Import JSON</button>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importCharacter(file)
              }}
            />
            {characters.some((item) => item.id === draft.id) && (
              <button type="button" className="small danger" onClick={() => {
                void window.api.store.deleteCharacter(draft.id).then(refresh)
                setDraft(null)
                setSelectedId(null)
                setShowEditor(false)
              }}>Delete</button>
            )}
          </div>
        </div>
      )}

      <div className="rp-body">
        <main className="rp-chat">
          {!draft && <div className="empty"><h2>Pick a character</h2><p>Or create one to start roleplaying.</p></div>}
          {draft && messages.length === 0 && <div className="empty"><p>No messages yet. Say hello.</p></div>}
          {messages.map((message) => (
            <div key={message.id} className={`message message--${message.role}`}>
              <div className="message-label">{message.role === 'user' ? (ooc ? 'You (OOC)' : 'You') : draft?.name ?? 'Character'}</div>
              <div className="message-body">{renderBody(message.content) || (streaming ? '…' : '')}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </main>

        {showAvatar && (
          <aside className="avatar-dock rp-avatar-dock">
            <Avatar
              state={avatarState}
              config={{ ...avatarConfig, visible: true, vrmPath: draft?.avatarPath || avatarConfig.vrmPath }}
              onPatch={patchAvatar}
            />
          </aside>
        )}
      </div>

      <footer className="composer rp-composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPaste={handleComposerPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={ooc ? 'Out of character · paste images to read locally…' : `Speak as ${draft?.name ?? 'your character'} · paste images to read locally…`}
          rows={2}
        />
        {imageMessage && <small className="hint image-paste-status">{imageBusy ? '◌ ' : '✓ '}{imageMessage}</small>}
        <div className="composer-actions">
          <span className="hint">*actions* for narration · Enter to send · paste images for local OCR</span>
          {streaming ? (
            <button type="button" className="primary stop" onClick={stop}>Stop</button>
          ) : (
            <button type="button" className="primary" onClick={() => void send()} disabled={!input.trim() || !draft}>Send</button>
          )}
        </div>
      </footer>
    </div>
  )
}
