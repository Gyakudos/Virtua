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

/** Lets a paired phone drive the existing window.api surface through the local bridge. */
export async function startDesktopBridge(): Promise<void> {
  if (!navigator.userAgent.includes('Electron')) return
  const bridge = (window.api as unknown as {
    bridge?: { config(): Promise<{ enabled: boolean; port: number; token: string }> }
  }).bridge
  if (!bridge) return

  const config = await bridge.config()
  if (!config.enabled) return

  const pending = new Map<string, PendingCall>()
  let socket: WebSocket | null = null
  let retry: number | null = null

  const send = (message: Record<string, unknown>): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  const connect = (): void => {
    const token = encodeURIComponent(config.token)
    socket = new WebSocket(`ws://127.0.0.1:${config.port}/bridge?role=desktop&token=${token}`)

    socket.onmessage = (event) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(String(event.data)) as Record<string, any>
      } catch {
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

    socket.onclose = () => {
      for (const call of pending.values()) call.cleanup?.()
      pending.clear()
      if (retry === null) retry = window.setTimeout(() => { retry = null; connect() }, 2000)
    }
  }

  connect()
}
