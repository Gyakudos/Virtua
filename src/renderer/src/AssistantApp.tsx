import { useCallback, useEffect, useRef, useState } from 'react'
import Avatar from './Avatar'
import { clipboardHasImage, insertPastedImage } from './imagePaste'
import type {
  AvatarConfig,
  AvatarState,
  BridgeStatus,
  CalendarEvent,
  ConnectorInfo,
  Conversation,
  Note,
  OllamaHealth,
  PairingQr,
  PendingApproval,
  Persona,
  RagProgress,
  RepoInfo,
  RagResult,
  RagSource,
  Reminder,
  ScreenSourceInfo,
  SpokenAudio,
  StoredMessage,
  Task,
  ToolActivity,
  ToolAuditEntry,
  TrustedDevice,
  UpdateInfo,
  VoiceConfig,
  VoiceStatus
} from '../../shared/types'

interface RecordingSession {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  sink: GainNode
  chunks: Float32Array[]
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const length = Math.max(1, Math.round(input.length * toRate / fromRate))
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * fromRate / toRate
    const low = Math.floor(position)
    const high = Math.min(input.length - 1, low + 1)
    const fraction = position - low
    output[index] = input[low] * (1 - fraction) + input[high] * fraction
  }
  return output
}

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

export default function AssistantApp() {
  const [version, setVersion] = useState('loading…')
  const [health, setHealth] = useState<OllamaHealth | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [personaId, setPersonaId] = useState('general')
  const [selectedModel, setSelectedModel] = useState('')
  const [input, setInput] = useState('')
  const [imageMessage, setImageMessage] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [useStream, setUseStream] = useState(true)
  const [agentMode, setAgentMode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [personaEditor, setPersonaEditor] = useState<Persona | null>(null)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([])
  const [showData, setShowData] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [pairQr, setPairQr] = useState<PairingQr | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [dataTab, setDataTab] = useState<'tasks' | 'notes' | 'reminders' | 'calendar' | 'voice' | 'audit' | 'system'>('tasks')
  const [notes, setNotes] = useState<Note[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [audit, setAudit] = useState<ToolAuditEntry[]>([])
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskPriority, setTaskPriority] = useState('normal')
  const [reminderTitle, setReminderTitle] = useState('')
  const [reminderTime, setReminderTime] = useState('')
  const [showKnowledge, setShowKnowledge] = useState(false)
  const [ragSources, setRagSources] = useState<RagSource[]>([])
  const [ragModel, setRagModel] = useState('')
  const [ragEnabled, setRagEnabled] = useState(true)
  const [ragQuery, setRagQuery] = useState('')
  const [ragResults, setRagResults] = useState<RagResult[]>([])
  const [lastSources, setLastSources] = useState<RagResult[]>([])
  const [ragProgress, setRagProgress] = useState<RagProgress | null>(null)
  const [ragError, setRagError] = useState<string | null>(null)
  const [showDev, setShowDev] = useState(false)
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [selectedRepo, setSelectedRepo] = useState('')
  const [devCommand, setDevCommand] = useState('npm test')
  const [devOutput, setDevOutput] = useState('')
  const [devStatus, setDevStatus] = useState('')
  const [devRunning, setDevRunning] = useState(false)
  const [devApproval, setDevApproval] = useState<PendingApproval | null>(null)
  const [showConnections, setShowConnections] = useState(false)
  const [connectorsList, setConnectorsList] = useState<ConnectorInfo[]>([])
  const [connectorOutput, setConnectorOutput] = useState('')
  const [connectorBusy, setConnectorBusy] = useState(false)
  const [connectorApproval, setConnectorApproval] = useState<PendingApproval | null>(null)
  const [screenReading, setScreenReading] = useState(false)
  const [windows, setWindows] = useState<ScreenSourceInfo[]>([])
  const [selectedWindow, setSelectedWindow] = useState('')
  const [controlApp, setControlApp] = useState<'opera' | 'vscode' | 'notepad'>('opera')
  const [controlTarget, setControlTarget] = useState('')
  const [avatarConfig, setAvatarConfigState] = useState<AvatarConfig>({
    visible: false, quality: 'low', vrmPath: null, zoom: 1
  })
  const [avatarState, setAvatarState] = useState<AvatarState>('idle')
  const [shortcutPresent, setShortcutPresent] = useState(false)
  const [hotkeyBound, setHotkeyBound] = useState(false)
  const [hotkeyName, setHotkeyName] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [systemMessage, setSystemMessage] = useState('')
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [calendarMessage, setCalendarMessage] = useState('')
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>({
    ttsEngine: 'sapi', sapiVoice: '', sapiRate: 0,
    piperExecutable: '', piperModel: '', piperConfig: '', sttLanguage: 'en'
  })
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null)
  const [voiceText, setVoiceText] = useState('')
  const [voiceMessage, setVoiceMessage] = useState('')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [recording, setRecording] = useState(false)

  const requestIdRef = useRef<string | null>(null)
  const ragRequestRef = useRef<string | null>(null)
  const devRequestRef = useRef<string | null>(null)
  const connectorRequestRef = useRef<string | null>(null)
  const avatarErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)
  const partialRef = useRef('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const mouthLevelRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const mouthFrameRef = useRef<number | null>(null)
  const recordingRef = useRef<RecordingSession | null>(null)

  const loadConversations = useCallback(async () => {
    const list = await window.api.store.listConversations('assistant', showArchived)
    setConversations(list)
  }, [showArchived])

  const loadData = useCallback(async () => {
    const [loadedNotes, loadedTasks, loadedReminders, loadedAudit] = await Promise.all([
      window.api.store.searchNotes(''),
      window.api.store.listTasks('all'),
      window.api.store.listReminders(),
      window.api.store.listToolAudit(30)
    ])
    setNotes(loadedNotes)
    setTasks(loadedTasks)
    setReminders(loadedReminders)
    setAudit(loadedAudit)
  }, [])

  const loadKnowledge = useCallback(async () => {
    const [sources, enabled, model] = await Promise.all([
      window.api.rag.listSources(),
      window.api.rag.getEnabled(),
      window.api.rag.model()
    ])
    setRagSources(sources)
    setRagEnabled(enabled)
    setRagModel(model)
  }, [])

  const loadConnectors = useCallback(async () => {
    setConnectorsList(await window.api.connectors.list())
  }, [])

  const loadRepos = useCallback(async () => {
    const list = await window.api.dev.listRepos()
    setRepos(list)
    setSelectedRepo((current) => (current && list.some((repo) => repo.path === current) ? current : (list[0]?.path ?? '')))
  }, [])

  const loadCalendar = useCallback(async () => {
    setCalendarEvents(await window.api.calendar.list())
  }, [])

  const loadVoice = useCallback(async () => {
    const [config, status] = await Promise.all([
      window.api.voice.config(),
      window.api.voice.status()
    ])
    setVoiceConfig(config)
    setVoiceStatus(status)
  }, [])

  const loadSystem = useCallback(async () => {
    const [present, bound, hotkey, currentTheme, bridgeStatus] = await Promise.all([
      window.api.system.shortcutStatus(),
      window.api.system.hotkeyStatus(),
      window.api.system.hotkey(),
      window.api.system.getTheme(),
      window.api.bridge.status()
    ])
    setShortcutPresent(present)
    setHotkeyBound(bound)
    setHotkeyName(hotkey)
    setTheme(currentTheme)
    setBridge(bridgeStatus)
    setDevices(bridgeStatus.devices)
    document.body.classList.toggle('theme-light', currentTheme === 'light')
  }, [])

  const patchAvatar = (patch: Partial<AvatarConfig>): void => {
    setAvatarConfigState((previous) => {
      const next = { ...previous, ...patch }
      void window.api.avatar.setConfig(next)
      return next
    })
  }

  const refresh = useCallback(async () => {
    try {
      const [appVersion, ollamaHealth, people] = await Promise.all([
        window.api.getVersion(),
        window.api.health(),
        window.api.store.listPersonas()
      ])
      setVersion(appVersion)
      setHealth(ollamaHealth)
      setPersonas(people)
      if (ollamaHealth.status === 'online' && !selectedModel) {
        setSelectedModel(ollamaHealth.models.find((model) => isChatModel(model.name))?.name ?? '')
      }
      await loadConversations()
      await loadData()
      await loadKnowledge()
      await loadRepos()
      await loadConnectors()
      setAvatarConfigState(await window.api.avatar.getConfig())
      await loadSystem()
      await loadVoice()
      await loadCalendar()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [loadConversations, loadData, loadKnowledge, loadRepos, loadConnectors, loadSystem, loadVoice, loadCalendar, selectedModel])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, pendingApproval])

  useEffect(() => {
    if (showData) void loadData()
  }, [showData, toolActivity, loadData])

  useEffect(() => {
    if (showData && dataTab === 'system') void loadSystem()
    if (showData && dataTab === 'calendar') void loadCalendar()
    if (showData && dataTab === 'voice') void loadVoice()
  }, [showData, dataTab, loadSystem, loadCalendar, loadVoice])

  useEffect(() => {
    if (!streaming) {
      setAvatarState((current) => (current === 'error' ? current : (input.trim() ? 'listening' : 'idle')))
    }
  }, [input, streaming])

  useEffect(() => () => {
    if (avatarErrorTimerRef.current) clearTimeout(avatarErrorTimerRef.current)
    if (mouthFrameRef.current !== null) cancelAnimationFrame(mouthFrameRef.current)
    const session = recordingRef.current
    if (session) session.stream.getTracks().forEach((track) => track.stop())
    audioRef.current?.pause()
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
  }, [])

  const showAvatarError = (): void => {
    setAvatarState('error')
    if (avatarErrorTimerRef.current) clearTimeout(avatarErrorTimerRef.current)
    avatarErrorTimerRef.current = setTimeout(() => {
      avatarErrorTimerRef.current = null
      if (!streaming) setAvatarState(input.trim() ? 'listening' : 'idle')
    }, 2500)
  }

  const systemError = (cause: unknown): void => {
    setSystemMessage(cause instanceof Error ? cause.message : String(cause))
  }

  const createShortcut = async (): Promise<void> => {
    try {
      const path = await window.api.system.shortcutCreate()
      setShortcutPresent(true)
      setSystemMessage(`Desktop shortcut created: ${path}`)
    } catch (cause) { systemError(cause) }
  }

  const deleteShortcut = async (): Promise<void> => {
    try {
      await window.api.system.shortcutRemove()
      setShortcutPresent(false)
      setSystemMessage('Desktop shortcut removed.')
    } catch (cause) { systemError(cause) }
  }

  const toggleTheme = async (): Promise<void> => {
    try {
      const next = theme === 'dark' ? 'light' : 'dark'
      await window.api.system.setTheme(next)
      setTheme(next)
      document.body.classList.toggle('theme-light', next === 'light')
      setSystemMessage(`Theme set to ${next}.`)
    } catch (cause) { systemError(cause) }
  }

  const checkUpdate = async (): Promise<void> => {
    setUpdateBusy(true)
    try {
      const info = await window.api.update.check()
      setUpdateInfo(info)
      setSystemMessage(info.newer
        ? `Update available: ${info.latest}`
        : `You are up to date (${info.latest}).`)
    } catch (cause) {
      setSystemMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setUpdateBusy(false)
    }
  }

  const openUpdate = async (): Promise<void> => {
    if (!updateInfo) return
    try {
      await window.api.update.open(updateInfo.url)
    } catch (cause) { systemError(cause) }
  }

  const toggleBridge = async (): Promise<void> => {
    try {
      const next = await window.api.bridge.setEnabled(!bridge?.enabled)
      setBridge(next)
      setSystemMessage(next.enabled
        ? `Bridge enabled. Pairing token: ${next.token}`
        : 'Bridge disabled.')
    } catch (cause) { systemError(cause) }
  }

  const toggleBridgeLan = async (): Promise<void> => {
    try {
      if (!bridge) return
      const next = await window.api.bridge.setBindLan(!bridge.bindLan)
      setBridge(next)
      setSystemMessage(next.bindLan ? 'Bridge is listening on your local network.' : 'Bridge is loopback-only.')
    } catch (cause) { systemError(cause) }
  }

  const showPairingQr = async (): Promise<void> => {
    setSyncBusy(true)
    try {
      if (!bridge?.enabled || !bridge.bindLan) {
        const next = await window.api.bridge.setEnabled(true, true)
        setBridge(next)
        setDevices(next.devices)
      }
      setPairQr(await window.api.bridge.pairQr())
      setSystemMessage('Pairing QR ready. Scan it in the Android app’s Portable Sync tab.')
    } catch (cause) { systemError(cause) } finally {
      setSyncBusy(false)
    }
  }

  const setDeviceTrust = async (id: string, trusted: boolean): Promise<void> => {
    try {
      const next = trusted
        ? await window.api.bridge.allowDevice(id)
        : await window.api.bridge.revokeDevice(id)
      setBridge(next)
      setDevices(next.devices)
      setSystemMessage(trusted ? 'Device allowed again.' : 'Device revoked.')
    } catch (cause) { systemError(cause) }
  }

  const backup = async (): Promise<void> => {
    try {
      const path = await window.api.system.backup()
      setSystemMessage(path ? `Backup saved: ${path}` : 'Backup canceled.')
    } catch (cause) { systemError(cause) }
  }

  const restore = async (): Promise<void> => {
    if (!window.confirm('Replace all local chats, characters, notes, tasks, and settings with the selected backup? This cannot be undone.')) return
    try {
      const summary = await window.api.system.restore()
      if (!summary) {
        setSystemMessage('Restore canceled.')
        return
      }
      setActiveId(null)
      setMessages([])
      await refresh()
      setSystemMessage(
        `Restored ${summary.conversations} conversations (${summary.messages} messages), ` +
        `${summary.characters} characters, and ${summary.settings} settings.`
      )
    } catch (cause) { systemError(cause) }
  }

  const exportMobileBundle = async (): Promise<void> => {
    try {
      const bundle = await window.api.system.exportMobileBundle()
      if (!bundle) {
        setSystemMessage('Android export canceled.')
        return
      }
      setSystemMessage(`Android bundle saved to ${bundle.path} (${bundle.avatars} VRM avatar${bundle.avatars === 1 ? '' : 's'} copied).`)
    } catch (cause) { systemError(cause) }
  }

  const voiceError = (cause: unknown): void => {
    setVoiceMessage(cause instanceof Error ? cause.message : String(cause))
    showAvatarError()
  }

  const finishSpeech = (): void => {
    if (mouthFrameRef.current !== null) cancelAnimationFrame(mouthFrameRef.current)
    mouthFrameRef.current = null
    mouthLevelRef.current = 0
    analyserRef.current = null
    analyserDataRef.current = null
    audioRef.current = null
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = null
    setSpeaking(false)
    setAvatarState((current) => (current === 'speaking' ? 'idle' : current))
  }

  const playSpeech = async (spoken: SpokenAudio): Promise<void> => {
    finishSpeech()
    const url = URL.createObjectURL(new Blob([new Uint8Array(spoken.audio)], { type: spoken.mimeType }))
    audioUrlRef.current = url
    const audio = new Audio(url)
    audioRef.current = audio
    setSpeaking(true)
    setAvatarState('speaking')

    try {
      const context = audioContextRef.current ?? new AudioContext()
      audioContextRef.current = context
      await context.resume()
      const source = context.createMediaElementSource(audio)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyser.connect(context.destination)
      analyserRef.current = analyser
      analyserDataRef.current = new Uint8Array(analyser.fftSize)
    } catch {
      // Playback still works without analysis; the avatar just won't lip-sync.
      analyserRef.current = null
    }

    const trackMouth = (): void => {
      const analyser = analyserRef.current
      const data = analyserDataRef.current
      if (analyser && data) {
        analyser.getByteTimeDomainData(data)
        let squared = 0
        for (let index = 0; index < data.length; index += 1) {
          const value = (data[index] - 128) / 128
          squared += value * value
        }
        mouthLevelRef.current = Math.min(1, Math.sqrt(squared / data.length) * 7)
      }
      mouthFrameRef.current = requestAnimationFrame(trackMouth)
    }
    mouthFrameRef.current = requestAnimationFrame(trackMouth)

    audio.onended = finishSpeech
    audio.onerror = finishSpeech
    try {
      await audio.play()
    } catch (cause) {
      finishSpeech()
      throw cause
    }
  }

  const stopSpeaking = (): void => {
    void window.api.voice.stop()
    audioRef.current?.pause()
    finishSpeech()
  }

  const speakText = async (text: string): Promise<void> => {
    const clean = text.trim()
    if (!clean || voiceBusy) return
    setVoiceBusy(true)
    setVoiceMessage('')
    try {
      const spoken = await window.api.voice.speak(clean)
      await playSpeech(spoken)
      setVoiceMessage(`${spoken.engine} · ${spoken.characters} characters`)
    } catch (cause) {
      voiceError(cause)
    } finally {
      setVoiceBusy(false)
    }
  }

  const speakLast = async (): Promise<void> => {
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    await speakText(last?.content || input)
  }

  const startListening = async (): Promise<void> => {
    if (recording || voiceBusy) return
    setVoiceMessage('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true }
      })
      const context = audioContextRef.current ?? new AudioContext()
      audioContextRef.current = context
      await context.resume()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const sink = context.createGain()
      sink.gain.value = 0
      const chunks: Float32Array[] = []
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)
      recordingRef.current = { stream, source, processor, sink, chunks }
      setRecording(true)
      setAvatarState('listening')
    } catch (cause) {
      voiceError(cause)
    }
  }

  const stopListening = async (): Promise<void> => {
    const session = recordingRef.current
    if (!session) return
    recordingRef.current = null
    session.processor.onaudioprocess = null
    session.source.disconnect()
    session.processor.disconnect()
    session.sink.disconnect()
    session.stream.getTracks().forEach((track) => track.stop())
    setRecording(false)

    const total = session.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (total === 0) return
    const captured = new Float32Array(total)
    let offset = 0
    for (const chunk of session.chunks) {
      captured.set(chunk, offset)
      offset += chunk.length
    }
    const samples = resample(captured, audioContextRef.current?.sampleRate ?? 16000, 16000)
    setVoiceBusy(true)
    setAvatarState('thinking')
    try {
      const result = await window.api.voice.transcribe(samples, voiceConfig.sttLanguage || 'en')
      if (result.text) {
        setInput((current) => (current.trim() ? `${current.trim()} ${result.text}` : result.text))
        setVoiceMessage(`Heard: “${result.text}” · ${(result.durationMs / 1000).toFixed(1)}s local STT`)
      } else {
        setVoiceMessage('No speech detected. Try again closer to the microphone.')
      }
    } catch (cause) {
      voiceError(cause)
    } finally {
      setVoiceBusy(false)
      setAvatarState((current) => (current === 'thinking' ? 'idle' : current))
    }
  }

  const saveVoiceConfig = async (): Promise<void> => {
    try {
      await window.api.voice.setConfig(voiceConfig)
      setVoiceStatus(await window.api.voice.status())
      setVoiceMessage('Voice settings saved locally.')
    } catch (cause) {
      voiceError(cause)
    }
  }

  const importCalendar = async (): Promise<void> => {
    try {
      const path = await window.api.calendar.pick()
      if (!path) return
      const result = await window.api.calendar.import(path)
      setCalendarMessage(
        `${result.source}: ${result.imported} imported, ${result.skipped} already present, ` +
        `${result.remindersCreated} reminders created.`
      )
      await loadCalendar()
      await loadData()
    } catch (cause) {
      setCalendarMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const removeCalendarEvent = async (id: string): Promise<void> => {
    await window.api.calendar.delete(id)
    await loadCalendar()
  }

  const selectConversation = async (id: string): Promise<void> => {
    const [list, loaded] = await Promise.all([
      window.api.store.listMessages(id),
      window.api.store.listConversations('assistant', showArchived)
    ])
    const conversation = loaded.find((item) => item.id === id)
    setMessages(list)
    setActiveId(id)
    if (conversation?.personaId) setPersonaId(conversation.personaId)
  }

  const newChat = async (): Promise<void> => {
    const conversation = await window.api.store.createConversation('assistant', 'New chat', personaId, null)
    setConversations((previous) => [conversation, ...previous])
    setActiveId(conversation.id)
    setMessages([])
    setInput('')
  }

  const exportChat = async (): Promise<void> => {
    if (!activeId) return
    const markdown = await window.api.store.exportConversation(activeId)
    download(`chat-${activeId}.md`, markdown, 'text/markdown')
  }

  const generate = async (conversationId: string, assistantId: string, history: StoredMessage[]): Promise<void> => {
    const persona = personas.find((item) => item.id === personaId)
    let systemPrompt = persona?.systemPrompt ?? 'You are a helpful local assistant.'
    setLastSources([])

    if (ragEnabled) {
      const lastUser = [...history].reverse().find((message) => message.role === 'user')
      if (lastUser) {
        try {
          const results = await window.api.rag.retrieve(lastUser.content, 4)
          if (results.length > 0) {
            setLastSources(results)
            const context = results
              .map((result, index) => `[${index + 1}] ${result.title} (${result.path})\n${result.snippet}`)
              .join('\n\n')
            systemPrompt += `\n\nLocal knowledge retrieved from files you explicitly indexed. Use it when relevant and cite sources as [n]. If it does not answer the question, say so.\n\n${context}`
          }
        } catch {
          // Retrieval is optional; a failed search must not block chat.
        }
      }
    }

    const request = {
      requestId: makeId(),
      model: selectedModel,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...history.map((message) => ({ role: message.role, content: message.content }))
      ]
    }

    requestIdRef.current = request.requestId
    cancelledRef.current = false
    partialRef.current = ''
    setStreaming(true)
    setAvatarState('thinking')
    setPendingApproval(null)
    setToolActivity([])

    const onChunk = (chunk: string): void => {
      setAvatarState((current) => (current === 'thinking' ? 'speaking' : current))
      partialRef.current += chunk
      const content = partialRef.current
      setMessages((previous) => previous.map((message) => (message.id === assistantId ? { ...message, content } : message)))
    }

    const finish = async (failed = false): Promise<void> => {
      const content = partialRef.current
      await window.api.store.updateMessage(assistantId, content)
      setMessages((previous) => previous.map((message) => (message.id === assistantId ? { ...message, content } : message)))
      setStreaming(false)
      if (!failed) setAvatarState('idle')
      requestIdRef.current = null
    }

    if (agentMode) {
      window.api.agent.run(request, {
        onChunk,
        onTool: (activity) => setToolActivity((previous) => [...previous, activity]),
        onApprovalRequest: (approval) => setPendingApproval(approval),
        onDone: () => { void finish() },
        onError: (message) => {
          const failed = !cancelledRef.current
          if (failed) { setError(message); showAvatarError() }
          void finish(failed)
        }
      })
      return
    }

    if (useStream) {
      window.api.chatStream({ ...request, stream: true }, {
        onChunk,
        onDone: () => { void finish() },
        onError: (message) => {
          const failed = !cancelledRef.current
          if (failed) { setError(message); showAvatarError() }
          void finish(failed)
        }
      })
      return
    }

    void window.api.chatOnce({ ...request, stream: false }).then(
      (reply) => {
        partialRef.current = reply
        void finish()
      },
      (cause: unknown) => {
        const failed = !cancelledRef.current
        if (failed) { setError(cause instanceof Error ? cause.message : String(cause)); showAvatarError() }
        void finish(failed)
      }
    )
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
    if (!text || streaming) return

    if (text === '/new') { await newChat(); return }
    if (text === '/export') { await exportChat(); return }
    if (text === '/tasks' || text === '/notes') { setShowData(true); setDataTab(text === '/tasks' ? 'tasks' : 'notes'); return }
    if (text === '/knowledge') { setShowKnowledge(true); return }
    if (text === '/dev') { setShowDev(true); return }
    if (text === '/connections') { setShowConnections(true); return }
    if (text === '/avatar') { patchAvatar({ visible: true }); return }
    if (text === '/system') { setShowData(true); setDataTab('system'); return }
    if (text === '/calendar') { setShowData(true); setDataTab('calendar'); return }
    if (text === '/voice') { setShowData(true); setDataTab('voice'); return }

    if (!selectedModel) {
      setError('No local model found. Seed a model into Ollama first (see README).')
      return
    }

    setError(null)
    setInput('')

    let conversationId = activeId
    if (!conversationId) {
      const title = text.length > 42 ? `${text.slice(0, 42)}…` : text
      const conversation = await window.api.store.createConversation('assistant', title, personaId, null)
      setConversations((previous) => [conversation, ...previous])
      setActiveId(conversation.id)
      conversationId = conversation.id
    }

    const userMessage = await window.api.store.addMessage(conversationId, 'user', text)
    const assistantMessage = await window.api.store.addMessage(conversationId, 'assistant', '')
    const history = [...messages, userMessage]
    setMessages((previous) => [...previous, userMessage, assistantMessage])
    void generate(conversationId, assistantMessage.id, history)
  }

  const stop = (): void => {
    cancelledRef.current = true
    const requestId = requestIdRef.current
    if (requestId) {
      if (agentMode) void window.api.agent.cancel(requestId)
      else void window.api.cancel(requestId)
    }
  }

  const respondApproval = (approved: boolean): void => {
    const approval = pendingApproval
    setPendingApproval(null)
    if (approval) void window.api.agent.approve(approval.callId, approved)
  }

  const startIndex = (folder: string): void => {
    const requestId = makeId()
    ragRequestRef.current = requestId
    setRagError(null)
    setRagProgress({
      requestId, phase: 'scanning', current: 0, total: 0, message: 'Starting index…'
    })
    window.api.rag.index(requestId, folder, {
      onProgress: (progress) => setRagProgress(progress),
      onDone: () => {
        ragRequestRef.current = null
        setRagProgress(null)
        void loadKnowledge()
      },
      onError: (message) => {
        ragRequestRef.current = null
        setRagProgress(null)
        setRagError(message)
        void loadKnowledge()
      }
    })
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await window.api.rag.pickFolder()
    if (folder) startIndex(folder)
  }

  const searchKnowledge = async (): Promise<void> => {
    if (!ragQuery.trim()) return
    setRagError(null)
    try {
      setRagResults(await window.api.rag.retrieve(ragQuery, 8))
    } catch (cause) {
      setRagError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const inspectGit = async (mode: 'status' | 'diff'): Promise<void> => {
    if (!selectedRepo) return
    try {
      const result = mode === 'status'
        ? await window.api.dev.gitStatus(selectedRepo)
        : await window.api.dev.gitDiff(selectedRepo)
      setDevOutput(result.output || '(no changes)')
      setDevStatus(`${mode} · exit ${result.exitCode}`)
    } catch (cause) {
      setDevStatus(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const runDevTests = (): void => {
    if (!selectedRepo || !devCommand.trim() || devRunning) return
    const requestId = makeId()
    devRequestRef.current = requestId
    setDevRunning(true)
    setDevApproval(null)
    setDevOutput('')
    setDevStatus('Waiting for approval…')
    window.api.dev.runTests(
      { requestId, repoPath: selectedRepo, command: devCommand.trim() },
      {
        onApprovalRequest: (approval) => setDevApproval(approval),
        onOutput: (chunk) => setDevOutput((previous) => (previous + chunk).slice(-20000)),
        onDone: (result) => {
          devRequestRef.current = null
          setDevRunning(false)
          setDevApproval(null)
          setDevStatus(result.ok ? 'Passed' : `Exited with code ${result.exitCode}`)
        },
        onError: (message) => {
          devRequestRef.current = null
          setDevRunning(false)
          setDevApproval(null)
          setDevStatus(message)
        }
      }
    )
  }

  const respondDevApproval = (approved: boolean): void => {
    const approval = devApproval
    setDevApproval(null)
    setDevStatus(approved ? 'Running…' : 'Denied')
    if (approval) void window.api.agent.approve(approval.callId, approved)
  }

  const runConnector = (
    connectorId: string,
    action: string,
    args: Record<string, unknown>,
    risk: 'safe' | 'write' | 'sensitive',
    screen = false
  ): void => {
    const requestId = makeId()
    connectorRequestRef.current = requestId
    setConnectorBusy(true)
    setConnectorApproval(null)
    setConnectorOutput('')
    if (screen) setScreenReading(true)

    const finish = (): void => {
      connectorRequestRef.current = null
      setConnectorBusy(false)
      setConnectorApproval(null)
      setScreenReading(false)
    }

    window.api.connectors.run({ requestId, connectorId, action, args, risk }, {
      onApprovalRequest: (approval) => setConnectorApproval(approval),
      onDone: (result) => { finish(); setConnectorOutput(result) },
      onError: (message) => { finish(); setConnectorOutput(message) }
    })
  }

  const respondConnectorApproval = (approved: boolean): void => {
    const approval = connectorApproval
    setConnectorApproval(null)
    if (approval) void window.api.agent.approve(approval.callId, approved)
  }

  const changeGrant = async (appId: string, kind: 'read' | 'control' | 'screen', grant: boolean): Promise<void> => {
    if (grant) await window.api.connectors.grant(appId, kind)
    else await window.api.connectors.revoke(appId, kind)
    await loadConnectors()
  }

  const previewBookmarks = async (): Promise<void> => {
    try {
      setConnectorOutput(JSON.stringify(await window.api.connectors.operaBookmarks(), null, 2))
    } catch (cause) {
      setConnectorOutput(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const previewVSCode = async (): Promise<void> => {
    try {
      setConnectorOutput(JSON.stringify(await window.api.connectors.vscodeSettings(), null, 2))
    } catch (cause) {
      setConnectorOutput(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const refreshWindows = async (): Promise<void> => {
    try {
      const found = await window.api.connectors.listWindows()
      setWindows(found)
      setSelectedWindow((current) => (current && found.some((item) => item.id === current) ? current : (found[0]?.id ?? '')))
    } catch (cause) {
      setConnectorOutput(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const regenerate = async (): Promise<void> => {
    if (!activeId || streaming) return
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    if (!lastUser) return

    const trailing = messages.filter((message) => message.createdAt > lastUser.createdAt)
    for (const message of trailing) await window.api.store.deleteMessage(message.id)
    const history = messages.filter((message) => message.createdAt <= lastUser.createdAt)
    const assistantMessage = await window.api.store.addMessage(activeId, 'assistant', '')
    setMessages([...history, assistantMessage])
    void generate(activeId, assistantMessage.id, history)
  }

  const saveEdit = async (id: string): Promise<void> => {
    const content = editValue.trim()
    if (!content) return
    await window.api.store.updateMessage(id, content)
    setMessages((previous) => previous.map((message) => (message.id === id ? { ...message, content } : message)))
    setEditingId(null)
  }

  const togglePin = async (message: StoredMessage): Promise<void> => {
    await window.api.store.pinMessage(message.id, !message.pinned)
    setMessages((previous) => previous.map((item) => (item.id === message.id ? { ...item, pinned: !item.pinned } : item)))
  }

  const removeMessage = async (id: string): Promise<void> => {
    await window.api.store.deleteMessage(id)
    setMessages((previous) => previous.filter((message) => message.id !== id))
  }

  const savePersona = async (): Promise<void> => {
    if (!personaEditor) return
    await window.api.store.upsertPersona(personaEditor)
    setPersonas(await window.api.store.listPersonas())
    setPersonaEditor(null)
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        void newChat()
      }
      if (event.key === 'Escape' && streaming) stop()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [newChat, streaming])

  const filtered = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(search.toLowerCase())
  )
  const chatModels = health?.status === 'online'
    ? health.models.filter((model) => isChatModel(model.name))
    : []

  return (
    <div className="app shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <h1>Virtual Assistant</h1>
              <p>Phase 8 · local voice & calendar</p>
            </div>
          </div>
          <div className="sidebar-actions">
            <button type="button" className="small primary" onClick={() => void newChat()}>New chat</button>
            <button type="button" className="small" onClick={() => void window.api.window.openRP()}>ChatRP</button>
          </div>
        </div>

        <input
          className="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search conversations…"
        />

        <div className="conversation-list">
          {filtered.length === 0 && <p className="muted">No conversations yet.</p>}
          {filtered.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation ${conversation.id === activeId ? 'conversation--active' : ''}`}
              onClick={() => void selectConversation(conversation.id)}
            >
              <span className="conversation-title">{conversation.title}</span>
              <button
                type="button"
                className="icon"
                title="Archive"
                onClick={(event) => {
                  event.stopPropagation()
                  void window.api.store.archiveConversation(conversation.id, true).then(loadConversations)
                }}
              >×</button>
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <label className="checkbox">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            <span>Show archived</span>
          </label>
          <span className="build">build {version}</span>
        </div>
      </aside>

      <section className="workspace">
        <div className="toolbar">
          <label className="field">
            <span>Persona</span>
            <select value={personaId} onChange={(event) => setPersonaId(event.target.value)}>
              {personas.map((persona) => (
                <option key={persona.id} value={persona.id}>{persona.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="small" onClick={() => {
            const persona = personas.find((item) => item.id === personaId)
            setPersonaEditor(persona
              ? { ...persona }
              : { id: `custom-${makeId()}`, name: 'New persona', systemPrompt: '', builtin: false, createdAt: Date.now() })
          }}>Edit persona</button>
          <label className="field">
            <span>Model</span>
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              disabled={health?.status !== 'online' || chatModels.length === 0}
            >
              {chatModels.length > 0 ? (
                chatModels.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)
              ) : <option value="">No local chat models</option>}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={agentMode} onChange={(event) => setAgentMode(event.target.checked)} />
            <span>Agent mode</span>
          </label>
          {!agentMode && (
            <label className="checkbox">
              <input type="checkbox" checked={useStream} onChange={(event) => setUseStream(event.target.checked)} />
              <span>Streaming</span>
            </label>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ragEnabled}
              onChange={(event) => {
                const enabled = event.target.checked
                setRagEnabled(enabled)
                void window.api.rag.setEnabled(enabled)
              }}
            />
            <span>Use knowledge</span>
          </label>
          <span className="spacer" />
          <button type="button" className="small" onClick={() => patchAvatar({ visible: !avatarConfig.visible })}>Avatar</button>
          <button type="button" className="small" onClick={() => setShowConnections((value) => !value)}>Connections</button>
          <button type="button" className="small" onClick={() => setShowDev((value) => !value)}>Dev</button>
          <button type="button" className="small" onClick={() => setShowKnowledge((value) => !value)}>Knowledge</button>
          <button type="button" className="small" onClick={() => setShowData((value) => !value)}>Data</button>
          <button type="button" className="small primary" onClick={() => setShowSync((value) => !value)}>Portable Sync</button>
          <button type="button" className="small" onClick={() => void exportChat()}>Export</button>
          <button type="button" className="small" onClick={() => { setShowData(true); setDataTab('calendar') }}>Calendar</button>
          <button type="button" className="small" onClick={() => { setShowData(true); setDataTab('voice') }}>Voice</button>
        </div>

        {error && <div className="banner banner--error">{error}</div>}
        {health?.status === 'offline' && (
          <div className="banner banner--warn">Ollama offline at {health.url}. Start Ollama and seed a local model.</div>
        )}
        {screenReading && <div className="banner banner--warn screen-indicator">● Screen being read — one window, on demand</div>}

        {personaEditor && (
          <div className="editor-panel">
            <div className="editor-head">
              <strong>Persona editor</strong>
              <button type="button" className="icon" onClick={() => setPersonaEditor(null)}>×</button>
            </div>
            <input
              value={personaEditor.name}
              onChange={(event) => setPersonaEditor({ ...personaEditor, name: event.target.value })}
              placeholder="Persona name"
            />
            <textarea
              rows={4}
              value={personaEditor.systemPrompt}
              onChange={(event) => setPersonaEditor({ ...personaEditor, systemPrompt: event.target.value })}
              placeholder="System prompt…"
            />
            <div className="editor-actions">
              <button type="button" className="primary small" onClick={() => void savePersona()}>Save</button>
              {!personaEditor.builtin && (
                <button type="button" className="small danger" onClick={() => {
                  void window.api.store.deletePersona(personaEditor.id).then(refresh)
                  setPersonaEditor(null)
                }}>Delete</button>
              )}
              <button type="button" className="small" onClick={() => {
                setPersonaEditor({
                  id: `custom-${makeId()}`,
                  name: 'New persona',
                  systemPrompt: '',
                  builtin: false,
                  createdAt: Date.now()
                })
              }}>New persona</button>
            </div>
          </div>
        )}

        {pendingApproval && (
          <div className="approval-card">
            <div>
              <strong>Tool approval · {pendingApproval.risk}</strong>
              <div className="approval-code">
                {pendingApproval.tool}({JSON.stringify(pendingApproval.args)})
              </div>
            </div>
            <div className="approval-actions">
              <button type="button" className="primary small" onClick={() => respondApproval(true)}>Approve</button>
              <button type="button" className="small danger" onClick={() => respondApproval(false)}>Deny</button>
            </div>
          </div>
        )}

        {devApproval && (
          <div className="approval-card">
            <div>
              <strong>Tool approval · {devApproval.risk}</strong>
              <div className="approval-code">
                {devApproval.tool}({JSON.stringify(devApproval.args)})
              </div>
            </div>
            <div className="approval-actions">
              <button type="button" className="primary small" onClick={() => respondDevApproval(true)}>Approve</button>
              <button type="button" className="small danger" onClick={() => respondDevApproval(false)}>Deny</button>
            </div>
          </div>
        )}

        {connectorApproval && (
          <div className="approval-card">
            <div>
              <strong>Tool approval · {connectorApproval.risk}</strong>
              <div className="approval-code">
                {connectorApproval.tool}({JSON.stringify(connectorApproval.args)})
              </div>
            </div>
            <div className="approval-actions">
              <button type="button" className="primary small" onClick={() => respondConnectorApproval(true)}>Approve</button>
              <button type="button" className="small danger" onClick={() => respondConnectorApproval(false)}>Deny</button>
            </div>
          </div>
        )}

        {toolActivity.length > 0 && agentMode && (
          <div className="tool-strip">
            {toolActivity.slice(-6).map((activity) => (
              <span key={activity.callId} className={`tool-chip tool-chip--${activity.status}`}>
                {activity.tool} · {activity.status}
              </span>
            ))}
          </div>
        )}

        {lastSources.length > 0 && (
          <div className="source-strip">
            <span className="source-label">Sources</span>
            {lastSources.map((result, index) => (
              <span key={result.chunkId} className="source-chip" title={result.path}>
                [{index + 1}] {result.title} · {result.score}
              </span>
            ))}
          </div>
        )}

        {showSync && (
          <div className="data-drawer sync-drawer">
            <div className="data-tabs">
              <strong>Portable Sync</strong>
              <small className="muted">local LAN bridge · opt-in only</small>
              <span className="spacer" />
              <button type="button" className="small" onClick={() => void loadSystem()}>Refresh</button>
              <button type="button" className="icon" onClick={() => setShowSync(false)}>×</button>
            </div>
            <div className="data-body sync-body">
              <div className="sync-grid">
                <div className="sync-qr">
                  {pairQr
                    ? <img src={pairQr.dataUrl} alt="Portable Sync pairing QR" />
                    : <div className="qr-placeholder">QR not generated</div>}
                  <small>Scan in the Android app: <strong>Portable Sync → Scan PC QR</strong>.</small>
                </div>
                <div className="sync-info">
                  <div className="data-row">
                    <div>
                      <strong>Local bridge</strong>
                      <small>
                        {bridge?.enabled
                          ? `${bridge.running ? 'Listening' : 'Stopped'} · ${bridge.bindLan ? 'LAN on' : 'loopback only'} · token ${bridge.token}`
                          : 'Off — no phone can reach this PC'}
                        {pairQr && <><br />Address <code>{pairQr.url}</code></>}
                      </small>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="small" onClick={() => void toggleBridge()}>
                        {bridge?.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button type="button" className="small" disabled={!bridge?.enabled} onClick={() => void toggleBridgeLan()}>
                        {bridge?.bindLan ? 'LAN on' : 'LAN off'}
                      </button>
                      <button type="button" className="small primary" disabled={syncBusy} onClick={() => void showPairingQr()}>
                        {syncBusy ? 'Preparing…' : 'Show pairing QR'}
                      </button>
                    </div>
                  </div>
                  <small className="muted">The QR contains only your LAN address and the local pairing token. No cloud service is involved.</small>
                </div>
              </div>

              <div className="sync-devices">
                <strong>Trusted Devices</strong>
                {devices.length === 0
                  ? <small className="muted">No phone has paired yet. Scan the QR above to add one.</small>
                  : devices.map((device) => (
                    <div key={device.id} className="data-row device-row">
                      <div>
                        <strong>{device.name}</strong>
                        <small>
                          {device.platform} · {device.connected ? 'connected now' : `last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                          {' · '}{device.revoked ? 'revoked' : 'trusted'}
                        </small>
                        <code>{device.id.slice(0, 16)}…</code>
                      </div>
                      <div className="row-actions">
                        <button
                          type="button"
                          className={device.revoked ? 'small primary' : 'small danger'}
                          onClick={() => void setDeviceTrust(device.id, device.revoked)}
                        >
                          {device.revoked ? 'Allow again' : 'Revoke'}
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              {systemMessage && <div className="banner">{systemMessage}</div>}
            </div>
          </div>
        )}

        {showConnections && (
          <div className="data-drawer connections-drawer">
            <div className="data-tabs">
              <strong>Connections</strong>
              <small className="muted">local apps only · per-app approval</small>
              <span className="spacer" />
              <button type="button" className="small" onClick={() => void loadConnectors()}>Refresh</button>
              <button type="button" className="icon" onClick={() => setShowConnections(false)}>×</button>
            </div>

            <div className="connections-columns">
              <div className="connector-list">
                {connectorsList.map((connector) => (
                  <div key={connector.id} className="data-row connector-row">
                    <div>
                      <strong>{connector.name}</strong>
                      <small>{connector.description}</small>
                      <small>{connector.detected ? 'Detected on this machine' : 'Not detected'}{connector.path ? ` · ${connector.path}` : ''}</small>
                    </div>
                    <div className="row-actions">
                      {connector.granted ? (
                        <button
                          type="button"
                          className="small danger"
                          onClick={() => void changeGrant(connector.id, connector.kind, false)}
                        >Revoke</button>
                      ) : (
                        <button
                          type="button"
                          className="small primary"
                          disabled={!connector.detected}
                          onClick={() => void changeGrant(connector.id, connector.kind, true)}
                        >Grant</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="connector-actions">
                <div className="dev-actions">
                  <button type="button" className="small" onClick={() => void previewBookmarks()}>Opera bookmarks</button>
                  <button type="button" className="small" onClick={() => void previewVSCode()}>VS Code settings</button>
                  <button type="button" className="small" onClick={() => void refreshWindows()}>List windows</button>
                </div>

                <div className="data-form">
                  <select value={selectedWindow} onChange={(event) => setSelectedWindow(event.target.value)}>
                    {windows.length === 0 && <option value="">No windows listed</option>}
                    {windows.map((window) => (
                      <option key={window.id} value={window.id}>{window.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="small"
                    disabled={!selectedWindow || connectorBusy}
                    onClick={() => runConnector('screen.read', 'capture', { sourceId: selectedWindow }, 'sensitive', true)}
                  >Read window</button>
                </div>

                <div className="data-form">
                  <select value={controlApp} onChange={(event) => setControlApp(event.target.value as 'opera' | 'vscode' | 'notepad')}>
                    <option value="opera">Opera</option>
                    <option value="vscode">VS Code</option>
                    <option value="notepad">Notepad</option>
                  </select>
                  <input
                    value={controlTarget}
                    onChange={(event) => setControlTarget(event.target.value)}
                    placeholder={controlApp === 'opera' ? 'https://example.local' : 'C:\\path\\to\\file'}
                  />
                  <button
                    type="button"
                    className="small"
                    disabled={!controlTarget.trim() || connectorBusy}
                    onClick={() => runConnector('app.control', 'open', { app: controlApp, target: controlTarget }, 'write')}
                  >Open</button>
                </div>

                {connectorBusy && (
                  <button type="button" className="link" onClick={() => {
                    if (connectorRequestRef.current) void window.api.connectors.cancel(connectorRequestRef.current)
                  }}>Cancel running action</button>
                )}
                <pre className="dev-output connector-output">{connectorOutput || 'No connector output yet.'}</pre>
              </div>
            </div>
          </div>
        )}

        {showDev && (
          <div className="data-drawer dev-drawer">
            <div className="data-tabs">
              <strong>Dev helper</strong>
              <small className="muted">{repos.length} added {repos.length === 1 ? 'repo' : 'repos'}</small>
              <span className="spacer" />
              <button type="button" className="small" onClick={() => void loadRepos()}>Refresh</button>
              <button type="button" className="icon" onClick={() => setShowDev(false)}>×</button>
            </div>

            <div className="dev-columns">
              <div className="dev-controls">
                {repos.length === 0 && (
                  <p className="muted">Add a repo folder in Knowledge first, then it appears here.</p>
                )}
                <label className="field">
                  <span>Repo</span>
                  <select value={selectedRepo} onChange={(event) => setSelectedRepo(event.target.value)}>
                    {repos.length === 0 && <option value="">No repos added</option>}
                    {repos.map((repo) => (
                      <option key={repo.path} value={repo.path}>{repo.label}{repo.isGit ? ' (git)' : ''}</option>
                    ))}
                  </select>
                </label>
                <div className="dev-actions">
                  <button type="button" className="small" disabled={!selectedRepo} onClick={() => void inspectGit('status')}>Git status</button>
                  <button type="button" className="small" disabled={!selectedRepo} onClick={() => void inspectGit('diff')}>Git diff</button>
                </div>
                <div className="data-form">
                  <input
                    value={devCommand}
                    onChange={(event) => setDevCommand(event.target.value)}
                    placeholder="npm test"
                  />
                  <button type="button" className="small primary" disabled={!selectedRepo || devRunning} onClick={runDevTests}>
                    {devRunning ? 'Running…' : 'Run tests'}
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={!devRunning}
                    onClick={() => {
                      if (devRequestRef.current) void window.api.dev.cancel(devRequestRef.current)
                    }}
                  >Stop</button>
                </div>
                {devStatus && <div className="dev-status">{devStatus}</div>}
                <small className="muted">
                  Allowed: npm test / typecheck / build / lint / check, node --test, pytest, python -m pytest, cargo test, go test, dotnet test, vitest, jest. Runs only in added folders and always asks approval.
                </small>
              </div>
              <pre className="dev-output">{devOutput || 'No output yet.'}</pre>
            </div>
          </div>
        )}

        {showKnowledge && (
          <div className="data-drawer knowledge-drawer">
            <div className="data-tabs">
              <strong>Knowledge</strong>
              <small className="muted">embeddings: {ragModel || 'loading…'}</small>
              <span className="spacer" />
              <button
                type="button"
                className="small primary"
                onClick={() => void pickFolder()}
                disabled={ragProgress !== null}
              >Add folder</button>
              <button type="button" className="icon" onClick={() => setShowKnowledge(false)}>×</button>
            </div>

            {ragProgress && (
              <div className="banner">
                {ragProgress.message} ({ragProgress.current}/{ragProgress.total})
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    if (ragRequestRef.current) void window.api.rag.cancel(ragRequestRef.current)
                  }}
                >Cancel</button>
              </div>
            )}
            {ragError && <div className="banner banner--error">{ragError}</div>}
            {health?.status === 'online' && !health.models.some((model) => model.name.startsWith(ragModel)) && (
              <div className="banner banner--warn">Embedding model {ragModel} is missing from Ollama. Indexing and search will fail until it is installed.</div>
            )}

            <div className="knowledge-columns">
              <div className="knowledge-sources">
                {ragSources.length === 0 && <p className="muted">No folders indexed yet. Add a folder to get started.</p>}
                {ragSources.map((source) => (
                  <div key={source.id} className="data-row knowledge-source">
                    <div>
                      <strong>{source.label}</strong>
                      <small>{source.path}</small>
                      <small>{source.fileCount} files · {source.chunkCount} chunks · {source.status}</small>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="small"
                        disabled={ragProgress !== null}
                        onClick={() => startIndex(source.path)}
                      >Reindex</button>
                      <button
                        type="button"
                        className="small danger"
                        onClick={() => void window.api.rag.removeSource(source.id).then(loadKnowledge)}
                      >Remove</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="knowledge-search">
                <div className="data-form">
                  <input
                    value={ragQuery}
                    onChange={(event) => setRagQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void searchKnowledge()
                      }
                    }}
                    placeholder="Search indexed knowledge…"
                  />
                  <button type="button" className="small primary" onClick={() => void searchKnowledge()}>Search</button>
                </div>
                {ragResults.map((result, index) => (
                  <div key={result.chunkId} className="knowledge-result">
                    <strong>[{index + 1}] {result.title}</strong>
                    <small>{result.path} · score {result.score}</small>
                    <p>{result.snippet}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {showData && (
          <div className="data-drawer">
            <div className="data-tabs">
              {(['tasks', 'notes', 'reminders', 'calendar', 'voice', 'audit', 'system'] as const).map((tab) => (
                <button key={tab} type="button" className={dataTab === tab ? 'tab tab--active' : 'tab'} onClick={() => setDataTab(tab)}>
                  {tab}
                </button>
              ))}
              <button type="button" className="icon" onClick={() => setShowData(false)}>×</button>
            </div>

            {dataTab === 'tasks' && (
              <div className="data-body">
                <div className="data-form">
                  <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="New task" />
                  <select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value)}>
                    <option value="low">low</option><option value="normal">normal</option><option value="high">high</option>
                  </select>
                  <button type="button" className="small primary" onClick={() => {
                    if (!taskTitle.trim()) return
                    void window.api.store.createTask(taskTitle.trim(), null, taskPriority).then(loadData)
                    setTaskTitle('')
                  }}>Add</button>
                </div>
                {tasks.map((task) => (
                  <div key={task.id} className="data-row">
                    <span className={task.status === 'done' ? 'done' : ''}>{task.title} <small>[{task.priority}]</small></span>
                    {task.status !== 'done' && (
                      <button type="button" className="small" onClick={() => void window.api.store.completeTask(task.id).then(loadData)}>Complete</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {dataTab === 'notes' && (
              <div className="data-body">
                <div className="data-form">
                  <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="Note title" />
                  <input value={noteContent} onChange={(event) => setNoteContent(event.target.value)} placeholder="Note content" />
                  <button type="button" className="small primary" onClick={() => {
                    if (!noteTitle.trim()) return
                    void window.api.store.createNote(noteTitle.trim(), noteContent, []).then(loadData)
                    setNoteTitle(''); setNoteContent('')
                  }}>Add</button>
                </div>
                {notes.map((note) => (
                  <div key={note.id} className="data-row"><strong>{note.title}</strong><span>{note.content}</span></div>
                ))}
              </div>
            )}

            {dataTab === 'reminders' && (
              <div className="data-body">
                <div className="data-form">
                  <input value={reminderTitle} onChange={(event) => setReminderTitle(event.target.value)} placeholder="Reminder" />
                  <input value={reminderTime} onChange={(event) => setReminderTime(event.target.value)} placeholder="ISO time (optional)" />
                  <button type="button" className="small primary" onClick={() => {
                    if (!reminderTitle.trim()) return
                    void window.api.store.createReminder(reminderTitle.trim(), reminderTime || null).then(loadData)
                    setReminderTitle(''); setReminderTime('')
                  }}>Add</button>
                </div>
                {reminders.map((reminder) => (
                  <div key={reminder.id} className="data-row"><span>{reminder.title}</span><small>{reminder.fireAt ?? 'no time'}</small></div>
                ))}
              </div>
            )}

            {dataTab === 'calendar' && (
              <div className="data-body">
                <div className="data-row">
                  <div>
                    <strong>Local calendar</strong>
                    <small>Import .ics events into this machine only; UIDs are deduplicated and future events become reminders.</small>
                  </div>
                  <button type="button" className="small primary" onClick={() => void importCalendar()}>Import .ics…</button>
                </div>
                {calendarMessage && <div className="banner">{calendarMessage}</div>}
                {calendarEvents.length === 0 && <p className="muted">No calendar events imported yet.</p>}
                {calendarEvents.map((event) => (
                  <div key={event.id} className="data-row calendar-row">
                    <div>
                      <strong>{event.title}</strong>
                      <small>{event.allDay ? 'All day · ' : ''}{event.startAt ? new Date(event.startAt).toLocaleString() : 'no start time'} · {event.source}</small>
                      {event.description && <small className="calendar-description">{event.description}</small>}
                    </div>
                    <button type="button" className="small danger" onClick={() => void removeCalendarEvent(event.id)}>Remove</button>
                  </div>
                ))}
                <small className="muted">Recurring rules are not expanded; the master event is imported once. TZID values are converted with local timezone data.</small>
              </div>
            )}

            {dataTab === 'voice' && (
              <div className="data-body voice-body">
                <div className="data-row">
                  <div>
                    <strong>Local speech status</strong>
                    <small>
                      {voiceStatus
                        ? `TTS: ${voiceStatus.sapi ? 'Windows SAPI available' : 'SAPI unavailable'}${voiceStatus.piperConfigured ? ' · Piper configured' : ''} · STT: ${voiceStatus.whisperReady ? 'Whisper ready' : 'Whisper model missing'} · ${voiceStatus.sampleRate} Hz`
                        : 'checking…'}
                    </small>
                    {voiceStatus && <small className="muted" title={voiceStatus.whisperModel}>{voiceStatus.whisperModel.split(/[\\/]/).pop()}</small>}
                  </div>
                </div>
                <div className="data-row">
                  <label className="field">
                    <span>Text to speak</span>
                    <input
                      value={voiceText}
                      onChange={(event) => setVoiceText(event.target.value)}
                      placeholder="Type something for the local voice to read…"
                    />
                  </label>
                  <div className="row-actions">
                    <button type="button" className="small primary" disabled={voiceBusy || !voiceText.trim()} onClick={() => void speakText(voiceText)}>Speak</button>
                    {speaking && <button type="button" className="small stop" onClick={stopSpeaking}>Stop</button>}
                  </div>
                </div>
                <div className="data-row">
                  <label className="field">
                    <span>TTS engine</span>
                    <select
                      value={voiceConfig.ttsEngine}
                      onChange={(event) => setVoiceConfig({ ...voiceConfig, ttsEngine: event.target.value === 'piper' ? 'piper' : 'sapi' })}
                    >
                      <option value="sapi">Windows SAPI (built in)</option>
                      <option value="piper">Piper (local files you provide)</option>
                    </select>
                  </label>
                  {voiceConfig.ttsEngine === 'sapi' ? (
                    <div className="voice-fields">
                      <label className="field"><span>Voice name (optional)</span>
                        <input value={voiceConfig.sapiVoice} onChange={(event) => setVoiceConfig({ ...voiceConfig, sapiVoice: event.target.value })} placeholder="System default" />
                      </label>
                      <label className="field"><span>Rate: {voiceConfig.sapiRate}</span>
                        <input type="range" min={-10} max={10} value={voiceConfig.sapiRate} onChange={(event) => setVoiceConfig({ ...voiceConfig, sapiRate: Number(event.target.value) })} />
                      </label>
                    </div>
                  ) : (
                    <div className="voice-fields">
                      <label className="field"><span>Piper executable</span>
                        <input value={voiceConfig.piperExecutable} onChange={(event) => setVoiceConfig({ ...voiceConfig, piperExecutable: event.target.value })} placeholder="C:\\local\\piper.exe" />
                      </label>
                      <label className="field"><span>Piper model</span>
                        <input value={voiceConfig.piperModel} onChange={(event) => setVoiceConfig({ ...voiceConfig, piperModel: event.target.value })} placeholder="C:\\local\\voice.onnx" />
                      </label>
                      <label className="field"><span>Config (optional)</span>
                        <input value={voiceConfig.piperConfig} onChange={(event) => setVoiceConfig({ ...voiceConfig, piperConfig: event.target.value })} placeholder="C:\\local\\voice.json" />
                      </label>
                    </div>
                  )}
                </div>
                <div className="data-row">
                  <label className="field"><span>STT language</span>
                    <input value={voiceConfig.sttLanguage} onChange={(event) => setVoiceConfig({ ...voiceConfig, sttLanguage: event.target.value })} placeholder="en" />
                  </label>
                  <button type="button" className="small primary" onClick={() => void saveVoiceConfig()}>Save settings</button>
                </div>
                {voiceMessage && <div className="banner">{voiceMessage}</div>}
                <small className="muted">All audio stays on this PC: SAPI or your own Piper files for speech, Whisper WASM with a seeded local model for dictation. Microphone audio is never uploaded.</small>
              </div>
            )}

            {dataTab === 'audit' && (
              <div className="data-body">
                {audit.length === 0 && <p className="muted">No tool calls yet.</p>}
                {audit.map((entry) => (
                  <div key={entry.id} className="data-row audit-row">
                    <span><strong>{entry.tool}</strong> · {entry.approved ? 'approved' : 'denied'}</span>
                    <code>{entry.result}</code>
                  </div>
                ))}
              </div>
            )}

            {dataTab === 'system' && (
              <div className="data-body system-body">
                <div className="data-row">
                  <div>
                    <strong>Desktop shortcut</strong>
                    <small>{shortcutPresent ? 'Present on your Desktop' : 'Not created yet'}</small>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="small primary" onClick={() => void createShortcut()}>
                      {shortcutPresent ? 'Recreate' : 'Create'}
                    </button>
                    <button type="button" className="small danger" disabled={!shortcutPresent} onClick={() => void deleteShortcut()}>Remove</button>
                  </div>
                </div>
                <div className="data-row">
                  <div>
                    <strong>Global hotkey</strong>
                    <small>{hotkeyName || 'loading…'} · {hotkeyBound ? 'active' : 'not registered'}</small>
                  </div>
                  <small className="muted">Focuses the assistant window</small>
                </div>
                <div className="data-row">
                  <div>
                    <strong>Theme</strong>
                    <small>Switch between dark and light surfaces</small>
                  </div>
                  <button type="button" className="small" onClick={() => void toggleTheme()}>
                    {theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
                  </button>
                </div>
                <div className="data-row">
                  <div>
                    <strong>Android bridge</strong>
                    <small>
                      {bridge?.enabled
                        ? `On · ${bridge.running ? 'listening' : 'stopped'} · ${bridge.desktopConnected ? 'desktop linked' : 'waiting for desktop'} · ${bridge.phoneConnected ? 'phone linked' : 'no phone'}`
                        : 'Off · phone sync and remote control disabled'}
                      {bridge?.enabled && <> · token <code>{bridge.token}</code></>}
                      {bridge?.urls.slice(1).map((url) => <span key={url}><br /><code>{url}</code></span>)}
                    </small>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="small primary" onClick={() => void toggleBridge()}>
                      {bridge?.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button type="button" className="small" disabled={!bridge?.enabled} onClick={() => void toggleBridgeLan()}>
                      {bridge?.bindLan ? 'LAN on' : 'LAN off'}
                    </button>
                  </div>
                </div>
                <div className="data-row">
                  <div>
                    <strong>GitHub update check</strong>
                    <small>
                      Manual only — contacts GitHub when clicked. Current: <code>{version}</code>
                      {updateInfo && <> · Latest: <code>{updateInfo.latest}</code> · {updateInfo.newer ? 'update available' : 'up to date'}</>}
                      <br />Release tags use <code>000.0015.000.2026</code> (Major.Minor.Sub.Year).
                      {updateInfo?.notes && <><br /><span className="muted">{updateInfo.notes.slice(0, 300)}</span></>}
                    </small>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="small" disabled={updateBusy} onClick={() => void checkUpdate()}>
                      {updateBusy ? 'Checking…' : 'Check for update'}
                    </button>
                    <button type="button" className="small primary" disabled={!updateInfo} onClick={() => void openUpdate()}>
                      Open release
                    </button>
                  </div>
                </div>
                <div className="data-row">
                  <div>
                    <strong>Backup data</strong>
                    <small>Conversations, personas, characters, notes, tasks, reminders, audit, knowledge list, and settings → one local JSON file</small>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="small primary" onClick={() => void backup()}>Back up…</button>
                    <button type="button" className="small" onClick={() => void restore()}>Restore…</button>
                  </div>
                </div>
                <div className="data-row">
                  <div>
                    <strong>Android import bundle</strong>
                    <small>Writes the full JSON snapshot plus referenced .vrm avatars into a folder you choose, ready to copy to your phone</small>
                  </div>
                  <button type="button" className="small" onClick={() => void exportMobileBundle()}>Export for Android…</button>
                </div>
                {systemMessage && <div className="banner">{systemMessage}</div>}
                <small className="muted">Tray icon: right-click to show the assistant, open ChatRP, or quit. Reminders fire as local OS notifications within 5 minutes of their time.</small>
              </div>
            )}
          </div>
        )}

        <div className="workspace-body">
        <main className="chat">
          {messages.length === 0 ? (
            <div className="empty">
              <h2>Ready when you are</h2>
              <p>Pick a persona, then start a conversation.</p>
              <p className="empty-hint">Ctrl+K: new chat · /new · /export · /tasks · /notes · /knowledge · /dev · /connections · /avatar · /system · /calendar · /voice</p>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`message message--${message.role} ${message.pinned ? 'message--pinned' : ''}`}>
                <div className="message-label">
                  {message.role === 'user' ? 'You' : 'Assistant'}
                  {message.pinned && <span className="tag">pinned</span>}
                </div>
                {editingId === message.id ? (
                  <div className="message-edit">
                    <textarea rows={3} value={editValue} onChange={(event) => setEditValue(event.target.value)} />
                    <button type="button" className="small primary" onClick={() => void saveEdit(message.id)}>Save</button>
                    <button type="button" className="small" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="message-body">{message.content || (streaming ? '…' : '')}</div>
                )}
                <div className="message-actions">
                  <button type="button" className="link" onClick={() => void togglePin(message)}>{message.pinned ? 'Unpin' : 'Pin'}</button>
                  <button type="button" className="link" onClick={() => { setEditingId(message.id); setEditValue(message.content) }}>Edit</button>
                  <button type="button" className="link" onClick={() => void removeMessage(message.id)}>Delete</button>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </main>
        {avatarConfig.visible && (
          <aside className="avatar-dock">
            <Avatar state={avatarState} config={avatarConfig} onPatch={patchAvatar} getMouthLevel={() => mouthLevelRef.current} />
          </aside>
        )}
        </div>

        <footer className="composer">
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
            placeholder={agentMode ? 'Ask me anything · paste an image to read it locally…' : 'Message your local assistant · paste an image to read it…'}
            rows={2}
          />
          {imageMessage && <small className="hint image-paste-status">{imageBusy ? '◌ ' : '✓ '}{imageMessage}</small>}
          <div className="composer-actions">
            <span className="hint">Enter to send · Shift+Enter new line · Esc stops · paste images for local OCR</span>
            <div className="composer-buttons">
              <button type="button" className="small" disabled={voiceBusy && !recording} onClick={() => void (recording ? stopListening() : startListening())}>
                {recording ? 'Stop mic' : 'Listen'}
              </button>
              {speaking
                ? <button type="button" className="small stop" onClick={stopSpeaking}>Stop voice</button>
                : <button type="button" className="small" disabled={voiceBusy || (!input.trim() && messages.length === 0)} onClick={() => void speakLast()}>Speak</button>}
              <button type="button" className="small" onClick={() => void regenerate()} disabled={streaming || !activeId}>Regenerate</button>
              {streaming ? (
                <button type="button" className="primary stop" onClick={stop}>Stop</button>
              ) : (
                <button type="button" className="primary" onClick={() => void send()} disabled={!input.trim()}>Send</button>
              )}
            </div>
          </div>
        </footer>
      </section>
    </div>
  )
}
