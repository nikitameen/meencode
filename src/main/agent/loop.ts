import type { AgentEvent, AgentMessage } from '../../shared/types'
import type { AgentMessage as AM, ToolCall, ToolDef } from '../../shared/agent/types'

import type { AgentEventPayload } from '../../shared/types'

export interface LoopDeps {
  chat(
    messages: AgentMessage[],
    tools: ToolDef[],
    signal: AbortSignal,
    cb: { onToken?: (t: string) => void; onThinking?: (t: string) => void }
  ): Promise<{ content: string; toolCalls: ToolCall[] }>
  tools: ToolDef[]
  execute(call: ToolCall): Promise<string>
  emit(e: AgentEventPayload): void
  agent: string
  maxIterations: number
  signal: AbortSignal
  shouldStop?(): boolean
}

export interface LoopResult {
  content: string
  newMessages: AgentMessage[]
  toolCallsMade: number
  /** set when the run was aborted mid-flight; newMessages holds partial learnings */
  aborted?: boolean
  /** set when the run threw; newMessages holds partial learnings gathered so far */
  error?: string
}

const HISTORY_TOOL_CAP = 2500

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n[... truncated]' : s
}

const MAX_HISTORY_CHARS = 80000

export async function runLoop(deps: LoopDeps, system: string, history: AgentMessage[]): Promise<LoopResult> {
  const messages: AgentMessage[] = [{ role: 'system', content: system }, ...history]
  let final = ''
  let toolCallsMade = 0

  const shouldStop = deps.shouldStop ?? (() => false)
  // Internal safety valve only — high enough that normal tasks never hit it.
  const MAX_LOOPS = 1000
  try {
    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      if (shouldStop() || deps.signal.aborted) {
        throw new Error('aborted')
      }
      // Keep the live message window bounded so very long runs do not bloat RAM.
      if (messages.length > 20) {
        const compacted = compactHistoryBytes(messages, 16, MAX_HISTORY_CHARS)
        messages.splice(0, messages.length, { role: 'system', content: system }, ...compacted)
      }

      const res = await deps.chat(messages, deps.tools, deps.signal, {
        onToken: (t) => deps.emit({ type: 'token', text: t }),
        onThinking: (t) => deps.emit({ type: 'thinking', text: t })
      })

      if (shouldStop() || deps.signal.aborted) {
        throw new Error('aborted')
      }

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
          if (shouldStop() || deps.signal.aborted) break
          messages.push(await runOne(call))
        }
      }
      // After consuming tool results, drop bulky intermediate read results
      // that the model is unlikely to need again (read_file, grep, search_files).
      // Keep the last 8 non-system/tool messages + summaries.
      dropStaleReads(messages)
      continue
    }

    final = res.content ?? ''
    if (final) messages.push({ role: 'assistant', content: final })
    // If the assistant returned a final message but also asked the user what to do,
    // it has not finished the task. Force another turn by continuing the loop.
    const asksToStop = /\b(should I continue|do you want me to proceed|shall I continue|want me to continue|what do you think|is this what you wanted|should I go on|need me to continue)\b/i.test(final)
    if (asksToStop) continue
    break
    }
  } catch (e: any) {
    // ABORT or mid-run error: return everything learned so far instead of losing it.
    // The partial history (file reads, greps, sub-agent findings) is merged by
    // the caller, so restarting never re-reads the workspace from scratch.
    return {
      content: '',
      newMessages: messages.slice(1 + history.length),
      toolCallsMade,
      aborted: deps.signal.aborted,
      error: e?.message ?? String(e)
    }
  }

  // messages = [system, ...history, ...newThisRun]; return ONLY this run's messages
  return { content: final, newMessages: messages.slice(1 + history.length), toolCallsMade }
}

export function compactHistory(history: AgentMessage[], keep = 30): AgentMessage[] {
  if (history.length <= keep) return history
  return history.slice(history.length - keep)
}

/**
 * Byte-bounded compaction: keeps recent messages, and strips bulky context
 * blocks (--- ... ---) from OLD user messages — they are re-injected fresh
 * on every new message anyway. Prevents multi-hundred-KB payloads that hang
 * the chat after many prompts.
 */
export function compactHistoryBytes(history: AgentMessage[], keep = 30, maxChars = 60000): AgentMessage[] {
  let h = history.slice(-keep)
  // strip context blocks from all but the newest user message
  const lastUserIdx = (() => {
    for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'user') return i
    return -1
  })()
  h = h.map((m, i) => {
    if (m.role !== 'user' || i === lastUserIdx) return m
    const content = typeof m.content === 'string' ? m.content : m.content
    if (typeof content !== 'string') return m
    const stripped = stripContextBlock(content)
    return { ...m, content: stripped }
  })
  // hard byte cap: drop oldest messages until under budget,
  // but never drop the newest user turn (it carries this turn's context)
  const sizes = h.map(sizeOf)
  let total = sizes.reduce((n, m) => n + m, 0)
  const newestUserIdx = h.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1)
  while (total > maxChars && h.length > 2) {
    // stop dropping if the next drop would eat the newest user turn
    if (h.length - 1 <= newestUserIdx) break
    total -= sizes[0]
    h = h.slice(1)
    sizes.shift()
  }
  // still over budget? truncate bulky non-user messages in place (oldest first)
  if (total > maxChars) {
    for (let i = 0; i < h.length; i++) {
      const m = h[i]
      if (m.role === 'user' || total <= maxChars) continue
      const MARKER = '\n[...truncated]'
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      const budgetForThis = Math.max(200, content.length - (total - maxChars) - MARKER.length)
      const kept = content.slice(0, budgetForThis) + MARKER
      total -= content.length - kept.length
      h[i] = { ...m, content: kept }
    }
  }
  return h
}

function stripContextBlock(content: string): string {
  const idx = content.indexOf('\n\n--- ')
  return idx === -1 ? content : content.slice(0, idx) + '\n\n[context from that turn omitted]'
}

function sizeOf(m: AgentMessage): number {
  return (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) +
    (('tool_calls' in m && m.tool_calls) ? JSON.stringify(m.tool_calls).length : 0)
}

const READ_TOOLS = new Set(['list_dir', 'read_file', 'search_files', 'grep', 'search_codebase'])

/** Drop bulky read-only tool results from the middle of the history, keeping the most recent ones and all assistant/tool-call messages. */
function dropStaleReads(messages: AgentMessage[]): void {
  if (messages.length <= 10) return
  let removed = 0
  // start after system (0) + a small tail budget; stop before the last few messages
  for (let i = 2; i < messages.length - 6 && removed < 4; i++) {
    const m = messages[i]
    if (m.role === 'tool' && READ_TOOLS.has(m.name ?? '')) {
      if (m.content.length > 1200) {
        m.content = m.content.slice(0, 800) + '\n[...older read result truncated to save context]'
        removed++
      }
    }
  }
}