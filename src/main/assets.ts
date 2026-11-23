import { join } from 'node:path'
import { app } from 'electron'

/**
 * Resolve a bundled local asset in both development and packaged builds.
 * Packaged assets are copied to `resources/assets` by electron-builder.
 */
export function localAssetPath(...segments: string[]): string {
  if (app.isPackaged) return join(process.resourcesPath, 'assets', ...segments)
  return join(__dirname, '..', '..', 'assets', ...segments)
}
