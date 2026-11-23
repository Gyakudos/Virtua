import { decodeValue, encodeValue, extractHandlers } from '../shared/bridgeCodec'
import { createApiProxy } from './apiContract'

const URL_KEY = 'virtua.link.url'
const TOKEN_KEY = 'virtua.link.token'
const DEVICE_ID_KEY = 'virtua.device.id'
const DEVICE_NAME_KEY = 'virtua.device.name'

export interface DeviceIdentity {
  id: string
  name: string
  platform: string
}

export type LinkStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'error'

export interface LinkConfig {
  url: string
  token: string
}

export interface LinkedController {
  config(): LinkConfig
  setConfig(config: LinkConfig): void
  status(): LinkStatus
  onStatus(listener: (status: LinkStatus) => void): () => void
  reconnect(): void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface ActiveCall {
  handlers: Record<string, (value: unknown) => void>
}

export function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower === '::1' || lower.endsWith('.local') || lower.endsWith('.ts.net')) return true
  const octets = lower.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets
  return a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127
}

function normalizeBaseUrl(input: string): string {
  let value = input.trim().replace(/\/+$/, '')
  if (!value) throw new Error('Enter the desktop bridge address.')
  if (/^https?:\/\//i.test(value)) value = value.replace(/^http/i, 'ws')
  else if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`
  const url = new URL(value)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Bridge address must be ws:// or wss://.')
  if (!isLocalHost(url.hostname)) {
    throw new Error('Only LAN, mDNS, localhost, or Tailscale bridge addresses are allowed.')
  }
  return url.toString().replace(/\/+$/, '')
}

function collectHandlers(args: unknown[]): Record<string, (value: unknown) => void> {
  const handlers: Record<string, (value: unknown) => void> = {}
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) continue
    for (const [name, value] of Object.entries(arg)) {
      if (typeof value === 'function') handlers[name] = value as (value: unknown) => void
    }
  }
  return handlers
}

export function deviceIdentity(): DeviceIdentity {
  let id = localStorage.getItem(DEVICE_ID_KEY) ?? ''
  if (!id) {
    id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  const storedName = localStorage.getItem(DEVICE_NAME_KEY)?.trim()
  const name = storedName || (/Android/i.test(navigator.userAgent) ? 'Android phone' : 'Virtua phone')
  return { id, name, platform: /Android/i.test(navigator.userAgent) ? 'Android' : 'Browser' }
}

function bridgeUrl(config: LinkConfig): string {
  const base = normalizeBaseUrl(config.url)
  const token = config.token.trim()
  if (!token) throw new Error('Enter the pairing token shown in the desktop app.')
  const url = new URL(base)
  url.pathname = '/bridge'
  url.search = ''
  const identity = deviceIdentity()
  url.searchParams.set('role', 'phone')
  url.searchParams.set('token', token)
  url.searchParams.set('deviceId', identity.id)
  url.searchParams.set('deviceName', identity.name)
  url.searchParams.set('platform', identity.platform)
  return url.toString()
}

export function readLinkConfig(): LinkConfig {
  return {
    url: localStorage.getItem(URL_KEY) ?? '',
    token: localStorage.getItem(TOKEN_KEY) ?? ''
  }
}

export function createLinkedApi(autoConnect = true): { api: Window['api']; controller: LinkedController } {
  let config = readLinkConfig()
  let socket: WebSocket | null = null
  let openPromise: Promise<void> | null = null
  let reconnectTimer: number | null = null
  let currentStatus: LinkStatus = config.url && config.token ? 'disconnected' : 'unconfigured'
  let sequence = 0
  const pending = new Map<string, PendingCall>()
  const active = new Map<string, ActiveCall>()
  const listeners = new Set<(status: LinkStatus) => void>()

  const setStatus = (status: LinkStatus): void => {
    currentStatus = status
    for (const listener of listeners) listener(status)
  }

  const send = (message: Record<string, unknown>): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  const handleMessage = (event: MessageEvent<string>): void => {
    let message: Record<string, any>
    try {
      message = JSON.parse(event.data) as Record<string, any>
    } catch {
      return
    }
    if (message.type === 'result') {
      const id = String(message.id)
      const call = pending.get(id)
      if (!call) return
      pending.delete(id)
      if (message.ok === true) call.resolve(decodeValue(message.value))
      else call.reject(new Error(String(message.error ?? 'Desktop call failed.')))
      return
    }
    if (message.type === 'event') {
      const call = active.get(String(message.id))
      call?.handlers[String(message.handler)]?.(decodeValue(message.value))
      return
    }
    if (message.type === 'ping') send({ type: 'pong' })
  }

  const scheduleReconnect = (): void => {
    if (reconnectTimer !== null || !config.url || !config.token) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      void connect().catch(() => undefined)
    }, 2500)
  }

  const connect = (): Promise<void> => {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (openPromise) return openPromise
    if (!config.url || !config.token) {
      setStatus('unconfigured')
      return Promise.reject(new Error('Bridge is not configured.'))
    }

    let target: string
    try {
      target = bridgeUrl(config)
    } catch (error) {
      setStatus('error')
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }

    setStatus('connecting')
    openPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(target)
      socket = ws
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        ws.close()
        reject(new Error('Timed out connecting to the desktop bridge.'))
      }, 10_000)

      ws.onopen = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        setStatus('connected')
        resolve()
      }
      ws.onmessage = handleMessage
      ws.onerror = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        setStatus('error')
        reject(new Error('Could not connect to the desktop bridge. Check the address, token, and LAN setting.'))
      }
      ws.onclose = () => {
        window.clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new Error('Desktop bridge closed the connection.'))
        }
        if (socket === ws) socket = null
        setStatus(config.url && config.token ? 'disconnected' : 'unconfigured')
        const failure = new Error('Desktop bridge disconnected.')
        for (const call of pending.values()) call.reject(failure)
        pending.clear()
        active.clear()
        scheduleReconnect()
      }
    }).finally(() => {
      openPromise = null
    })
    return openPromise
  }

  const nextId = (): string => `phone-${Date.now()}-${sequence++}`

  const invoke = async (path: string, args: unknown[]): Promise<unknown> => {
    await connect()
    const id = nextId()
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        send({ type: 'invoke', id, path, args: encodeValue(args) })
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const subscribe = (path: string, args: unknown[]): (() => void) => {
    const id = nextId()
    const { args: clean, handlers } = extractHandlers(args)
    active.set(id, { handlers: collectHandlers(args) })
    void connect().then(() => {
      send({ type: 'invoke', id, path, args: encodeValue(clean), handlers })
    }).catch((error: unknown) => {
      const entry = active.get(id)
      const onError = entry?.handlers.onError
      active.delete(id)
      onError?.(error instanceof Error ? error.message : String(error))
    })

    return () => {
      active.delete(id)
      send({ type: 'cancel', id })
    }
  }

  const controller: LinkedController = {
    config: () => ({ ...config }),
    setConfig: (next) => {
      config = { url: next.url.trim(), token: next.token.trim() }
      localStorage.setItem(URL_KEY, config.url)
      localStorage.setItem(TOKEN_KEY, config.token)
      socket?.close()
      socket = null
      setStatus(config.url && config.token ? 'disconnected' : 'unconfigured')
      void connect().catch(() => undefined)
    },
    status: () => currentStatus,
    onStatus: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reconnect: () => {
      socket?.close()
      socket = null
      void connect().catch(() => undefined)
    }
  }

  if (autoConnect && config.url && config.token) void connect().catch(() => undefined)

  return {
    api: createApiProxy({ invoke, subscribe }),
    controller
  }
}
