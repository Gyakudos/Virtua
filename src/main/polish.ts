import {
  app, dialog, globalShortcut, Menu, nativeImage, Notification, shell, Tray
} from 'electron'
import type { BrowserWindow } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { BackupPayload, BackupSummary } from '../shared/types'
import { BUILD_VERSION } from '../shared/version'
import { listOllamaModelFiles } from './ollamaModels'
import { isCredentialPath } from './rag'
import * as store from './storage'

export const HOTKEY = 'Control+Alt+Shift+V'

const SHORTCUT_NAME = 'Virtual Assistant.lnk'
const REMINDER_INTERVAL_MS = 30_000
const REMINDER_WINDOW_MS = 5 * 60_000

// Small green-ring icon generated locally; embedded so no asset path is needed.
const TRAY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACqSURBVFhH7c6xEcIwEAVRF0FASIW0R0mUYcbp4yzp5EsYtDOb6f5q2xaLX+P5fu09vSnByIhuTONwRrfSODijm8M4dEW3uzhQoY0mHldo4xQPK7UV4lHk7f740jeRtkI8UsOZT9gK8UiNln7AAzWovld7IR6p0f/7wKHhkfihrRCPKrV1iocV2mjicYU2ujhwRbeHcWhGN9M4mNGtaRwe0Y0SjER6s1i0+ADgPOSPWQ3bzQAAAABJRU5ErkJggg=='

let tray: Tray | null = null
let reminderTimer: ReturnType<typeof setInterval> | null = null
const notifiedReminders = new Set<string>()

export function shortcutPath(): string {
  return join(app.getPath('desktop'), SHORTCUT_NAME)
}

export function shortcutExists(): boolean {
  return existsSync(shortcutPath())
}

export function createDesktopShortcut(): string {
  const target = process.execPath
  // In dev, electron.exe needs the project folder as its argument; a packaged
  // app exe launches itself with no argument.
  const args = app.isPackaged ? '' : '.'
  const cwd = app.isPackaged ? dirname(target) : app.getAppPath()
  shell.writeShortcutLink(shortcutPath(), 'update', {
    target,
    args,
    cwd,
    icon: target,
    iconIndex: 0,
    description: 'Strictly local-only virtual assistant'
  })
  return shortcutPath()
}

export function removeDesktopShortcut(): void {
  if (shortcutExists()) rmSync(shortcutPath(), { force: true })
}

export function setupTray(handlers: {
  onShow: () => void
  onOpenRP: () => void
}): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`))
  tray.setToolTip('Virtual Assistant')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show assistant', click: handlers.onShow },
    { label: 'Open ChatRP', click: handlers.onOpenRP },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]))
}

export function registerHotkey(onTrigger: () => void): boolean {
  return globalShortcut.register(HOTKEY, onTrigger)
}

export function hotkeyRegistered(): boolean {
  return globalShortcut.isRegistered(HOTKEY)
}

export function unregisterHotkey(): void {
  globalShortcut.unregister(HOTKEY)
}

function checkReminders(): void {
  const now = Date.now()
  for (const reminder of store.listReminders()) {
    if (!reminder.fireAt || notifiedReminders.has(reminder.id)) continue
    const fireAt = Date.parse(reminder.fireAt)
    if (!Number.isFinite(fireAt) || fireAt > now || now - fireAt > REMINDER_WINDOW_MS) continue
    notifiedReminders.add(reminder.id)
    new Notification({ title: 'Reminder', body: reminder.title, icon: nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`) }).show()
  }
}

export function startReminders(): void {
  checkReminders()
  if (!reminderTimer) reminderTimer = setInterval(checkReminders, REMINDER_INTERVAL_MS)
}

export function stopReminders(): void {
  if (reminderTimer) clearInterval(reminderTimer)
  reminderTimer = null
}

export function getTheme(): 'dark' | 'light' {
  return store.getSetting('ui.theme') === 'light' ? 'light' : 'dark'
}

export function setTheme(theme: 'dark' | 'light'): void {
  store.setSetting('ui.theme', theme)
}

