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
  /** return true when the agent's final text is a real completion; false forces another turn.
   *  May set nudge.text to control the forced follow-up message. */
  isComplete?(finalText: string, toolCallsMade: number, nudge: { text: string }): boolean
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

const READ_HISTORY_CAP = 16000   // read_file results must stay usable for edit_file's old_string
const SEARCH_HISTORY_CAP = 2500  // grep/search hits are pointers, not content
const GENERIC_HISTORY_CAP = 4000

/** Per-tool history budget: a truncated read makes edit_file fail with
 *  "old_string not found", so reads keep far more context than searches. */
function historyCapFor(toolName: string): number {
  if (toolName === 'read_file') return READ_HISTORY_CAP
  if (toolName === 'grep' || toolName === 'search_files' || toolName === 'search_codebase' || toolName === 'list_dir') return SEARCH_HISTORY_CAP
  return GENERIC_HISTORY_CAP
}

function fuzzyToolName(name: string, tools: ToolDef[]): string | null {
  const n = name.trim().toLowerCase()
  // strip common prefixes/suffixes models add
  const clean = n.replace(/^functions\./, '').replace(/:\d+$/, '').replace(/-/g, '_')
  // exact match after normalization
  const exact = tools.find((t) => t.name.toLowerCase() === clean)
  if (exact) return exact.name
  // known aliases
  const aliases: Record<string, string> = {
    listdir: 'list_dir', ls: 'list_dir',
    readfile: 'read_file', read: 'read_file',
    writefile: 'write_file', write: 'write_file',
    editfile: 'edit_file', edit: 'edit_file',
    deletefile: 'delete_file', delete: 'delete_file',
    searchfiles: 'search_files', findfiles: 'search_files',
    searchcodebase: 'search_codebase', search_code_base: 'search_codebase', codebase_search: 'search_codebase', codebasesearch: 'search_codebase',
    comparescreenshots: 'compare_screenshots',
    runcmd: 'run_command', runcommand: 'run_command', execute_command: 'run_command'
  }
  if (aliases[clean]) return aliases[clean]
  // substring match: e.g. "agent_read_file" -> "read_file"
  for (const t of tools) {
    const tn = t.name.toLowerCase()
    if (clean.includes(tn) || tn.includes(clean)) return t.name
  }
  return null
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n[... truncated]' : s
}

const MAX_HISTORY_CHARS = 80000

