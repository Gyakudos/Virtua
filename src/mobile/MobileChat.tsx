import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AvatarConfig, AvatarState, Character, Conversation, OllamaHealth, Persona, StoredMessage, StreamHandlers
} from '../shared/types'
import type { NativeAvatar } from './localApi'
import type { MobileControls, MobileMode } from './mobile'
import MobileAvatarPanel from './MobileAvatarPanel'

type ChatKind = 'assistant' | 'rp'
type Sheet = 'chats' | 'model' | 'avatar' | null

interface Props {
  kind: ChatKind
  controls: MobileControls
  mode: MobileMode
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function isChatModel(name: string): boolean {
  return !/embed|minilm|bge|gte[-_/]?e5|rerank|nomic/i.test(name.toLowerCase())
}

function shortModel(name: string): string {
  return name.split('/').pop() ?? name
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function titleFor(text: string): string {
  return text.length > 38 ? `${text.slice(0, 38)}…` : text
}

const DEFAULT_AVATAR: AvatarConfig = {
  visible: true,
  quality: 'low',
  vrmPath: null,
  zoom: 1
}

function resizeComposer(element: HTMLTextAreaElement | null): void {
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 140)}px`
}

function buildCharacterPrompt(character: Character, ooc: boolean): string {
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
    traits ? `Personality traits: ${traits}. Let these shape your tone and word choice.` : '',
    rules ? `Behavior rules:\n${rules}` : '',
    character.memory ? `Shared memory: ${character.memory}` : '',
    'Stay in character unless the user explicitly says OOC. Use *asterisks* for actions and narration.',
    ooc ? 'The user is speaking OOC right now; respond out of character while keeping your personality.' : ''
  ].filter(Boolean).join('\n')
}

export default function MobileChat({ kind, controls, mode }: Props) {
  const modelKey = `virtua.mobile.model.${kind}`
  const [health, setHealth] = useState<OllamaHealth | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [model, setModel] = useState(() => localStorage.getItem(modelKey) ?? '')
  const [personas, setPersonas] = useState<Persona[]>([])
  const [personaId, setPersonaId] = useState('general')
  const [characters, setCharacters] = useState<Character[]>([])
  const [characterId, setCharacterId] = useState<string | null>(null)
  const [ooc, setOoc] = useState(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR)
  const [avatarState, setAvatarState] = useState<AvatarState>('idle')
  const [avatarFiles, setAvatarFiles] = useState<NativeAvatar[]>([])

  const modelRef = useRef(model)
  const partialRef = useRef('')
  const requestRef = useRef<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const cancelledRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { modelRef.current = model }, [model])

  useEffect(() => {
    let alive = true
    void Promise.all([
      window.api.avatar.getConfig().catch(() => DEFAULT_AVATAR),
      controls.avatarFiles().catch(() => [] as NativeAvatar[])
    ]).then(([config, files]) => {
      if (!alive) return
      setAvatarConfig({ ...config, visible: true })
      setAvatarFiles(files)
    })
    return () => { alive = false }
  }, [controls])

  const report = (error: unknown): void => {
    setNotice(error instanceof Error ? error.message : String(error))
    setAvatarState('error')
  }

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextConversations, nextPersonas, nextCharacters] = await Promise.all([
        window.api.health(),
        window.api.store.listConversations(kind),
        kind === 'assistant' ? window.api.store.listPersonas() : Promise.resolve([] as Persona[]),
        kind === 'rp' ? window.api.store.listCharacters() : Promise.resolve([] as Character[])
      ])

      setHealth(nextHealth)
      setConversations(nextConversations)
      if (kind === 'assistant') setPersonas(nextPersonas)
      else {
        setCharacters(nextCharacters)
        setCharacterId((current) => current && nextCharacters.some((item) => item.id === current)
          ? current
          : (nextCharacters[0]?.id ?? null))
      }

      const available = nextHealth.status === 'online' ? nextHealth.models : []
      const current = modelRef.current
      const next = current && available.some((item) => item.name === current)
        ? current
        : (available.find((item) => isChatModel(item.name))?.name ?? available[0]?.name ?? '')
      modelRef.current = next
      setModel(next)
      if (next && next !== current) localStorage.setItem(modelKey, next)

      setActiveId((currentId) => currentId && nextConversations.some((item) => item.id === currentId)
        ? currentId
        : (nextConversations[0]?.id ?? null))
    } catch (error) {
      report(error)
    }
  }, [kind, modelKey])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!activeId) {
      setMessages([])
      return
    }
    let alive = true
    void window.api.store.listMessages(activeId).then((list) => {
      if (alive) setMessages(list)
    }).catch(report)
    return () => { alive = false }
  }, [activeId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  useEffect(() => () => {
    unsubscribeRef.current?.()
  }, [])

  const activeConversation = conversations.find((item) => item.id === activeId) ?? null
  const activeCharacter = kind === 'rp'
    ? (characters.find((item) => item.id === (activeConversation?.characterId ?? characterId)) ?? null)
    : null
  const activePersona = kind === 'assistant'
    ? (personas.find((item) => item.id === personaId) ?? null)
    : null

  const chooseModel = (name: string): void => {
    modelRef.current = name
    setModel(name)
    localStorage.setItem(modelKey, name)
    setSheet(null)
    setNotice(null)
  }

  const refreshAvatarFiles = async (): Promise<void> => {
    try {
      setAvatarFiles(await controls.avatarFiles())
    } catch (error) {
      report(error)
    }
  }

  const patchAvatar = (patch: Partial<AvatarConfig>): void => {
    const next = { ...avatarConfig, ...patch, visible: true }
    setAvatarConfig(next)
    void window.api.avatar.setConfig(next).catch(report)
  }

  const openAvatar = (): void => {
    void refreshAvatarFiles()
    setSheet('avatar')
  }

  const importVrm = async (): Promise<void> => {
    try {
      const file = await window.api.avatar.pickVrm()
      if (file) {
        patchAvatar({ vrmPath: file.path })
        await refreshAvatarFiles()
        setNotice('VRM imported. It stays on this phone.')
      }
    } catch (error) {
      report(error)
    }
  }

  const importModel = async (): Promise<void> => {
    setBusy(true)
    try {
      await controls.pickModel()
      await refresh()
      setNotice('GGUF imported. Pick it from the model list.')
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }

  const selectConversation = (id: string): void => {
    setActiveId(id)
    setSheet(null)
    setNotice(null)
  }

  const openCharacter = async (character: Character): Promise<void> => {
    setCharacterId(character.id)
    const existing = conversations.find((item) => item.characterId === character.id)
    if (existing) {
      selectConversation(existing.id)
      return
    }
    try {
      const conversation = await window.api.store.createConversation(
        'rp', `${character.name} · roleplay`, null, character.id
      )
      const greeting = await window.api.store.addMessage(conversation.id, 'assistant', character.greeting)
      setConversations((previous) => [conversation, ...previous])
      setActiveId(conversation.id)
      setMessages([greeting])
      setSheet(null)
      setNotice(null)
    } catch (error) {
      report(error)
    }
  }

  const newChat = async (): Promise<void> => {
    try {
      if (kind === 'rp') {
        const character = characters.find((item) => item.id === characterId) ?? characters[0]
        if (!character) {
          setNotice('No character yet. Add one from Chats → Characters.')
          setSheet('chats')
          return
        }
        await openCharacter(character)
        return
      }

      const conversation = await window.api.store.createConversation('assistant', 'New chat', personaId, null)
      setConversations((previous) => [conversation, ...previous])
      setActiveId(conversation.id)
      setMessages([])
      setSheet(null)
      setNotice(null)
      textareaRef.current?.focus()
    } catch (error) {
      report(error)
    }
  }

  const deleteChat = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this chat from the phone?')) return
    try {
      await window.api.store.deleteConversation(id)
      if (activeId === id) setActiveId(null)
      await refresh()
    } catch (error) {
      report(error)
    }
  }

  const finish = async (assistantId: string, failed: boolean): Promise<void> => {
    const content = partialRef.current
    try {
      await window.api.store.updateMessage(assistantId, content)
    } catch {
      // The generated text is still shown even if persistence fails.
    }
    setMessages((previous) => previous.map((item) => item.id === assistantId ? { ...item, content } : item))
    setStreaming(false)
    requestRef.current = null
    unsubscribeRef.current = null
    setAvatarState(failed ? 'error' : 'idle')
    if (!failed) setNotice(null)
  }

  const generate = (conversationId: string, assistantId: string, history: StoredMessage[]): void => {
    const systemPrompt = kind === 'assistant'
      ? (activePersona?.systemPrompt ?? 'You are a helpful, thoughtful local assistant. Be clear and concise.')
      : (activeCharacter ? buildCharacterPrompt(activeCharacter, ooc) : 'You are a helpful local assistant.')

    const request = {
      requestId: makeId(),
      model,
      stream: true,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...history.map((item) => ({ role: item.role, content: item.content }))
      ]
    }

    requestRef.current = request.requestId
    partialRef.current = ''
    cancelledRef.current = false
    setStreaming(true)
    setNotice(null)
    setAvatarState('thinking')

    const handlers: StreamHandlers = {
      onChunk: (chunk) => {
        partialRef.current += chunk
        setAvatarState('speaking')
        const content = partialRef.current
        setMessages((previous) => previous.map((item) => item.id === assistantId ? { ...item, content } : item))
      },
      onDone: () => { void finish(assistantId, false) },
      onError: (message) => {
        if (!cancelledRef.current) setNotice(message)
        void finish(assistantId, !cancelledRef.current)
      }
    }

    unsubscribeRef.current = window.api.chatStream(request, handlers)
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || streaming || busy) return
    if (!model) {
      setNotice('Choose a model first, or import a GGUF in Setup.')
      setSheet('model')
      return
    }

    setBusy(true)
    setNotice(null)
    setAvatarState('listening')
    setInput('')
    resizeComposer(textareaRef.current)
    try {
      let conversationId = activeId
      if (!conversationId) {
        if (kind === 'rp') {
          const character = characters.find((item) => item.id === characterId) ?? characters[0]
          if (!character) throw new Error('No character selected.')
          const existing = conversations.find((item) => item.characterId === character.id)
          const conversation = existing ?? await window.api.store.createConversation(
            'rp', `${character.name} · roleplay`, null, character.id
          )
          if (!existing) {
            const greeting = await window.api.store.addMessage(conversation.id, 'assistant', character.greeting)
            setMessages([greeting])
          }
          setConversations((previous) => previous.some((item) => item.id === conversation.id)
            ? previous
            : [conversation, ...previous])
          conversationId = conversation.id
          setActiveId(conversation.id)
          setCharacterId(character.id)
        } else {
          const conversation = await window.api.store.createConversation('assistant', titleFor(text), personaId, null)
          setConversations((previous) => [conversation, ...previous])
          conversationId = conversation.id
          setActiveId(conversation.id)
        }
      }

      const content = kind === 'rp' && ooc ? `[OOC] ${text}` : text
      await window.api.store.addMessage(conversationId, 'user', content)
      const assistantMessage = await window.api.store.addMessage(conversationId, 'assistant', '')
      const history = await window.api.store.listMessages(conversationId)
      setMessages(history)
      generate(conversationId, assistantMessage.id, history)
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }

  const stop = (): void => {
    cancelledRef.current = true
    const requestId = requestRef.current
    unsubscribeRef.current?.()
    if (requestId) void window.api.cancel(requestId).catch(() => undefined)
    setStreaming(false)
    setAvatarState('idle')
    setNotice('Stopped.')
  }

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const modelCount = health?.status === 'online' ? health.models.length : 0
  const statusLabel = health?.status === 'online'
    ? `${modelCount} model${modelCount === 1 ? '' : 's'}`
    : health?.status === 'offline' ? 'No model' : 'Checking…'
  const speakerName = kind === 'rp'
    ? (activeCharacter?.name ?? 'Character')
    : (activePersona?.name ?? 'Virtua')

  return (
    <div className="chat-screen">
      <div className="chat-toolbar">
        <button type="button" className="chat-tool" onClick={() => setSheet('chats')}>
          Chats
        </button>
        <button type="button" className="chat-model" onClick={() => setSheet('model')}>
          <span className={health?.status === 'online' ? 'model-dot online' : 'model-dot'} />
          <span className="chat-model-name">{model ? shortModel(model) : 'Choose model'}</span>
          <small>{statusLabel}</small>
        </button>
        <button type="button" className="chat-tool accent" onClick={() => void newChat()}>
          New
        </button>
      </div>

      {notice && (
        <div className="chat-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <MobileAvatarPanel
        state={avatarState}
        config={avatarConfig}
        onPatch={patchAvatar}
        onOpen={openAvatar}
      />

      <div className="chat-scroll">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-mark">V</div>
            <strong>{kind === 'rp' ? 'Start a roleplay' : 'What’s on your mind?'}</strong>
            <p>
              {kind === 'rp'
                ? 'Pick a character from Chats, then say hello. Everything stays on this phone unless you link a desktop.'
                : 'Messages are stored locally. Choose a GGUF in Setup or link your desktop to use its models.'}
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const isUser = message.role === 'user'
            const pending = streaming && !isUser && message.id !== '' &&
              messages[messages.length - 1]?.id === message.id && !message.content
            return (
              <div key={message.id} className={`chat-message ${isUser ? 'from-user' : 'from-assistant'}`}>
                <div className="chat-avatar" aria-hidden="true">
                  {isUser ? 'You' : (kind === 'rp' ? (speakerName.slice(0, 2) || 'V') : 'V')}
                </div>
                <div className="chat-bubble">
                  <div className="chat-meta">
                    <strong>{isUser ? 'You' : speakerName}</strong>
                    <time>{timeLabel(message.createdAt)}</time>
                  </div>
                  <div className="chat-text">
                    {message.content || (pending ? <span className="chat-thinking"><i /><i /><i /></span> : null)}
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        {kind === 'rp' && (
          <button
            type="button"
            className={`composer-chip ${ooc ? 'active' : ''}`}
            onClick={() => setOoc((value) => !value)}
            title="Speak out of character"
          >
            OOC
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={input}
          placeholder={kind === 'rp' ? 'Write your next line…' : 'Message Virtua…'}
          onChange={(event) => {
            setInput(event.target.value)
            resizeComposer(event.target)
          }}
          onFocus={(event) => resizeComposer(event.currentTarget)}
          onKeyDown={onComposerKeyDown}
        />
        {streaming ? (
          <button type="button" className="composer-send stop" onClick={stop}>Stop</button>
        ) : (
          <button
            type="button"
            className="composer-send"
            disabled={!input.trim() || busy}
            onClick={() => void send()}
          >
            Send
          </button>
        )}
      </div>

      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <section
            className="sheet"
            onClick={(event) => event.stopPropagation()}
            aria-label={sheet === 'chats' ? 'Chats' : sheet === 'avatar' ? 'Avatar' : 'Models'}
          >
            <header className="sheet-head">
              <strong>{sheet === 'chats' ? 'Chats & people' : sheet === 'avatar' ? 'Avatar' : 'Model'}</strong>
              <button type="button" onClick={() => setSheet(null)}>Close</button>
            </header>
            <div className="sheet-body">
              {sheet === 'chats' && (
                <>
                  <button type="button" className="sheet-action primary" onClick={() => void newChat()}>
                    + New {kind === 'rp' ? 'roleplay' : 'chat'}
                  </button>

                  {kind === 'assistant' && personas.length > 0 && (
                    <div className="sheet-group">
                      <h4>Assistant style</h4>
                      {personas.map((persona) => (
                        <button
                          key={persona.id}
                          type="button"
                          className={`sheet-row ${persona.id === personaId ? 'selected' : ''}`}
                          onClick={() => { setPersonaId(persona.id); setSheet(null) }}
                        >
                          <span>{persona.name}</span>
                          <small>{persona.systemPrompt}</small>
                        </button>
                      ))}
                    </div>
                  )}

                  {kind === 'rp' && characters.length > 0 && (
                    <div className="sheet-group">
                      <h4>Characters</h4>
                      {characters.map((character) => (
                        <button
                          key={character.id}
                          type="button"
                          className="sheet-row"
                          onClick={() => void openCharacter(character)}
                        >
                          <span>{character.name}</span>
                          <small>{character.greeting}</small>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="sheet-group">
                    <h4>Conversations</h4>
                    {conversations.length === 0 ? (
                      <p className="sheet-hint">No chats yet. Start one above.</p>
                    ) : conversations.map((conversation) => (
                      <div key={conversation.id} className="sheet-chat-row">
                        <button type="button" className="sheet-row" onClick={() => selectConversation(conversation.id)}>
                          <span>{conversation.title}</span>
                          <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
                        </button>
                        <button
                          type="button"
                          className="sheet-delete"
                          onClick={() => void deleteChat(conversation.id)}
                          aria-label={`Delete ${conversation.title}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {sheet === 'avatar' && (
                <>
                  <div className="status-card">
                    <strong>{avatarConfig.vrmPath ? 'Local VRM selected' : '2D sprite active'}</strong>
                    <small>
                      {avatarConfig.vrmPath
                        ? 'The model renders on this phone. No cloud upload.'
                        : mode === 'linked'
                          ? 'Choose a VRM on the linked desktop.'
                          : 'Load a .vrm here or use PC Port → Sync to import one.'}
                    </small>
                  </div>

                  <div className="setup-actions">
                    <button type="button" className="sync-button primary" onClick={() => void importVrm()}>
                      {mode === 'local' ? 'Import .vrm from phone' : 'Choose .vrm on desktop'}
                    </button>
                    {avatarConfig.vrmPath && (
                      <button type="button" className="sync-button" onClick={() => patchAvatar({ vrmPath: null })}>
                        Use 2D sprite
                      </button>
                    )}
                  </div>

                  {mode === 'local' ? (
                    <div className="sheet-group">
                      <h4>Avatar files on this phone</h4>
                      {avatarFiles.length === 0 ? (
                        <p className="sheet-hint">No VRM imported yet. Imported files stay app-private and reload after restart.</p>
                      ) : avatarFiles.map((file) => {
                        const active = avatarConfig.vrmPath === file.path
                        return (
                          <button
                            key={file.path}
                            type="button"
                            className={`sheet-row ${active ? 'selected' : ''}`}
                            onClick={() => {
                              patchAvatar({ vrmPath: file.path })
                              setSheet(null)
                            }}
                          >
                            <span>{file.name}</span>
                            <small>{file.size ? `${(file.size / 1_000_000).toFixed(1)} MB` : 'local file'}</small>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="sheet-hint">
                      Linked mode renders the desktop’s currently selected VRM. Switch to Phone mode to use VRM files stored here.
                    </p>
                  )}

                  <div className="sheet-group">
                    <h4>Preview</h4>
                    <p className="sheet-hint">Pinch/scroll over the preview in chat to zoom. Quality changes apply immediately.</p>
                    <div className="segmented">
                      <button
                        type="button"
                        className={avatarConfig.quality === 'low' ? 'active' : ''}
                        onClick={() => patchAvatar({ quality: 'low' })}
                      >
                        Low · 30 FPS
                      </button>
                      <button
                        type="button"
                        className={avatarConfig.quality === 'high' ? 'active' : ''}
                        onClick={() => patchAvatar({ quality: 'high' })}
                      >
                        High · 60 FPS
                      </button>
                    </div>
                    <label className="avatar-zoom-label" htmlFor={`avatar-zoom-${kind}`}>
                      Zoom · {Math.round(avatarConfig.zoom * 100)}%
                    </label>
                    <input
                      id={`avatar-zoom-${kind}`}
                      type="range"
                      min={0.6}
                      max={2.5}
                      step={0.05}
                      value={avatarConfig.zoom}
                      onChange={(event) => patchAvatar({ zoom: Number(event.target.value) })}
                    />
                  </div>
                </>
              )}

              {sheet === 'model' && (
                <>
                  <div className="status-card">
                    <strong>{health?.status === 'online' ? 'Model ready' : 'No model available'}</strong>
                    <small>
                      {health?.status === 'offline'
                        ? health.error
                        : health?.status === 'online'
                          ? health.url === 'native' ? 'Running on this phone' : 'Linked to desktop'
                          : 'Checking model availability…'}
                    </small>
                  </div>

                  <button type="button" className="sheet-action" onClick={() => void refresh()}>
                    Refresh models
                  </button>

                  {health?.status === 'online' && health.models.length > 0 && (
                    <div className="sheet-group">
                      <h4>Available</h4>
                      {health.models.map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          className={`sheet-row ${item.name === model ? 'selected' : ''}`}
                          onClick={() => chooseModel(item.name)}
                        >
                          <span>{shortModel(item.name)}</span>
                          <small>
                            {item.name}
                            {item.size ? ` · ${(item.size / 1_000_000_000).toFixed(1)} GB` : ''}
                          </small>
                        </button>
                      ))}
                    </div>
                  )}

                  {mode === 'local' ? (
                    <button
                      type="button"
                      className="sheet-action primary"
                      disabled={busy}
                      onClick={() => void importModel()}
                    >
                      {busy ? 'Importing…' : 'Import GGUF from phone'}
                    </button>
                  ) : (
                    <p className="sheet-hint">Models come from the linked desktop. Open Setup to change the connection.</p>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
