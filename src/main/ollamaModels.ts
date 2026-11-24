import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { getHealth } from './ollama'

const DEFAULT_ROOT = join(homedir(), '.ollama', 'models')
const MODEL_LAYER = 'application/vnd.ollama.image.model'
const DIGEST = /^sha256:[a-f0-9]{64}$/i

export interface OllamaModelFile {
  /** Ollama model name as shown by /api/tags, e.g. qwen2.5:3b-instruct. */
  name: string
  /** Safe Android file name, including a short digest so repeat syncs dedupe. */
  fileName: string
  digest: string
  size: number
  /** Local GGUF blob path; never sent to the phone. */
  sourcePath: string
}

function modelsRoot(): string {
  return process.env.OLLAMA_MODELS?.trim() || DEFAULT_ROOT
}

function isSegment(value: string): boolean {
  return Boolean(value) && value !== '.' && value !== '..' && !/[\\/]/.test(value)
}

/** Resolve an Ollama model name to its manifest without allowing path traversal. */
function manifestFor(name: string): string | null {
  const raw = name.trim()
  if (!raw || raw.includes('\\') || raw.includes('..')) return null
  const colon = raw.indexOf(':')
  if (colon < 0 || colon !== raw.lastIndexOf(':')) return null
  const modelPart = raw.slice(0, colon)
  const tag = raw.slice(colon + 1)
  if (!isSegment(tag)) return null

  const parts = modelPart.split('/').filter(Boolean)
  if (parts.length < 1 || parts.length > 3 || !parts.every(isSegment)) return null

  const root = resolve(modelsRoot(), 'manifests')
  const path = parts.length === 1
    ? join(root, 'registry.ollama.ai', 'library', parts[0], tag)
    : parts.length === 2
      ? join(root, 'registry.ollama.ai', parts[0], parts[1], tag)
      : join(root, parts[0], parts[1], parts[2], tag)

  const resolved = resolve(path)
  return resolved.startsWith(root + sep) ? resolved : null
}

function safeFileName(name: string, digest: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'model'
  const short = digest.slice(7, 19)
  return `${clean}-${short}.gguf`
}

/** Resolve one installed Ollama model to its GGUF blob. Returns null for non-GGUF/missing models. */
export function resolveOllamaModel(name: string): OllamaModelFile | null {
  const manifestPath = manifestFor(name)
  if (!manifestPath || !existsSync(manifestPath)) return null

  let manifest: { layers?: Array<{ mediaType?: string; digest?: string }> }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch {
    return null
  }

  const layer = manifest.layers?.find((item) => item.mediaType === MODEL_LAYER)
  const digest = layer?.digest
  if (!digest || !DIGEST.test(digest)) return null

  const root = resolve(modelsRoot())
  const sourcePath = resolve(join(root, 'blobs', digest.replace(':', '-')))
  if (!sourcePath.startsWith(root + sep) || !existsSync(sourcePath)) return null

  return {
    name: name.trim(),
    fileName: safeFileName(name, digest),
    digest,
    size: statSync(sourcePath).size,
    sourcePath
  }
}

/** All installed Ollama models that can be copied to the phone as GGUF files. */
export async function listOllamaModelFiles(): Promise<OllamaModelFile[]> {
  const health = await getHealth()
  if (health.status !== 'online') return []
  const files: OllamaModelFile[] = []
  const seen = new Set<string>()
  for (const model of health.models) {
    const file = resolveOllamaModel(model.name)
    if (!file || seen.has(file.digest)) continue
    seen.add(file.digest)
    files.push(file)
  }
  return files
}
