import type { AgentMessage, ToolCall, ToolDef } from '../../shared/agent/types'
import { proxySafeFetch } from '../proxyFetch'

export type ChatResult = { content: string; toolCalls: ToolCall[] }

export interface StreamCallbacks {
  onToken?: (t: string) => void
  onThinking?: (t: string) => void
}

/** Error thrown when the stream produces no bytes for too long (dead connection). */
export class StreamStallError extends Error {
  constructor(public idleMs: number) {
    super(`Model stream stalled: no data for ${idleMs}ms`)
    this.name = 'StreamStallError'
  }
}

const STREAM_IDLE_TIMEOUT_MS = 90_000

export class OllamaCloudClient {
  private url: string
  private headers: Record<string, string>

  constructor(cfg: { apiKey: string; baseUrl: string; model: string }) {
    let base = cfg.baseUrl.replace(/\/+$/, '')
    if (base.endsWith('/v1/chat/completions')) {
      this.url = base
    } else if (base.endsWith('/v1')) {
      this.url = base + '/chat/completions'
    } else {
      this.url = base + '/v1/chat/completions'
    }
    this.headers = {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'x-meencode-model': cfg.model
    }
  }

  async chat(messages: AgentMessage[], tools: ToolDef[], signal: AbortSignal, cb: StreamCallbacks): Promise<ChatResult> {
    const model = this.headers['x-meencode-model']
    const payload = {
      model,
      messages,
      stream: true,
      ...(tools.length > 0 ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {})
    }

    // Layered abort: the caller's signal (user Stop) OR our inactivity watchdog.
    const internal = new AbortController()
    const forward = () => internal.abort()
    if (signal.aborted) internal.abort()
    signal.addEventListener('abort', forward, { once: true })

    let res: Response
    try {
      res = await proxySafeFetch(this.url, {
        method: 'POST',
        headers: { Authorization: this.headers.Authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: internal.signal,
        redirect: 'follow'
      })
    } finally {
      signal.removeEventListener('abort', forward)
    }

    if (res.redirected && res.url && !res.url.includes('/v1/chat/completions')) {
      throw new Error(`The API base URL redirected to ${res.url}. Open Settings and set the Base URL to https://ollama.com`)
    }
    if (res.status === 405) {
      throw new Error(`Server answered 405 Method Not Allowed. Open Settings and set the Base URL to https://ollama.com (api.ollama.com redirects and breaks streaming).`)
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Invalid or missing API key. Verify your key in Settings.')
    }
    if (res.status === 404) {
      throw new Error(`Model "${model}" was not found on provider endpoint. Pick another model in Settings.`)
    }
    if (res.status === 429) {
      throw new Error('Rate limited (429) by the provider. Wait a moment and send the message again.')
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`API provider error ${res.status}: ${t.slice(0, 300)}`)
    }

    try {
      return await parseSSE(res.body!, cb, { signal, internal })
    } finally {
      // never leave the watchdog running after the call resolves
      if (res.body && typeof (res.body as any).cancel === 'function') {
        try { (res.body as any).cancel().catch?.(() => {}) } catch { /* ignore */ }
      }
    }
  }
}

// ---------------- SSE parsing ----------------

interface ParseSSEOpts {
  /** caller's abort signal (user Stop) */
  signal?: AbortSignal
  /** internal controller for watchdog aborts */
  internal?: AbortController
}

/**
 * Stream parser. Content flows through RAW — no think-tag splitting, no
 * holdback, nothing swallowed. Think hygiene happens once at finalize().
 * reasoning_content (server-side reasoning channel) still routes to
 * onThinking, which never affects content.
 */
