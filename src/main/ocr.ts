import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { createWorker } from 'tesseract.js'
import { localAssetPath } from './assets'

/**
 * Local-only OCR using the pre-seeded English traineddata in assets/ocr.
 * No download, no service, no upload — the image path stays on this device.
 */
export async function ocrImage(imagePath: string): Promise<string> {
  const langPath = process.env.VA_OCR_PATH ?? localAssetPath('ocr')
  if (!existsSync(join(langPath, 'eng.traineddata.gz'))) {
    throw new Error('Local OCR language data is missing (assets/ocr/eng.traineddata.gz).')
  }

  const worker = await createWorker('eng', 1, {
    langPath,
    cachePath: join(app.getPath('userData'), 'tessdata'),
    logger: () => {}
  })
  try {
    const result = await worker.recognize(imagePath)
    return result.data.text
  } finally {
    await worker.terminate()
  }
}
