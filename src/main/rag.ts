import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { RagHandlers, RagProgress, RagResult, RagSource } from '../shared/types'
import { embed } from './ollama'
import * as store from './storage'

export const EMBED_MODEL = 'nomic-embed-text'

export const INDEXABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.csv', '.json', '.jsonl',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift',
  '.sql', '.css', '.scss', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini'
])

export const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', 'release',
  'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target',
  'bin', 'obj', '.next', '.nuxt', '.cache', 'AppData'
])

const CREDENTIAL_NAMES = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.git-credentials', '.npmrc', '.pypirc',
  '.env', 'id_rsa', 'id_ed25519', 'credentials', 'credential', 'secrets',
  'login data', 'keychain', 'password', 'passwords', 'tokens', 'token',
  'config.json'
])

const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 2000
const MAX_DEPTH = 12
const CHUNK_SIZE = 1400
const CHUNK_OVERLAP = 200
const EMBED_BATCH_SIZE = 16
const MIN_SCORE = 0.2

interface ScannedFile {
  path: string
  title: string
  hash: string
  content: string
}

export function isCredentialPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => CREDENTIAL_NAMES.has(part.trim().toLowerCase()))
}

function scanFolder(root: string, signal: AbortSignal): ScannedFile[] {
  const files: ScannedFile[] = []

  const walk = (directory: string, depth: number): void => {
    if (signal.aborted || depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (signal.aborted || files.length >= MAX_FILES) return
      const fullPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase()) && !isCredentialPath(fullPath)) {
          walk(fullPath, depth + 1)
        }
        continue
      }
      if (!entry.isFile() || isCredentialPath(fullPath)) continue
      if (!INDEXABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

      try {
        const info = lstatSync(fullPath)
        if (info.size > MAX_FILE_BYTES || info.size === 0) continue
        const content = readFileSync(fullPath, 'utf8')
        if (content.includes('\0')) continue
        files.push({
          path: fullPath,
          title: basename(fullPath),
          hash: createHash('sha256').update(content).digest('hex'),
          content
        })
      } catch {
        // Unreadable files are skipped rather than failing the whole index.
      }
    }
  }

  walk(root, 0)
  return files
}

function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length)
    if (end < normalized.length) {
      const window = normalized.slice(start, end)
      const lastBreak = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '))
      if (lastBreak > CHUNK_SIZE * 0.5) end = start + lastBreak + 1
    }
    const piece = normalized.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= normalized.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP)
  }
  return chunks
}

function toBuffer(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer)
}

function toVector(blob: Uint8Array): Float32Array {
  const bytes = new Uint8Array(blob.length)
  bytes.set(blob)
  return new Float32Array(bytes.buffer)
}

export async function indexFolder(
  folderPath: string,
  requestId: string,
  handlers: RagHandlers,
  signal: AbortSignal
): Promise<RagSource> {
  const root = resolve(folderPath)
  if (isCredentialPath(root)) throw new Error('That folder is on the credential deny-list and cannot be indexed.')

  const source = store.upsertRagSource(root, basename(root))
  const report = (phase: RagProgress['phase'], current: number, total: number, message: string): void => {
    handlers.onProgress({ requestId, phase, current, total, message })
  }

  try {
    report('scanning', 0, 0, `Scanning ${basename(root)}…`)
    const scanned = scanFolder(root, signal)
    if (signal.aborted) throw new Error('Indexing cancelled')
    report('scanning', scanned.length, scanned.length, `Found ${scanned.length} indexable files`)

    const existing = new Map(store.listRagDocuments(source.id).map((doc) => [doc.path, doc.hash]))
    const seenPaths = new Set<string>()
    const changed = scanned.filter((file) => {
      seenPaths.add(file.path)
      return existing.get(file.path) !== file.hash
    })

    for (const doc of store.listRagDocuments(source.id)) {
      if (!seenPaths.has(doc.path)) store.deleteRagDocument(doc.id)
    }

    report('embedding', 0, changed.length, `Embedding ${changed.length} changed files…`)
    for (let index = 0; index < changed.length; index += 1) {
      if (signal.aborted) throw new Error('Indexing cancelled')
      const file = changed[index]
      const chunks = chunkText(file.content)
      if (chunks.length === 0) continue

      const vectors: number[][] = []
      for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
        if (signal.aborted) throw new Error('Indexing cancelled')
        const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE)
        const embedded = await embed(EMBED_MODEL, batch, signal)
        vectors.push(...embedded)
      }
      if (vectors.length !== chunks.length) throw new Error(`Embedding count mismatch for ${file.title}`)

      store.replaceRagDocument(source.id, {
        path: file.path,
        hash: file.hash,
        title: file.title,
        chunks: chunks.map((content, chunkIndex) => ({
          index: chunkIndex,
          content,
          embedding: toBuffer(vectors[chunkIndex])
        }))
      })
      report('embedding', index + 1, changed.length, `Embedded ${file.title}`)
    }

    store.refreshRagSourceCounts(source.id)
    store.setRagSourceStatus(source.id, 'idle')
    report('done', changed.length, changed.length, 'Indexing complete')
    handlers.onDone()
    return store.listRagSources().find((item) => item.id === source.id) ?? source
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.refreshRagSourceCounts(source.id)
    store.setRagSourceStatus(source.id, 'error', message)
    report('error', 0, 0, message)
    handlers.onError(message)
    throw error
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export async function retrieve(
  query: string,
  topK = 4,
  sourceIds?: string[]
): Promise<RagResult[]> {
  if (!query.trim()) return []
  const chunks = store.listRagChunks(sourceIds)
  if (chunks.length === 0) return []

  const [queryVector] = await embed(EMBED_MODEL, query.trim())
  if (!queryVector) return []
  const vector = Float32Array.from(queryVector)

  const ranked = chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(vector, toVector(chunk.embedding)) }))
    .filter((item) => item.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)

  const perFile = new Map<string, number>()
  const results: RagResult[] = []
  for (const item of ranked) {
    const count = perFile.get(item.chunk.path) ?? 0
    if (count >= 2) continue
    perFile.set(item.chunk.path, count + 1)
    results.push({
      chunkId: item.chunk.id,
      sourceId: item.chunk.source_id,
      path: item.chunk.path,
      title: item.chunk.title,
      snippet: item.chunk.content.slice(0, 700),
      score: Number(item.score.toFixed(4))
    })
    if (results.length >= topK) break
  }
  return results
}
