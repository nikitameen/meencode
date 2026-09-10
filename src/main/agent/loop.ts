import type { AgentEvent, AgentMessage } from '../../shared/types'
import type { AgentMessage as AM, ToolCall, ToolDef } from '../../shared/agent/types'

export interface LoopDeps {
  chat(
    messages: AgentMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
    cb: { onToken?: (t: string) => void; onThinking?: (t: string) => void }
  ): Promise<{ content: string; toolCalls: ToolCall[] }>
  tools: ToolDef[]
  execute(call: ToolCall): Promise<string>
  emit(e: AgentEvent): void
  agent: string
  maxIterations: number
  signal: AbortSignal
}

export interface LoopResult {
  content: string
  newMessages: AgentMessage[]
  toolCallsMade: number
}

const HISTORY_TOOL_CAP = 2500

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n[... truncated]' : s
}

export async function runLoop(deps: LoopDeps, system: string, history: AgentMessage[]): Promise<LoopResult> {
  const messages: AgentMessage[] = [{ role: 'system', content: system }, ...history]
  let final = ''
  let toolCallsMade = 0
  const t0 = Date.now()

  for (let i = 0; i < deps.maxIterations; i++) {
    const res = await deps.chat(messages, deps.tools, deps.signal, {
      onToken: (t) => deps.emit({ type: 'token', text: t }),
      onThinking: (t) => deps.emit({ type: 'thinking', text: t })
    })

    if (res.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: res.content ?? '',
        tool_calls: res.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }))
      })
      toolCallsMade += res.toolCalls.length

      // PARALLEL execution: batched tool calls run concurrently.
      // - read tools are always safe
      // - spawn_agent calls are safe when they target DIFFERENT sub-agents (independent work)
      const safeKinds = new Set(['list_dir', 'read_file', 'search_files', 'grep'])
      const seenAgents = new Set<string>()
      let spawnsConflict = false
      for (const c of res.toolCalls) {
        if (c.name === 'spawn_agent') {
          const target = String((c.args as any)?.agent ?? '')
          if (seenAgents.has(target)) spawnsConflict = true
          seenAgents.add(target)
        }
      }
      const canParallel =
        res.toolCalls.every((c) => safeKinds.has(c.name)) ||
        (!spawnsConflict && res.toolCalls.every((c) => safeKinds.has(c.name) || c.name === 'spawn_agent'))
      const runOne = async (call: ToolCall) => {
        const ts = Date.now()
        deps.emit({ type: 'tool_start', id: call.id, agent: deps.agent, name: call.name, args: call.args })
        let result = ''
        let ok = true
        try {
          result = await deps.execute(call)
        } catch (e: any) {
          ok = false
          result = `Error: ${e?.message ?? String(e)}`
        }
        deps.emit({
          type: 'tool_end',
          id: call.id,
          agent: deps.agent,
          name: call.name,
          ok,
          result: truncate(result, 4000),
          ms: Date.now() - ts
        })
        return { role: 'tool' as const, tool_call_id: call.id, name: call.name, content: truncate(result, HISTORY_TOOL_CAP) }
      }

      if (canParallel && res.toolCalls.length > 1) {
        const results = await Promise.all(res.toolCalls.map(runOne))
        messages.push(...results)
      } else {
        for (const call of res.toolCalls) {
          messages.push(await runOne(call))
        }
      }
      continue
    }

    final = res.content ?? ''
    if (final) messages.push({ role: 'assistant', content: final })
    break
  }

  if (!final) {
    final = `(Reached max tool iterations — ${deps.maxIterations}. Elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s. Ask me to continue.)`
    messages.push({ role: 'assistant', content: final })
  }

  return { content: final, newMessages: messages.slice(1), toolCallsMade }
}

export function compactHistory(history: AgentMessage[], keep = 30): AgentMessage[] {
  if (history.length <= keep) return history
  return history.slice(history.length - keep)
}