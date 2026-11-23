import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { app, clipboard, nativeImage } from 'electron'
import type { OcrResult } from '../shared/types'
import { ocrImage } from './ocr'
import { isCredentialPath } from './rag'
import * as store from './storage'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'])

function captureDirectory(): string {
  return join(app.getPath('userData'), 'captures')
}

/** Read the image currently on the clipboard with local OCR, saving it locally. */
export async function ocrClipboard(): Promise<OcrResult> {
  const items = await clipboard.read()
  let png: Buffer | null = null
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (!imageType) continue
    const blob = await item.getType(imageType) as Blob
    png = Buffer.from(await blob.arrayBuffer())
    break
  }
  if (!png) throw new Error('There is no image on the clipboard.')

  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) throw new Error('The clipboard image could not be read.')

  const size = image.getSize()
  const directory = captureDirectory()
  mkdirSync(directory, { recursive: true })
  const safeId = `paste-${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  const imagePath = join(directory, `${safeId}.png`)
  writeFileSync(imagePath, image.toPNG())

  const text = await ocrImage(imagePath)
  store.logTool('images.ocr', { source: 'clipboard', imagePath }, true, `chars=${text.length}`)
  return { text, imagePath, width: size.width, height: size.height }
}

/** Read text from an existing local image file with local OCR. */
export async function ocrFile(inputPath: string): Promise<OcrResult> {
  const raw = (inputPath ?? '').trim()
  if (!raw) throw new Error('An image path is required.')
  const expanded = raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw
  const imagePath = resolve(expanded)
  if (isCredentialPath(imagePath)) throw new Error('That image path is on the credential deny-list.')
  if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`)
  if (!IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())) {
    throw new Error('Supported image formats: .png, .jpg, .jpeg, .bmp, .gif, .webp')
  }
  if (!statSync(imagePath).isFile()) throw new Error('That path is not a file.')

  const text = await ocrImage(imagePath)
  store.logTool('images.ocr', { source: 'file', imagePath }, true, `chars=${text.length}`)
  return { text, imagePath }
}
