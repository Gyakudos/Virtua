type NativeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

interface VirtuaNativeBridge {
  call(method: string, argsJson: string, callbackId: string): void
}

declare global {
  interface Window {
    VirtuaNative?: VirtuaNativeBridge
    __virtuaNativeCallback?: (callbackId: string, result: NativeResult<unknown>) => void
  }
}

const pending = new Map<string, {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}>()

let sequence = 0

window.__virtuaNativeCallback = (callbackId, result) => {
  const entry = pending.get(callbackId)
  if (!entry) return
  pending.delete(callbackId)
  if (result?.ok === true) entry.resolve(result.value)
  else entry.reject(new Error(result?.error || 'Android bridge call failed.'))
}

export function nativeAvailable(): boolean {
  return typeof window.VirtuaNative?.call === 'function'
}

export function callNative<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!nativeAvailable()) {
    return Promise.reject(new Error('Android native bridge is not available. Open this build inside the Virtua app.'))
  }
  const callbackId = `va-${Date.now()}-${sequence++}`
  return new Promise<T>((resolve, reject) => {
    pending.set(callbackId, {
      resolve: (value) => resolve(value as T),
      reject
    })
    try {
      window.VirtuaNative?.call(method, JSON.stringify(args), callbackId)
    } catch (error) {
      pending.delete(callbackId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
