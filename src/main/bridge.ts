import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import { WebSocket, WebSocketServer } from 'ws'
import type { BridgeConfig, BridgeStatus, PairingQr, TrustedDevice } from '../shared/types'
import { BUILD_VERSION } from '../shared/version'
import * as store from './storage'

type Role = 'desktop' | 'phone'
type BridgeMessage = Record<string, unknown> & { type: string }

interface DeviceMeta {
  id: string
  name: string
  platform: string
}

const DEFAULT_PORT = 8787
const DEVICES_KEY = 'bridge.devices'
const roles = new WeakMap<WebSocket, Role>()
const deviceMetas = new WeakMap<WebSocket, DeviceMeta>()
const deviceSockets = new Map<string, WebSocket>()
const lastDeviceTouch = new Map<string, number>()

let server: Server | null = null
let wss: WebSocketServer | null = null
let desktopSocket: WebSocket | null = null
let phoneSocket: WebSocket | null = null

function freshToken(): string {
  const raw = randomBytes(6).toString('hex').toUpperCase()
  return raw.match(/.{1,4}/g)?.join('-') ?? raw
}

function pairingToken(): string {
  const existing = store.getSetting('bridge.token')
  if (existing) return existing
  const token = freshToken()
  store.setSetting('bridge.token', token)
  return token
}

/** Rotate the local pairing token so old QR codes stop working for new connections. */
export function rotatePairingToken(): string {
  const token = freshToken()
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

function clean(value: string | null, max: number): string {
  return (value ?? '').trim().slice(0, max)
}

function readDevices(): TrustedDevice[] {
  const raw = store.getSetting(DEVICES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: clean(String(item.id ?? ''), 80),
        name: clean(String(item.name ?? ''), 60) || 'Virtua phone',
        platform: clean(String(item.platform ?? ''), 40) || 'Android',
        pairedAt: Number(item.pairedAt) || Date.now(),
        lastSeenAt: Number(item.lastSeenAt) || Date.now(),
        revoked: item.revoked === true,
        connected: false
      }))
      .filter((device) => device.id.length > 0)
  } catch {
    return []
  }
}

function writeDevices(devices: TrustedDevice[]): void {
  store.setSetting(DEVICES_KEY, JSON.stringify(devices.slice(-50)))
}

function deviceFromQuery(url: URL): DeviceMeta | null {
  const id = clean(url.searchParams.get('deviceId'), 80)
  if (!id) return null
  return {
    id,
    name: clean(url.searchParams.get('deviceName'), 60) || 'Virtua phone',
    platform: clean(url.searchParams.get('platform'), 40) || 'Android'
  }
}

function rememberDevice(meta: DeviceMeta): TrustedDevice {
  const devices = readDevices()
  const now = Date.now()
  const existing = devices.find((device) => device.id === meta.id)
  if (existing) {
    existing.name = meta.name
    existing.platform = meta.platform
    existing.lastSeenAt = now
    existing.revoked = false
  } else {
    devices.push({
      id: meta.id,
      name: meta.name,
      platform: meta.platform,
      pairedAt: now,
      lastSeenAt: now,
      revoked: false,
      connected: false
    })
  }
  writeDevices(devices)
  lastDeviceTouch.set(meta.id, now)
  return existing ?? devices[devices.length - 1]
}

function touchDevice(id: string): void {
  const now = Date.now()
  if (now - (lastDeviceTouch.get(id) ?? 0) < 30_000) return
  lastDeviceTouch.set(id, now)
  const devices = readDevices()
  const device = devices.find((item) => item.id === id)
  if (!device) return
  device.lastSeenAt = now
  writeDevices(devices)
}

function isDeviceConnected(id: string): boolean {
  const socket = deviceSockets.get(id)
  return socket?.readyState === WebSocket.OPEN
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
    phoneConnected: phoneSocket?.readyState === WebSocket.OPEN,
    devices: readDevices().map((device) => ({ ...device, connected: isDeviceConnected(device.id) }))
  }
}

/** Build a local-only deep link QR for the phone to scan. */
export async function pairingQr(token = pairingToken()): Promise<PairingQr> {
  const config = bridgeConfig()
  const lanUrl = config.urls.find((url) => !url.startsWith('http://127.0.0.1'))
  if (!lanUrl) throw new Error('Turn on LAN bridging before showing the pairing QR.')
  const parsed = new URL(lanUrl)

  const payload = new URL('virtua://pair')
  payload.searchParams.set('v', '1')
  payload.searchParams.set('host', parsed.hostname)
  payload.searchParams.set('port', parsed.port || String(config.port))
  payload.searchParams.set('token', token)

  const dataUrl = await QRCode.toDataURL(payload.toString(), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
    color: { dark: '#111827', light: '#FFFFFF' }
  })
  return { dataUrl, payload: payload.toString(), url: `http://${parsed.host}` }
}

/** Rotate the token and return a fresh pairing QR for a new phone. */
export async function pairNew(): Promise<PairingQr> {
  return pairingQr(rotatePairingToken())
}

export function revokeDevice(id: string): BridgeStatus {
  const devices = readDevices()
  const device = devices.find((item) => item.id === id)
  if (!device) throw new Error('Trusted device not found.')
  device.revoked = true
  writeDevices(devices)
  const socket = deviceSockets.get(id)
  if (socket) {
    socket.close(4001, 'Device revoked')
    deviceSockets.delete(id)
  }
  return bridgeStatus()
}

export function allowDevice(id: string): BridgeStatus {
  const devices = readDevices()
  const device = devices.find((item) => item.id === id)
  if (!device) throw new Error('Trusted device not found.')
  device.revoked = false
  writeDevices(devices)
  return bridgeStatus()
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

  // PC pushes include base64 VRM bytes, which can easily exceed ws's 100 MB default.
  wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 })
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
    const meta = role === 'phone' ? deviceFromQuery(url) : null
    const revoked = meta ? readDevices().some((device) => device.id === meta.id && device.revoked) : false
    if ((role !== 'desktop' && role !== 'phone') || token !== pairingToken() || revoked) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss?.handleUpgrade(request, socket, head, (socket_) => {
      roles.set(socket_, role)
      if (meta) deviceMetas.set(socket_, meta)
      wss?.emit('connection', socket_, request)
    })
  })

  wss.on('connection', (socket) => {
    const role = roles.get(socket)
    if (!role) {
      socket.close()
      return
    }
    const meta = deviceMetas.get(socket) ?? null

    if (role === 'desktop') {
      desktopSocket?.close()
      desktopSocket = socket
      send(phoneSocket, { type: 'peer', role: 'desktop', connected: true })
    } else {
      phoneSocket?.close()
      phoneSocket = socket
      if (meta) {
        const device = rememberDevice(meta)
        deviceSockets.set(device.id, socket)
      }
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
      if (meta && message.type !== 'ping') touchDevice(meta.id)
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
      if (meta && deviceSockets.get(meta.id) === socket) {
        deviceSockets.delete(meta.id)
        touchDevice(meta.id)
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
  deviceSockets.clear()
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
