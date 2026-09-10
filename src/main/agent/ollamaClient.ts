import type { AgentMessage, ToolCall, ToolDef } from '../../shared/agent/types'

export type ChatResult = { content: string; toolCalls: ToolCall[] }

export interface StreamCallbacks {
  onToken?: (t: string) => void
  onThinking?: (t: string) => void
}

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

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: this.headers.Authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
      redirect: 'follow'
    })

    if (res.redirected && res.url && !res.url.includes('/v1/chat/completions')) {
      throw new Error(`The API base URL redirected to ${res.url}. Open Settings and set the Base URL to https://ollama.com`)
    }
    if (res.status === 405) {
      throw new Error(`Server answered 405 Method Not Allowed. Open Settings and set the Base URL to https://ollama.com (api.ollama.com redirects and breaks streaming).`)
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Invalid or missing Ollama Cloud API key. Add your key in Settings.')
    }
    if (res.status === 404) {
      throw new Error(`Model "${model}" was not found on Ollama Cloud. Pick another model in Settings (use "Refresh list").`)
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Ollama Cloud error ${res.status}: ${t.slice(0, 300)}`)
    }

    return parseSSE(res.body!, cb)
  }
}

// ---------------- SSE parsing ----------------

export async function parseSSE(body: ReadableStream, cb: StreamCallbacks): Promise<ChatResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  const think = makeThinkSplitter(cb)

  const handleLine = (line: string) => {
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
      think.push(delta.content)
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

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  if (buf) handleLine(buf)
  think.flush()

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
  let clean = nativeResult.content
  for (const c of nativeResult.calls) toolCalls.push(c)

  return { content: clean.trim(), toolCalls }
}

// ---------------- <think> tag extraction ----------------

function makeThinkSplitter(cb: StreamCallbacks) {
  let inThink = false
  let pending = ''
  const emitText = (s: string) => s && cb.onToken?.(s)
  const emitThink = (s: string) => s && cb.onThinking?.(s)

  return {
    push(chunk: string) {
      pending += chunk
      for (;;) {
        if (!inThink) {
          const i = pending.indexOf('<think>')
          if (i === -1) {
            const hold = Math.max(0, pending.length - 7)
            if (hold > 0) {
              emitText(pending.slice(0, hold))
              pending = pending.slice(hold)
            }
            break
          } else {
            emitText(pending.slice(0, i))
            pending = pending.slice(i + 7)
            inThink = true
          }
        } else {
          const j = pending.indexOf('</think>')
          if (j === -1) {
            const hold = Math.max(0, pending.length - 8)
            if (hold > 0) {
              emitThink(pending.slice(0, hold))
              pending = pending.slice(hold)
            }
            break
          } else {
            emitThink(pending.slice(0, j))
            pending = pending.slice(j + 8)
            inThink = false
          }
        }
      }
    },
    flush() {
      if (!pending) return
      if (inThink) emitThink(pending)
      else emitText(pending)
      pending = ''
    }
  }
}

// ---------------- native tool-call fallback ----------------

export function extractNativeToolCalls(content: string): { content: string; calls: ToolCall[] } {
  const calls: ToolCall[] = []
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let m: RegExpExecArray | null
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