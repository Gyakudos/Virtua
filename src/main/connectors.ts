import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, desktopCapturer } from 'electron'
import type {
  BookmarkEntry, ConnectorInfo, ConnectorKind, OcrResult, ScreenSourceInfo
} from '../shared/types'
import { ocrImage } from './ocr'
import { isCredentialPath } from './rag'
import * as store from './storage'

const APP_DATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const USER_PROFILE = process.env.USERPROFILE ?? homedir()

const OPERA_BOOKMARKS = join(APP_DATA, 'Opera Software', 'Opera Stable', 'Bookmarks')
const VSCODE_SETTINGS = join(APP_DATA, 'Code', 'User', 'settings.json')
const VSCODE_EXTENSIONS = join(USER_PROFILE, '.vscode', 'extensions', 'extensions.json')

const OPERA_EXES = [
  join(LOCAL_APP_DATA, 'Programs', 'Opera', 'opera.exe'),
  join(APP_DATA, 'Opera Software', 'Opera Stable', 'opera.exe'),
  'C:\\Program Files\\Opera\\opera.exe',
  'C:\\Program Files (x86)\\Opera\\opera.exe'
]
const VSCODE_EXES = [
  join(LOCAL_APP_DATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'C:\\Program Files\\Microsoft VS Code\\Code.exe'
]
const NOTEPAD_EXE = 'C:\\Windows\\System32\\notepad.exe'

const CATALOG: Array<Omit<ConnectorInfo, 'detected' | 'granted'>> = [
  {
    id: 'opera.bookmarks', name: 'Opera bookmarks', kind: 'read', path: OPERA_BOOKMARKS,
    description: 'Read your local Opera bookmark names, URLs, and folders.'
  },
  {
    id: 'vscode.settings', name: 'VS Code settings', kind: 'read', path: VSCODE_SETTINGS,
    description: 'Read local VS Code user settings and installed extension list.'
  },
  {
    id: 'app.control', name: 'App control', kind: 'control', path: '',
    description: 'Open a file, folder, or URL in Opera, VS Code, or Notepad. Approved per call.'
  },
  {
    id: 'screen.read', name: 'Screen reading', kind: 'screen', path: '',
    description: 'Capture one chosen window on demand and read its text with local OCR.'
  }
]

function executable(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function listConnectors(): ConnectorInfo[] {
  const permissions = new Set(store.listAppPermissions().map((permission) => `${permission.app_id}:${permission.kind}`))
  return CATALOG.map((connector) => {
    const detected = connector.id === 'app.control'
      ? Boolean(executable(OPERA_EXES) || executable(VSCODE_EXES) || existsSync(NOTEPAD_EXE))
      : connector.id === 'screen.read'
        ? true
        : Boolean(connector.path && existsSync(connector.path))
    return {
      ...connector,
      detected,
      granted: permissions.has(`${connector.id}:${connector.kind}`)
    }
  })
}

export function assertPermission(appId: string, kind: ConnectorKind): void {
  if (!store.hasAppPermission(appId, kind)) {
    throw new Error(`Connector ${appId} is not granted. Grant it in Connections first.`)
  }
}

interface BookmarkNode {
  type?: string
  name?: string
  url?: string
  children?: BookmarkNode[]
  roots?: Record<string, BookmarkNode>
}

function walkBookmarks(node: BookmarkNode, folder: string, out: BookmarkEntry[]): void {
  if (node.type === 'url' && node.url) {
    out.push({ name: node.name ?? '', url: node.url, folder })
  }
  const nextFolder = node.type === 'folder' && node.name
    ? (folder ? `${folder}/${node.name}` : node.name)
    : folder
  for (const child of node.children ?? []) walkBookmarks(child, nextFolder, out)
}

export function readOperaBookmarks(): BookmarkEntry[] {
  assertPermission('opera.bookmarks', 'read')
  if (!existsSync(OPERA_BOOKMARKS)) return []
  const data = JSON.parse(readFileSync(OPERA_BOOKMARKS, 'utf8')) as BookmarkNode
  const out: BookmarkEntry[] = []
  for (const [rootName, root] of Object.entries(data.roots ?? {})) {
    walkBookmarks(root, rootName === 'bookmark_bar' ? 'Bookmarks bar' : rootName, out)
  }
  return out.slice(0, 500)
}

function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1')
  return JSON.parse(stripped) as Record<string, unknown>
}

export function readVSCodeSettings(): { settings: Record<string, unknown>; extensions: string[] } {
  assertPermission('vscode.settings', 'read')
  const settings = existsSync(VSCODE_SETTINGS)
    ? parseJsonc(readFileSync(VSCODE_SETTINGS, 'utf8'))
    : {}

  let extensions: string[] = []
  if (existsSync(VSCODE_EXTENSIONS)) {
    try {
      const data = JSON.parse(readFileSync(VSCODE_EXTENSIONS, 'utf8')) as Array<{ identifier?: { id?: string } }>
      extensions = data.map((item) => item.identifier?.id ?? '').filter(Boolean)
    } catch {
      extensions = []
    }
  }
  return { settings, extensions: extensions.slice(0, 200) }
}

export type ControllableApp = 'opera' | 'vscode' | 'notepad'

export function controlApp(appId: ControllableApp, target: string): { ok: true; command: string } {
  assertPermission('app.control', 'control')
  if (!target.trim()) throw new Error('A target is required.')

  let binary: string
  let argument: string
  if (appId === 'opera') {
    binary = executable(OPERA_EXES) ?? ''
    if (!binary) throw new Error('Opera executable was not found on this machine.')
    if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) {
      argument = target
    } else {
      throw new Error('Opera control accepts an http://, https://, or file:// URL.')
    }
  } else if (appId === 'vscode') {
    binary = executable(VSCODE_EXES) ?? ''
    if (!binary) throw new Error('VS Code executable was not found on this machine.')
    argument = target
  } else {
    binary = NOTEPAD_EXE
    argument = target
  }

  if (appId !== 'opera') {
    if (isCredentialPath(argument)) throw new Error('That path is on the credential deny-list.')
    if (!existsSync(argument)) throw new Error(`Target does not exist: ${argument}`)
  }

  const child = spawn(binary, [argument], {
    shell: false,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', () => { /* Launch failures surface via the returned command for visibility. */ })
  child.unref()
  return { ok: true, command: `${binary} ${argument}` }
}

export async function listWindows(): Promise<ScreenSourceInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 200 }
  })
  return sources.map((source) => ({ id: source.id, name: source.name }))
}

async function captureWindow(sourceId: string, requestId: string): Promise<string> {
  assertPermission('screen.read', 'screen')
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1280, height: 720 }
  })
  const source = sources.find((item) => item.id === sourceId)
  if (!source) throw new Error('That window is no longer available.')

  const directory = join(app.getPath('userData'), 'captures')
  mkdirSync(directory, { recursive: true })
  const safeId = `${requestId}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  const imagePath = join(directory, `${safeId}.png`)
  writeFileSync(imagePath, source.thumbnail.toPNG())
  return imagePath
}

export async function readScreen(sourceId: string, requestId: string): Promise<OcrResult> {
  const imagePath = await captureWindow(sourceId, requestId)
  assertPermission('screen.read', 'screen')
  return { text: await ocrImage(imagePath), imagePath }
}
