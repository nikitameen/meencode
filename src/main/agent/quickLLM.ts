import type { Settings } from '../../shared/types'
import { proxySafeFetch } from '../proxyFetch'

export interface CompletionRequest {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

/**
 * Single-shot, non-streaming completion against Ollama Cloud.
 * Used for inline edits, autocomplete, and command suggestions.
 */
export async function complete(cfg: Settings, req: CompletionRequest, signal?: AbortSignal): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const res = await proxySafeFetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      stream: false,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2
    }),
    signal
  })
  if (res.status === 401 || res.status === 403) throw new Error('Invalid API key')
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Ollama Cloud error ${res.status}: ${t.slice(0, 200)}`)
  }
  const j: any = await res.json()
  const msg = j.choices?.[0]?.message
  return String(msg?.content ?? '')
}

/** Strip Qwen/GLM style reasoning wrappers from single-shot completions. */
export function stripReasoning(text: string): string {
  const THINK_OPEN = '<' + String.fromCharCode(116, 104, 105, 110, 107) + '>'
  const THINK_CLOSE = '</' + String.fromCharCode(116, 104, 105, 110, 107) + '>'
  let out = text
  const re = new RegExp(`${THINK_OPEN}[\\s\\S]*?${THINK_CLOSE}`, 'g')
  out = out.replace(re, '')
  // also strip unbalanced leading think block
  if (out.trimStart().startsWith(THINK_OPEN)) {
    const i = out.indexOf(THINK_CLOSE)
    if (i !== -1) out = out.slice(i + THINK_CLOSE.length)
    else out = ''
  }
  return out.trim()
}

/** Extract the first fenced code block (cmd+K edits). */
export function extractCodeBlock(text: string): string | null {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/)
  if (m) return m[1]
  const THINK_OPEN = '<' + String.fromCharCode(116, 104, 105, 110, 107) + '>'
  if (text.trim().startsWith(THINK_OPEN)) return null
  return null
}