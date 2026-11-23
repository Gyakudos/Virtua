import type { AgentMessage, PendingApproval, ToolActivity } from '../shared/types'
import { chatStreamWithTools } from './ollama'
import * as store from './storage'
import { executeTool, findTool, toolSpecs } from './tools'

export interface AgentRunOptions {
  requestId: string
  model: string
  messages: AgentMessage[]
  signal: AbortSignal
  sendChunk: (chunk: string) => void
  sendTool: (activity: ToolActivity) => void
  requestApproval: (approval: PendingApproval) => Promise<boolean>
}

const MAX_ROUNDS = 8

export async function runAgent(options: AgentRunOptions): Promise<void> {
  const working: AgentMessage[] = [...options.messages]

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await chatStreamWithTools(
      options.model,
      working,
      toolSpecs,
      options.sendChunk,
      options.signal
    )

    if (result.toolCalls.length === 0) return

    for (const call of result.toolCalls) {
      options.sendTool({
        callId: call.id,
        tool: call.function.name,
        args: call.function.arguments,
        status: 'calling'
      })
    }

    const outcomes: Array<{ call: typeof result.toolCalls[number]; resultText: string }> = []

    for (const call of result.toolCalls) {
      const tool = findTool(call.function.name)
      const risk = tool?.risk ?? 'sensitive'
      const approved = risk === 'safe' ? true : await options.requestApproval({
        callId: call.id,
        tool: call.function.name,
        args: call.function.arguments,
        risk
      })

      let resultText: string
      if (!approved) {
        resultText = JSON.stringify({ error: 'Denied by user' })
      } else {
        try {
          const value = await executeTool(call.function.name, call.function.arguments)
          resultText = JSON.stringify(value ?? { ok: true })
        } catch (error) {
          resultText = JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      store.logTool(call.function.name, call.function.arguments, approved, resultText)
      options.sendTool({
        callId: call.id,
        tool: call.function.name,
        args: call.function.arguments,
        status: approved ? 'done' : 'denied',
        result: resultText
      })
      outcomes.push({ call, resultText })
    }

    working.push({ role: 'assistant', content: '', tool_calls: result.toolCalls })
    for (const outcome of outcomes) {
      working.push({ role: 'tool', content: outcome.resultText })
    }
  }

  throw new Error('Agent reached the maximum number of tool rounds')
}
