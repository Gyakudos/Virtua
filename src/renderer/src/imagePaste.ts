export interface PastedImageInsert {
  text: string
  message: string
}

export function clipboardHasImage(data: DataTransfer | null): boolean {
  if (!data) return false
  return Array.from(data.items).some((item) => item.type.startsWith('image/'))
}

function cleanOcr(text: string): string {
  return text.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 4000)
}

/** OCR a pasted clipboard image and return text ready to append to a composer. */
export async function insertPastedImage(current: string): Promise<PastedImageInsert> {
  const result = await window.api.images.ocrClipboard()
  const ocr = cleanOcr(result.text)
  const dimensions = result.width && result.height ? `, ${result.width}x${result.height}` : ''
  const block = [
    `[Pasted image: ${result.imagePath}${dimensions}]`,
    ocr ? `OCR text:\n${ocr}` : 'No text detected in this image.',
    ''
  ].join('\n')
  const text = current.trim() ? `${current.replace(/\s+$/, '')}\n\n${block}` : block
  return {
    text,
    message: ocr
      ? `Read ${ocr.length} characters from the pasted image (local OCR).`
      : 'Pasted image saved locally; no text detected.'
  }
}