export function backupData(): string {
  const payload = store.buildBackupPayload(BUILD_VERSION)
  const result = dialog.showSaveDialogSync({
    title: 'Back up local data',
    defaultPath: `virtual-assistant-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON backup', extensions: ['json'] }]
  })
  if (!result) return ''
  writeFileSync(result, JSON.stringify(payload, null, 2), 'utf8')
  return result
}

export function restoreData(): BackupSummary | null {
  const files = dialog.showOpenDialogSync({
    title: 'Restore local backup',
    filters: [{ name: 'JSON backup', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (!files || files.length === 0) return null
  const parsed = JSON.parse(readFileSync(files[0], 'utf8')) as unknown
  return store.restoreBackup(parsed)
}

function collectAvatarPaths(payload: BackupPayload): string[] {
  const paths = new Set<string>()
  const setting = payload.settings.find((item) => item.key === 'avatar.config')
  if (setting) {
    try {
      const config = JSON.parse(setting.value) as { vrmPath?: unknown }
      if (typeof config.vrmPath === 'string' && config.vrmPath.trim()) paths.add(config.vrmPath)
    } catch { /* ignore malformed avatar config */ }
  }
  for (const character of payload.characters) {
    if (typeof character.avatarPath === 'string' && character.avatarPath.trim()) paths.add(character.avatarPath)
  }
  return Array.from(paths)
}

interface AvatarAssets {
  avatars: NonNullable<BackupPayload['avatars']>
  avatarFiles: NonNullable<BackupPayload['avatarFiles']>
}

function uniqueAvatarName(sourcePath: string, used: Set<string>): string {
  const raw = basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, '_')
  const base = raw.toLowerCase().endsWith('.vrm') ? raw.slice(0, -4) : raw
  let candidate = `${base}.vrm`
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}.vrm`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/** Collect referenced .vrm files once for both folder bundles and local bridge pushes. */
function collectAvatarAssets(payload: BackupPayload): AvatarAssets {
  const used = new Set<string>()
  const avatars: AvatarAssets['avatars'] = []
  const avatarFiles: AvatarAssets['avatarFiles'] = []
  for (const sourcePath of collectAvatarPaths(payload)) {
    if (isCredentialPath(sourcePath) || !existsSync(sourcePath)) continue
    if (extname(sourcePath).toLowerCase() !== '.vrm') continue
    const fileName = uniqueAvatarName(sourcePath, used)
    avatars.push({ sourcePath, fileName })
    avatarFiles.push({ fileName, dataBase64: readFileSync(sourcePath).toString('base64') })
  }
  return { avatars, avatarFiles }
}

/** Snapshot used by the local phone bridge; VRM bytes are embedded and GGUF bytes stream on demand. */
export async function buildMobilePullPayload(): Promise<BackupPayload> {
  const payload = store.buildBackupPayload(BUILD_VERSION)
  const assets = collectAvatarAssets(payload)
  const models = await listOllamaModelFiles()
  return {
    ...payload,
    avatars: assets.avatars,
    avatarFiles: assets.avatarFiles,
    modelFiles: models.map(({ name, fileName, digest, size }) => ({ name, fileName, digest, size }))
  }
}

/** Export a versioned JSON snapshot plus the actual .vrm files for Android import. */
export function exportMobileBundle(): { path: string; avatars: number } | null {
  const folders = dialog.showOpenDialogSync({
    title: 'Choose a folder for the Android import bundle',
    properties: ['openDirectory', 'createDirectory']
  })
  if (!folders || folders.length === 0) return null

  const folder = folders[0]
  const payload = store.buildBackupPayload(BUILD_VERSION)
  const assets = collectAvatarAssets(payload)
  const avatarFolder = join(folder, 'avatars')
  mkdirSync(avatarFolder, { recursive: true })
  for (const avatar of assets.avatars) {
    copyFileSync(avatar.sourcePath, join(avatarFolder, avatar.fileName))
  }

  const bundle: BackupPayload = {
    ...payload,
    format: 2,
    avatars: assets.avatars,
    avatarFiles: assets.avatarFiles
  }
  const path = join(folder, `virtual-assistant-android-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(path, JSON.stringify(bundle, null, 2), 'utf8')
  return { path, avatars: assets.avatars.length }
}
