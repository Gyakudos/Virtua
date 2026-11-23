import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { INDEXABLE_EXTENSIONS, SKIP_DIRECTORIES, isCredentialPath } from './rag'

export type FileSearchMode = 'name' | 'content' | 'both'

export interface FileSearchOptions {
  query: string
  root?: string
  mode?: FileSearchMode
  extensions?: string[]
  maxResults?: number
}

export interface FileSearchHit {
  path: string
  name: string
  match: 'name' | 'content' | 'both'
  size: number
  modifiedAt: string
  snippet?: string
  line?: number
}

export interface FileSearchResult {
  root: string
  query: string
  mode: FileSearchMode
  scanned: number
  count: number
  truncated: boolean
  hits: FileSearchHit[]
}

const EXTRA_SKIP_DIRECTORIES = new Set([
  'temp', 'crashdumps', '$recycle.bin', 'system volume information', 'cache'
])
const MAX_FILES_SCANNED = 20000
const MAX_DEPTH = 14
const MAX_CONTENT_BYTES = 2_000_000
const MAX_RESULTS = 50
const TIME_BUDGET_MS = 8000
const SNIPPET_RADIUS = 140

function normalizeRoot(input?: string): string {
  const raw = (input ?? '').trim()
  let expanded = raw
  if (raw === '' || raw === '~') expanded = homedir()
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) expanded = join(homedir(), raw.slice(2))

  const root = resolve(expanded)
  if (isCredentialPath(root)) throw new Error('That root is on the local credential deny-list.')
  return root
}

function normalizedExtensions(input: string[] | undefined): string[] {
  return (input ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith('.') ? value : `.${value}`))
}

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + SNIPPET_RADIUS)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/**
 * Local-only filename/text search. Reads no network, writes nothing, and is
 * bounded by file count, depth, size, result count, and a wall-clock budget.
 * Credential-like paths are skipped everywhere, including the chosen root.
 */
export function searchLocalFiles(options: FileSearchOptions): FileSearchResult {
  const query = options.query.trim().toLowerCase()
  if (!query) throw new Error('A search query is required.')

  const root = normalizeRoot(options.root)
  const mode: FileSearchMode = options.mode === 'name' || options.mode === 'content' ? options.mode : 'both'
  const extensions = normalizedExtensions(options.extensions)
  const maxResults = Math.max(1, Math.min(MAX_RESULTS, Math.round(options.maxResults ?? 20)))
  const deadline = Date.now() + TIME_BUDGET_MS
  const hits: FileSearchHit[] = []
  let scanned = 0
  let timedOut = false

  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch {
    throw new Error(`Local path not found: ${root}`)
  }

  const consider = (filePath: string): void => {
    if (isCredentialPath(filePath)) return
    const name = basename(filePath)
    const extension = extname(name).toLowerCase()
    if (extensions.length > 0 && !extensions.includes(extension)) return

    const nameMatch = mode !== 'content' && name.toLowerCase().includes(query)
    let contentMatch = false
    let snippet: string | undefined
    let line: number | undefined

    if (!nameMatch && mode !== 'name' && INDEXABLE_EXTENSIONS.has(extension)) {
      try {
        const info = lstatSync(filePath)
        if (info.size > 0 && info.size <= MAX_CONTENT_BYTES) {
          const text = readFileSync(filePath, 'utf8')
          if (!text.includes('\0')) {
            const index = text.toLowerCase().indexOf(query)
            if (index >= 0) {
              contentMatch = true
              snippet = snippetAround(text, index)
              line = text.slice(0, index).split('\n').length
            }
          }
        }
      } catch {
        // Unreadable files are skipped for a read-only search.
      }
    }

    if (!nameMatch && !contentMatch) return
    hits.push({
      path: filePath,
      name,
      match: nameMatch && contentMatch ? 'both' : nameMatch ? 'name' : 'content',
      size: (() => { try { return lstatSync(filePath).size } catch { return 0 } })(),
      modifiedAt: (() => { try { return lstatSync(filePath).mtime.toISOString() } catch { return '' } })(),
      snippet,
      line
    })
  }

  if (rootStat.isFile()) {
    scanned = 1
    consider(root)
  } else if (rootStat.isDirectory()) {
    const walk = (directory: string, depth: number): void => {
      if (timedOut || depth > MAX_DEPTH || scanned >= MAX_FILES_SCANNED || hits.length >= maxResults) return
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (timedOut || scanned >= MAX_FILES_SCANNED || hits.length >= maxResults) return
        if (Date.now() > deadline) {
          timedOut = true
          return
        }
        const fullPath = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue

        if (entry.isDirectory()) {
          const folder = entry.name.toLowerCase()
          if (SKIP_DIRECTORIES.has(folder) || EXTRA_SKIP_DIRECTORIES.has(folder) || isCredentialPath(fullPath)) continue
          walk(fullPath, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        scanned += 1
        consider(fullPath)
      }
    }
    walk(root, 0)
  } else {
    throw new Error(`Local path is not a file or folder: ${root}`)
  }

  const rank = (hit: FileSearchHit): number => (hit.match === 'both' ? 0 : hit.match === 'name' ? 1 : 2)
  hits.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))

  return {
    root,
    query: options.query.trim(),
    mode,
    scanned,
    count: hits.length,
    truncated: timedOut || scanned >= MAX_FILES_SCANNED || hits.length >= maxResults,
    hits
  }
}
