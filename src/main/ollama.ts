import type { AgentMessage, OllamaHealth, OllamaModel, ToolCall } from '../shared/types'

type ChatRole = 'user' | 'assistant' | 'system'
export type ChatTurn = { role: ChatRole; content: string }

const DEFAULT_URL = 'http://127.0.0.1:11434'

export interface ToolChatResult {
  content: string
  toolCalls: ToolCall[]
}

export function getOllamaUrl(): string {
  const configured = process.env.OLLAMA_HOST
  return (configured && configured.trim()) ? configured.trim().replace(/\/$/, '') : DEFAULT_URL
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function getHealth(): Promise<OllamaHealth> {
  const url = getOllamaUrl()
  try {
    const response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2500)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = (await response.json()) as {
      models?: Array<{ name: string; size?: number; modified_at?: string }>
    }

    const models: OllamaModel[] = (data.models ?? []).map((model) => ({
      name: model.name,
      size: model.size,
      modifiedAt: model.modified_at
    }))

    return { status: 'online', models, url }
  } catch (error) {
    return { status: 'offline', url, error: errorMessage(error) }
  }
}

export async function chatOnce(
  model: string,
  messages: ChatTurn[],
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await response.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}

export async function chatStream(
  model: string,
  messages: ChatTurn[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  if (!response.body) throw new Error('Ollama returned no response body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed) as { message?: { content?: string } }
      const content = parsed.message?.content
      if (content) onChunk(content)
    } catch {
      // Ignore malformed or non-JSON lines rather than breaking the stream.
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }

  if (buffer.trim()) consumeLine(buffer)
}

export async function embed(
  model: string,
  input: string | string[],
  signal?: AbortSignal
): Promise<number[][]> {
  const response = await fetch(`${getOllamaUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Ollama embedding failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }

  const data = await response.json() as { embeddings?: number[][] }
  if (!Array.isArray(data.embeddings)) throw new Error('Ollama returned no embeddings')
  return data.embeddings
}

function normalizeArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}

export async function chatStreamWithTools(
  model: string,
  messages: AgentMessage[],
  tools: unknown[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ToolChatResult> {
  const response = await fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, stream: true }),
    signal
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  if (!response.body) throw new Error('Ollama returned no response body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const calls = new Map<number, ToolCall>()

  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed = JSON.parse(trimmed) as {
        message?: {
          content?: string
          tool_calls?: Array<{
            id?: string
            function?: { index?: number; name?: string; arguments?: unknown }
          }>
        }
      }
      const message = parsed.message
      if (!message) return

      if (message.content) {
        content += message.content
        onChunk(message.content)
      }

      for (const call of message.tool_calls ?? []) {
        const index = call.function?.index ?? calls.size
        calls.set(index, {
          id: call.id ?? `call_${index}`,
          function: {
            name: call.function?.name ?? '',
            arguments: normalizeArguments(call.function?.arguments)
          }
        })
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }
  if (buffer.trim()) consumeLine(buffer)

  return {
    content,
    toolCalls: [...calls.keys()].sort((a, b) => a - b).map((key) => calls.get(key)!)
  }
}
