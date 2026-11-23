import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import type { BridgeConfig, BridgeStatus } from '../shared/types'
import { BUILD_VERSION } from '../shared/version'
import * as store from './storage'

type Role = 'desktop' | 'phone'
type BridgeMessage = Record<string, unknown> & { type: string }

const DEFAULT_PORT = 8787
const roles = new WeakMap<WebSocket, Role>()

let server: Server | null = null
let wss: WebSocketServer | null = null
let desktopSocket: WebSocket | null = null
let phoneSocket: WebSocket | null = null

function pairingToken(): string {
  const existing = store.getSetting('bridge.token')
  if (existing) return existing
  const raw = randomBytes(6).toString('hex').toUpperCase()
  const token = raw.match(/.{1,4}/g)?.join('-') ?? raw
  store.setSetting('bridge.token', token)
  return token
}

function lanAddresses(): string[] {
  const addresses: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address)
    }
  }
  return Array.from(new Set(addresses))
}

export function bridgeConfig(): BridgeConfig {
  const enabled = store.getSetting('bridge.enabled') === 'true'
  const bindLan = store.getSetting('bridge.bindLan') === 'true'
  const port = Number(store.getSetting('bridge.port') ?? DEFAULT_PORT) || DEFAULT_PORT
  const urls = [`http://127.0.0.1:${port}`]
  if (bindLan) {
    for (const address of lanAddresses()) urls.push(`http://${address}:${port}`)
  }
  return { enabled, bindLan, port, host: bindLan ? '0.0.0.0' : '127.0.0.1', token: pairingToken(), urls }
}

export function bridgeStatus(): BridgeStatus {
  return {
    ...bridgeConfig(),
    running: Boolean(server),
    desktopConnected: desktopSocket?.readyState === WebSocket.OPEN,
    phoneConnected: phoneSocket?.readyState === WebSocket.OPEN
  }
}

function send(target: WebSocket | null, message: BridgeMessage): void {
  if (target?.readyState === WebSocket.OPEN) target.send(JSON.stringify(message))
}

function relayToPeer(from: Role, message: BridgeMessage): void {
  if (from === 'phone') send(desktopSocket, message)
  else send(phoneSocket, message)
}

export function startBridge(): BridgeStatus {
  const config = bridgeConfig()
  if (!config.enabled || server) return bridgeStatus()

  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, app: 'virtual-assistant-bridge', build: BUILD_VERSION }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Virtual Assistant bridge. Connect with /bridge?role=desktop|phone&token=...\n')
  })

  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/bridge') {
      socket.destroy()
      return
    }
    const role = url.searchParams.get('role')
    const token = url.searchParams.get('token')
    if ((role !== 'desktop' && role !== 'phone') || token !== config.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss?.handleUpgrade(request, socket, head, (socket_) => {
      roles.set(socket_, role)
      wss?.emit('connection', socket_, request)
    })
  })

  wss.on('connection', (socket) => {
    const role = roles.get(socket)
    if (!role) {
      socket.close()
      return
    }
    if (role === 'desktop') {
      desktopSocket?.close()
      desktopSocket = socket
      send(phoneSocket, { type: 'peer', role: 'desktop', connected: true })
    } else {
      phoneSocket?.close()
      phoneSocket = socket
      send(desktopSocket, { type: 'peer', role: 'phone', connected: true })
    }

    socket.on('message', (raw) => {
      let message: BridgeMessage
      try {
        message = JSON.parse(raw.toString()) as BridgeMessage
      } catch {
        send(socket, { type: 'error', error: 'Invalid JSON.' })
        return
      }
      if (message.type === 'ping') {
        send(socket, { type: 'pong' })
        return
      }
      if (['invoke', 'cancel', 'result', 'event'].includes(message.type)) relayToPeer(role, message)
    })

    socket.on('close', () => {
      if (role === 'desktop' && desktopSocket === socket) {
        desktopSocket = null
        send(phoneSocket, { type: 'peer', role: 'desktop', connected: false })
      }
      if (role === 'phone' && phoneSocket === socket) {
        phoneSocket = null
        send(desktopSocket, { type: 'peer', role: 'phone', connected: false })
      }
    })
  })

  server.listen(config.port, config.host, () => {
    console.log(`[bridge] listening on ${config.host}:${config.port}`)
  })
  server.on('error', (error) => console.error('[bridge] server error:', error))
  return bridgeStatus()
}

export function stopBridge(): BridgeStatus {
  desktopSocket?.close()
  phoneSocket?.close()
  desktopSocket = null
  phoneSocket = null
  wss?.close()
  wss = null
  server?.close()
  server = null
  return bridgeStatus()
}

export function setBridgeEnabled(enabled: boolean, bindLan?: boolean): BridgeStatus {
  store.setSetting('bridge.enabled', String(enabled))
  if (bindLan !== undefined) store.setSetting('bridge.bindLan', String(bindLan))
  return enabled ? startBridge() : stopBridge()
}

export function setBridgeBindLan(bindLan: boolean): BridgeStatus {
  store.setSetting('bridge.bindLan', String(bindLan))
  if (server) {
    stopBridge()
    return startBridge()
  }
  return bridgeStatus()
}
