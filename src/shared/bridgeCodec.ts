const TYPED_ARRAY_NAMES = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'
])

type BinaryMarker = { __vaBinary: string; type: string; data: string }

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let index = 0; index < bytes.length; index += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)))
  }
  return btoa(parts.join(''))
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function isBinaryMarker(value: unknown): value is BinaryMarker {
  if (!value || typeof value !== 'object') return false
  const marker = value as Partial<BinaryMarker>
  return marker.__vaBinary === '1' && typeof marker.type === 'string' && typeof marker.data === 'string'
}

/** JSON-safe encoding that preserves typed arrays used by VRM bytes, audio, and Whisper samples. */
export function encodeValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return { __vaBinary: '1', type: value.constructor.name, data: toBase64(bytes) } satisfies BinaryMarker
  }
  if (value instanceof ArrayBuffer) {
    return { __vaBinary: '1', type: 'ArrayBuffer', data: toBase64(new Uint8Array(value)) } satisfies BinaryMarker
  }
  if (Array.isArray(value)) return value.map(encodeValue)
  const encoded: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue
    encoded[key] = encodeValue(item)
  }
  return encoded
}

/** Reverse of encodeValue. */
export function decodeValue(value: unknown): any {
  if (isBinaryMarker(value)) {
    const bytes = fromBase64(value.data)
    if (value.type === 'ArrayBuffer') {
      const copy = new Uint8Array(bytes.length)
      copy.set(bytes)
      return copy.buffer
    }
    if (!TYPED_ARRAY_NAMES.has(value.type)) return bytes
    const Constructor = (globalThis as Record<string, unknown>)[value.type] as
      (new (buffer: ArrayBufferLike) => ArrayBufferView) | undefined
    if (!Constructor) return bytes
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    return new Constructor(copy.buffer)
  }
  if (Array.isArray(value)) return value.map(decodeValue)
  if (value && typeof value === 'object') {
    const decoded: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) decoded[key] = decodeValue(item)
    return decoded
  }
  return value
}

/** Extract function-valued handler arguments into names plus a serializable placeholder. */
export function extractHandlers(args: unknown[]): { args: unknown[]; handlers: string[] } {
  const handlers: string[] = []
  const clean = args.map((arg) => {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return arg
    const names = Object.entries(arg).filter(([, value]) => typeof value === 'function').map(([name]) => name)
    if (names.length === 0) return arg
    handlers.push(...names)
    return { __vaHandlers: names }
  })
  return { args: clean, handlers }
}