export async function parseSSE(body: ReadableStream, cb: StreamCallbacks, opts: ParseSSEOpts = {}): Promise<ChatResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let lastActivity = Date.now()

  // watchdog: abort the fetch if the stream goes silent
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const idleMs = STREAM_IDLE_TIMEOUT_MS
  const arm = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => opts.internal?.abort(new StreamStallError(idleMs)), idleMs)
  }
  const disarm = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }
  arm()

  const handleLine = (line: string) => {
    lastActivity = Date.now()
    const s = line.trim()
    if (!s.startsWith('data:')) return
    const data = s.slice(5).trim()
    if (!data || data === '[DONE]') return
    let j: any
    try {
      j = JSON.parse(data)
    } catch {
      return
    }
    const delta = j.choices?.[0]?.delta
    if (!delta) return
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) {
      cb.onThinking?.(reasoning)
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      cb.onToken?.(delta.content)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const a = toolAcc.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) a.id = tc.id
        if (tc.function?.name) a.name += tc.function.name
        if (tc.function?.arguments) a.args += tc.function.arguments
        toolAcc.set(idx, a)
      }
    }
  }

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      arm()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    if (buf) handleLine(buf)
  } catch (e: any) {
    // A watchdog abort surfaces as a stall if the user did not stop the run.
    if (opts.signal?.aborted) throw new Error('aborted')
    if (e?.name === 'AbortError' && opts.internal?.signal?.aborted && !opts.signal?.aborted) {
      throw new StreamStallError(Date.now() - lastActivity)
    }
    throw e
  } finally {
    disarm()
    try { reader.releaseLock() } catch { /* ignore */ }
  }

  // standard tool calls
  const toolCalls: ToolCall[] = []
  for (const a of toolAcc.values()) {
    let args: unknown = {}
    try {
      args = JSON.parse(a.args)
    } catch {
      args = { _raw: a.args }
    }
    toolCalls.push({ id: a.id || `call_${toolCalls.length}`, name: a.name, args: args as Record<string, unknown> })
  }

  // native fallback: models that emit tool calls as text blocks
  const nativeResult = extractNativeToolCalls(content)
  for (const c of nativeResult.calls) toolCalls.push(c)

  // finalize: strip think hygiene from the final text only (raw streaming
  // already delivered every token; this keeps stored/replied content clean).
  const clean = stripThinkBlocks(nativeResult.content).trim()
  return { content: clean, toolCalls }
}

// ---------------- think hygiene (finalize only) ----------------

// Tags are built from char codes so the literals never appear in this file.
const T_OPEN = '<' + String.fromCharCode(116, 104, 105, 110, 107) + '>'
const T_CLOSE = '</' + String.fromCharCode(116, 104, 105, 110, 107) + '>'

/** Remove think blocks from final text. Balanced blocks go entirely;
 *  an unclosed leading block loses everything up to end-of-text (the
 *  answer never arrived — keeping the partial reasoning would leak it). */
export function stripThinkBlocks(text: string): string {
  let out = text
  const re = new RegExp(`${T_OPEN}[\\s\\S]*?${T_CLOSE}`, 'g')
  out = out.replace(re, '')
  const i = out.indexOf(T_OPEN)
  if (i !== -1) out = out.slice(0, i)
  return out
}

// ---------------- native tool-call fallback ----------------

const TOOL_OPEN = '<' + String.fromCharCode(116, 111, 111, 108, 95, 99, 97, 108, 108) + '>'
const TOOL_CLOSE = '</' + String.fromCharCode(116, 111, 111, 108, 95, 99, 97, 108, 108) + '>'

export function extractNativeToolCalls(content: string): { content: string; calls: ToolCall[] } {
  const calls: ToolCall[] = []
  const re = new RegExp(`${TOOL_OPEN}\\s*([\\s\\S]*?)\\s*${TOOL_CLOSE}`, 'g')
  let i = 0
  const stripped = content.replace(re, (_full, body: string) => {
    i++
    try {
      const j = JSON.parse(body)
      let args: unknown = j.arguments ?? j.parameters ?? {}
      if (typeof args === 'string') args = JSON.parse(args)
      calls.push({
        id: `call_native_${i}`,
        name: String(j.name ?? 'unknown'),
        args: ((args ?? {}) as Record<string, unknown>)
      })
    } catch {
      // malformed block — leave a note so the orchestrator can react
      calls.push({ id: `call_native_${i}`, name: 'unknown', args: { _raw: body.slice(0, 400) } })
    }
    return ''
  })
  return { content: stripped, calls }
}