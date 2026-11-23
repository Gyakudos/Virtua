import { decodeValue, encodeValue } from '../../shared/bridgeCodec'

const SUBSCRIPTION_METHODS = new Set([
  'chatStream',
  'agent.run',
  'connectors.run',
  'dev.runTests',
  'rag.index'
])

type Handler = (value: unknown) => void
interface PendingCall {
  handlers: Record<string, Handler>
  cleanup?: () => void
}
interface PeerCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: number
}
interface BridgeClientConfig {
  enabled: boolean
  port: number
  token: string
}

let config: BridgeClientConfig | null = null
let socket: WebSocket | null = null
let retry: number | null = null
let peerSequence = 0

const pending = new Map<string, PendingCall>()
const peerPending = new Map<string, PeerCall>()

function bridgeApi(): { config(): Promise<BridgeClientConfig> } | null {
  const api = (window.api as unknown as {
    bridge?: { config(): Promise<BridgeClientConfig> }
  }).bridge
  return api ?? null
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function apiAt(path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, window.api)
}

function injectHandlers(value: unknown, handlers: Record<string, Handler>): unknown {
  if (Array.isArray(value)) return value.map((item) => injectHandlers(item, handlers))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(record.__vaHandlers)) return handlers
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) result[key] = injectHandlers(item, handlers)
    return result
  }
  return value
}

function failPeerCalls(error: Error): void {
  for (const call of peerPending.values()) {
    window.clearTimeout(call.timer)
    call.reject(error)
  }
  peerPending.clear()
}

function handleMessage(event: MessageEvent<string>): void {
  let message: Record<string, any>
  try {
    message = JSON.parse(String(event.data)) as Record<string, any>
  } catch {
    return
  }

  if (message.type === 'result' && String(message.id).startsWith('pc-')) {
    const id = String(message.id)
    const call = peerPending.get(id)
    if (!call) return
    peerPending.delete(id)
    window.clearTimeout(call.timer)
    if (message.ok === true) call.resolve(decodeValue(message.value))
    else call.reject(new Error(String(message.error ?? 'Phone call failed.')))
    return
  }

  if (message.type === 'invoke') {
    const id = String(message.id)
    const path = String(message.path)
    const names = Array.isArray(message.handlers) ? message.handlers.map(String) : []
    const handlers: Record<string, Handler> = {}
    for (const name of names) {
      handlers[name] = (value: unknown) => send({
        type: 'event',
        id,
        handler: name,
        value: encodeValue(value)
      })
    }
    const call = pending.get(id) ?? { handlers }
    pending.set(id, call)
    const target = apiAt(path)
    if (typeof target !== 'function') {
      send({ type: 'result', id, ok: false, error: `Unknown bridge method: ${path}` })
      pending.delete(id)
      return
    }
    const args = (decodeValue(message.args ?? []) as unknown[]).map((arg) => injectHandlers(arg, handlers))
    try {
      void Promise.resolve(target.apply(window.api, args)).then((value) => {
        if (SUBSCRIPTION_METHODS.has(path) && typeof value === 'function') {
          const entry = pending.get(id) ?? { handlers }
          entry.cleanup = value as () => void
          pending.set(id, entry)
          send({ type: 'result', id, ok: true, value: { __vaSubscription: true } })
        } else {
          send({ type: 'result', id, ok: true, value: encodeValue(value) })
          pending.delete(id)
        }
      }).catch((error: unknown) => {
        send({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) })
        pending.delete(id)
      })
    } catch (error) {
      send({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) })
      pending.delete(id)
    }
    return
  }

  if (message.type === 'cancel') {
    const id = String(message.id)
    pending.get(id)?.cleanup?.()
    pending.delete(id)
    return
  }

  if (message.type === 'ping') send({ type: 'pong' })
}

function connect(): void {
  if (!config?.enabled) return
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return

  const token = encodeURIComponent(config.token)
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/bridge?role=desktop&token=${token}`)
  socket = ws

  ws.onmessage = handleMessage

  ws.onclose = () => {
    if (socket === ws) socket = null
    for (const call of pending.values()) call.cleanup?.()
    pending.clear()
    failPeerCalls(new Error('Desktop bridge disconnected.'))
    if (retry === null) retry = window.setTimeout(() => { retry = null; connect() }, 2000)
  }
}

function reconnect(): void {
  if (retry !== null) {
    window.clearTimeout(retry)
    retry = null
  }
  for (const call of pending.values()) call.cleanup?.()
  pending.clear()
  failPeerCalls(new Error('Desktop bridge is reconnecting.'))
  if (socket) {
    const old = socket
    socket = null
    old.onclose = null
    old.close()
  }
  connect()
}

/** Lets a paired phone drive the existing window.api surface through the local bridge. */
export async function startDesktopBridge(): Promise<void> {
  if (!navigator.userAgent.includes('Electron')) return
  const bridge = bridgeApi()
  if (!bridge) return
  config = await bridge.config()
  if (!config.enabled) return
  connect()
}

/** Re-read the bridge config after Pair New rotates the local token. */
export async function refreshDesktopBridge(): Promise<void> {
  if (!navigator.userAgent.includes('Electron')) return
  const bridge = bridgeApi()
  if (!bridge) return
  config = await bridge.config()
  if (!config.enabled) {
    failPeerCalls(new Error('Local bridge is disabled.'))
    const old = socket
    socket = null
    if (old) {
      old.onclose = null
      old.close()
    }
    return
  }
  reconnect()
}

/** Call a local-only method on the currently connected phone. */
export function callPeer(path: string, args: unknown[] = []): Promise<unknown> {
  if (socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('No phone is connected. Pair and connect a phone first.'))
  }
  const id = `pc-${Date.now()}-${peerSequence++}`
  return new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      peerPending.delete(id)
      reject(new Error('The phone did not respond to the sync request.'))
    }, 30_000)
    peerPending.set(id, { resolve, reject, timer })
    try {
      send({ type: 'invoke', id, path, args: encodeValue(args) })
    } catch (cause) {
      peerPending.delete(id)
      window.clearTimeout(timer)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}