export async function runLoop(deps: LoopDeps, system: string, history: AgentMessage[]): Promise<LoopResult> {
  const messages: AgentMessage[] = [{ role: 'system', content: system }, ...history]
  let final = ''
  let toolCallsMade = 0

  const shouldStop = deps.shouldStop ?? (() => false)
  // The model decides when it is done by simply not calling tools anymore —
  // like Cursor. The loop NEVER ends for artificial reasons: the iteration
  // cap pushes a "continue" nudge and keeps working (hard safety cap only),
  // empty turns retry, stalls retry. Only the user (Stop) or the model
  // (a real final answer) end a run.
  const maxLoops = Math.max(1, deps.maxIterations || 16)
  const HARD_CAP = maxLoops * 4 // runaway safety net, far beyond any real task
  let nudgesGiven = 0
  let nudgeUsed = false

  // STALL / EMPTY-TURN RECOVERY: a turn that produces no text AND no tool
  // calls used to be treated as a normal completion — the agent silently
  // stopped after ~15s when a model died mid-think. Now: retry, and only
  // end with a VISIBLE error after repeated failures.
  const MAX_EMPTY_RETRIES = 2
  let emptyTurns = 0
  const chat = async (msgs: AgentMessage[]) => {
    for (let attempt = 0; ; attempt++) {
      if (shouldStop() || deps.signal.aborted) throw new Error('aborted')
      try {
        return await deps.chat(msgs, deps.tools, deps.signal, {
          onToken: (t) => deps.emit({ type: 'token', text: t }),
          onThinking: (t) => deps.emit({ type: 'thinking', text: t })
        })
      } catch (e: any) {
        if (shouldStop() || deps.signal.aborted) throw new Error('aborted')
        const retryable = e?.name === 'StreamStallError' || e?.name === 'AbortError' ||
          /fetch failed|network|socket|ECONN|terminated/i.test(String(e?.message ?? ''))
        if (attempt < 2 && retryable) continue
        throw e
      }
    }
  }

  try {
    for (let loop = 0; loop < HARD_CAP; loop++) {
      if (shouldStop() || deps.signal.aborted) {
        throw new Error('aborted')
      }
      // Keep the live message window bounded so very long runs do not bloat RAM.
      if (messages.length > 20) {
        const compacted = compactHistoryBytes(messages, 16, MAX_HISTORY_CHARS)
        messages.splice(0, messages.length, { role: 'system', content: system }, ...compacted)
      }

      // Beyond the configured iteration budget the run does NOT stop — it
      // nudges the model to finish and continues to the hard cap. Real work
      // keeps going; only the user or a genuine final answer end the run.
      if (loop >= maxLoops && nudgesGiven < 2) {
        nudgesGiven++
        messages.push({ role: 'user', content: 'You are taking many steps. Finish the task now: apply the remaining edits, verify, and reply with the final result. Do not stop mid-task.' })
      }

      const res = await chat(messages)

      if (shouldStop() || deps.signal.aborted) {
        throw new Error('aborted')
      }

    if (res.toolCalls.length > 0) {
      emptyTurns = 0
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
          // If the model called a tool by a weird name, try once with a fuzzy match.
          if (typeof result === 'string' && result.startsWith('Error: unknown tool')) {
            const fixed = fuzzyToolName(call.name, deps.tools)
            if (fixed && fixed !== call.name) {
              result = await deps.execute({ ...call, name: fixed })
            }
          }
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
        return { role: 'tool' as const, tool_call_id: call.id, name: call.name, content: truncate(result, historyCapFor(call.name)) }
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

    // EMPTY-TURN GUARD: no text and no tool calls = the model died mid-think
    // or the provider returned nothing. This is NOT a completion. Nudge and
    // retry; only a long streak of empties ends the run — with a VISIBLE
    // error, never a silent stop.
    if (!final && res.toolCalls.length === 0) {
      emptyTurns++
      if (emptyTurns <= MAX_EMPTY_RETRIES) {
        if (emptyTurns === MAX_EMPTY_RETRIES) {
          messages.push({ role: 'user', content: 'Your last response was empty. Continue the task now: call a tool or answer. Do not return an empty reply.' })
        }
        continue
      }
      throw new Error('The model returned empty responses repeatedly (connection may be stalling). Try again, switch the model in Settings, or check your network.')
    }
    emptyTurns = 0

    if (final) messages.push({ role: 'assistant', content: final })
    // The model chose not to call any tools: normally final. isComplete may
    // force exactly ONE retry with a specific nudge (e.g. "apply your code").
    const nudge: { text: string } = { text: '' }
    const complete = deps.isComplete?.(final, toolCallsMade, nudge) ?? true
    if (complete || nudgeUsed) break
    nudgeUsed = true
    messages.push({ role: 'user', content: nudge.text || 'Apply the change now using your file tools. Do not answer with code in chat.' })
    continue
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

  // If we exit the loop via the hard cap without a real final answer, say so
  // — never end silently. The user sees exactly why the run paused.
  if (!final && !deps.signal.aborted) {
    return {
      content: '',
      newMessages: messages.slice(1 + history.length),
      toolCallsMade,
      error: `Run paused after ${HARD_CAP} steps without a final answer. Everything done so far is kept in context — tell the agent to continue and it picks up where it left off.`
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

const READ_TOOLS = new Set(['list_dir', 'search_files', 'grep', 'search_codebase'])
// NOTE: read_file results are never truncated here — edit_file needs the full
// text to build exact old_string matches. Only pointer-style results shrink.

/** Shrink bulky search/list results from the middle of the history, keeping the most recent ones and all assistant/tool-call messages. */
function dropStaleReads(messages: AgentMessage[]): void {
  if (messages.length <= 10) return
  let removed = 0
  // start after system (0) + a small tail budget; stop before the last few messages
  for (let i = 2; i < messages.length - 8 && removed < 2; i++) {
    const m = messages[i]
    if (m.role === 'tool' && READ_TOOLS.has(m.name ?? '')) {
      if (m.content.length > 2500) {
        m.content = m.content.slice(0, 1800) + '\n[...older search result truncated to save context]'
        removed++
      }
    }
  }
}