import { describe, it, expect, vi } from 'vitest'
import { parseSSE, extractNativeToolCalls, OllamaCloudClient } from '../src/main/agent/ollamaClient'
import { parsePlan, parseVerdict } from '../src/main/agent/subagents'
import { runLoop, type LoopDeps } from '../src/main/agent/loop'
import type { ToolDef } from '../src/shared/agent/types'

function sseStream(chunks: string[]): ReadableStream {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    }
  })
}

function delta(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

describe('SSE parsing', () => {
  it('accumulates streamed content tokens', async () => {
    const tokens: string[] = []
    const stream = sseStream([
      delta({ choices: [{ delta: { content: 'Hel' } }] }),
      delta({ choices: [{ delta: { content: 'lo' } }] }),
      'data: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, { onToken: (t) => tokens.push(t) })
    expect(res.content).toBe('Hello')
    expect(res.toolCalls).toHaveLength(0)
    expect(tokens.join('')).toBe('Hello')
  })

  it('reassembles tool_calls across delta chunks', async () => {
    const stream = sseStream([
      delta({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'edit_file', arguments: '{"pa' } }] } }] }),
      delta({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
      'data: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, {})
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].name).toBe('edit_file')
    expect(res.toolCalls[0].args).toEqual({ path: 'a.txt' })
    expect(res.toolCalls[0].id).toBe('call_1')
  })

  it('handles split SSE lines across chunk boundaries', async () => {
    const stream = sseStream([
      'data: {"choices":[{"delta":{"content":"ab',
      'c"}}]}\n\ndata: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, {})
    expect(res.content).toBe('abc')
  })

  it('routes reasoning_content to thinking', async () => {
    const think: string[] = []
    const stream = sseStream([
      delta({ choices: [{ delta: { reasoning_content: 'pondering ' } }] }),
      delta({ choices: [{ delta: { reasoning_content: 'hard' } }] }),
      delta({ choices: [{ delta: { content: 'Answer' } }] }),
      'data: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, { onThinking: (t) => think.push(t) })
    expect(res.content).toBe('Answer')
    expect(think.join('')).toBe('pondering hard')
  })

  const THINK_OPEN = '<' + String.fromCharCode(116, 104, 105, 110, 107) + '>'
  const THINK_CLOSE = '</' + String.fromCharCode(116, 104, 105, 110, 107) + '>'

  it('streams think-block content RAW as tokens (no holdback, nothing swallowed)', async () => {
    const tokens: string[] = []
    const stream = sseStream([
      delta({ choices: [{ delta: { content: THINK_OPEN + 'internal ' } }] }),
      delta({ choices: [{ delta: { content: 'deliberation' + THINK_CLOSE } }] }),
      delta({ choices: [{ delta: { content: 'The answer' } }] }),
      'data: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, { onToken: (t) => tokens.push(t) })
    // every chunk streamed through immediately
    expect(tokens.join('')).toBe(THINK_OPEN + 'internal deliberation' + THINK_CLOSE + 'The answer')
    // final content has think hygiene applied
    expect(res.content).toBe('The answer')
  })

  it('drops an unclosed think block instead of leaking reasoning as the answer', async () => {
    const stream = sseStream([
      delta({ choices: [{ delta: { content: THINK_OPEN + 'half-finished ' } }] }),
      delta({ choices: [{ delta: { content: 'reasoning that never closes' } }] }),
      'data: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, {})
    expect(res.content).toBe('')
  })

  it('still extracts native tool_call text blocks', async () => {
    const TOOL_OPEN = '<' + String.fromCharCode(116, 111, 111, 108, 95, 99, 97, 108, 108) + '>'
    const TOOL_CLOSE = '</' + String.fromCharCode(116, 111, 111, 108, 95, 99, 97, 108, 108) + '>'
    const stream = sseStream([
      delta({ choices: [{ delta: { content: 'editing now ' + TOOL_OPEN + '{"name":"edit_file","arguments":{"path":"a.txt"}}' + TOOL_CLOSE } }] }),
      'data: [DONE]\n\n'
    ])
    const res = await parseSSE(stream, {})
    expect(res.content).toBe('editing now')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].name).toBe('edit_file')
  })
})

describe('plan parsing', () => {
  it('parses a fenced plan with ids', () => {
    const text = 'Here is the plan:\n```json\n{"steps":[{"title":"Add util","detail":"create src/util.py","files":["src/util.py"]},{"title":"Write tests","detail":"pytest","files":[]}]}\n```'
    const plan = parsePlan(text)!
    expect(plan).not.toBeNull()
    expect(plan).toHaveLength(2)
    expect(plan[0].id).toBe('s1')
    expect(plan[1].title).toBe('Write tests')
    expect(plan[0].status).toBe('pending')
  })

  it('returns null for junk', () => {
    expect(parsePlan('no plan here')).toBeNull()
  })

  it('parses reviewer verdicts', () => {
    expect(parseVerdict('VERDICT: FIX\n1. bug in x')).toBe('FIX')
    expect(parseVerdict('verdict: approve')).toBe('APPROVE')
    expect(parseVerdict('no verdict')).toBeNull()
  })
})

describe('agent loop', () => {
  const noopTools: ToolDef[] = []
  const emit = () => {}

  it('executes tool calls then finishes with plain content', async () => {
    const executed: string[] = []
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'a' } }] })
      .mockResolvedValueOnce({ content: 'All done!', toolCalls: [] })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async (c) => { executed.push(c.name); return 'file body' }, emit, agent: 'orchestrator', maxIterations: 5, signal: new AbortController().signal },
      'system prompt',
      [{ role: 'user', content: 'go' }]
    )
    expect(executed).toEqual(['read_file'])
    expect(res.content).toBe('All done!')
    expect(res.toolCallsMade).toBe(1)
    expect(res.newMessages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(res.newMessages.at(-1)).toEqual({ role: 'assistant', content: 'All done!' })
  })

  it('runs until the model returns a final answer without iteration limit', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'x', name: 'loop', args: {} }] })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'ok', emit, agent: 'orchestrator', maxIterations: 1000, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    expect(chat).toHaveBeenCalledTimes(2)
    expect(res.content).toBe('done')
  })

  it('converts execute throw into an error tool result', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'e1', name: 'boom', args: {} }] })
      .mockResolvedValueOnce({ content: 'recovered', toolCalls: [] })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => { throw new Error('disk on fire') }, emit, agent: 'orchestrator', maxIterations: 5, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    const toolMsg = res.newMessages.find((m) => m.role === 'tool')!
    expect(toolMsg.content).toMatch(/disk on fire/)
    expect(res.content).toBe('recovered')
  })

  it('returns ONLY this run\'s messages (no history duplication)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: '1', name: 'read_file', args: {} }] })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
    const history = [
      { role: 'user' as const, content: 'earlier question' },
      { role: 'assistant' as const, content: 'earlier answer' }
    ]
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'data', emit, agent: 'orchestrator', maxIterations: 5, signal: new AbortController().signal },
      'sys',
      history
    )
    // caller merges newMessages into history; the user message must NOT come back again
    const users = res.newMessages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(0)
    expect(res.newMessages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(res.newMessages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
  })

  it('preserves partial learnings on abort (stop keeps file reads)', async () => {
    const controller = new AbortController()
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        return { content: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'big.ts' } }] }
      })
      .mockImplementationOnce(async () => {
        controller.abort() // user hits Stop during the second call
        throw new Error('The operation was aborted')
      })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'entire file content here', emit, agent: 'orchestrator', maxIterations: 5, signal: controller.signal },
      'sys',
      [{ role: 'user', content: 'analyze the codebase' }]
    )
    expect(res.aborted).toBe(true)
    // the file read from THIS run survives the abort
    const toolMsg = res.newMessages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('entire file content here')
  })

  it('preserves partial learnings on a mid-run error (non-retryable errors surface immediately)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'g1', name: 'grep', args: { pattern: 'x' } }] })
      .mockRejectedValueOnce(new Error('boom: invalid request'))
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'match found', emit, agent: 'orchestrator', maxIterations: 5, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    expect(chat).toHaveBeenCalledTimes(2)
    expect(res.error).toMatch(/boom: invalid request/)
    expect(res.newMessages.find((m) => m.role === 'tool')?.content).toBe('match found')
  })

  it('retries an empty turn instead of silently completing (the 15s silent-stop bug)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [] })   // model died mid-think
      .mockResolvedValueOnce({ content: '', toolCalls: [] })   // still empty
      .mockResolvedValueOnce({ content: 'Recovered!', toolCalls: [] }) // recovers
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'ok', emit, agent: 'orchestrator', maxIterations: 8, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    expect(chat).toHaveBeenCalledTimes(3)
    expect(res.content).toBe('Recovered!')
    expect(res.error).toBeUndefined()
  })

  it('ends with a VISIBLE error after repeated empty responses, not a silent stop', async () => {
    const chat = vi.fn().mockResolvedValue({ content: '', toolCalls: [] })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'ok', emit, agent: 'orchestrator', maxIterations: 8, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    expect(res.error).toMatch(/empty responses/i)
    // only nudges — no junk assistant/tool messages in the session thread
    expect(res.newMessages.every((m) => m.role === 'user')).toBe(true)
  })

  it('does NOT stop at the iteration cap — nudges and continues until the task is done', async () => {
    // model does tool work for more turns than maxIterations, then finishes
    const seq: any[] = []
    for (let i = 0; i < 5; i++) seq.push({ content: '', toolCalls: [{ id: `t${i}`, name: 'read_file', args: {} }] })
    seq.push({ content: 'All done, edits applied.', toolCalls: [] })
    const mock = vi.fn()
    seq.forEach((v) => mock.mockResolvedValueOnce(v))
    const res = await runLoop(
      { chat: mock as any, tools: noopTools, execute: async () => 'data', emit, agent: 'orchestrator', maxIterations: 3, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    // maxIterations=3 but the task needed 6 turns: the loop kept going
    expect(res.content).toBe('All done, edits applied.')
    expect(res.toolCallsMade).toBe(5)
    expect(res.error).toBeUndefined()
  })

  it('retries a stalled stream (StreamStallError) and keeps the session intact', async () => {
    const stall = new Error('dead connection')
    stall.name = 'StreamStallError'
    const chat = vi
      .fn()
      .mockRejectedValueOnce(stall)
      .mockResolvedValueOnce({ content: 'back online', toolCalls: [] })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'ok', emit, agent: 'orchestrator', maxIterations: 5, signal: new AbortController().signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    expect(chat).toHaveBeenCalledTimes(2)
    expect(res.content).toBe('back online')
  })

  it('does NOT retry user aborts', async () => {
    const controller = new AbortController()
    const chat = vi.fn().mockImplementation(async () => {
      controller.abort()
      const e = new Error('This operation was aborted')
      e.name = 'AbortError'
      throw e
    })
    const res = await runLoop(
      { chat: chat as any, tools: noopTools, execute: async () => 'ok', emit, agent: 'orchestrator', maxIterations: 5, signal: controller.signal },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    expect(chat).toHaveBeenCalledTimes(1)
    expect(res.aborted).toBe(true)
  })
})

describe('OllamaCloudClient error handling', () => {
  it('maps 401 to a friendly message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }) as any
    const client = new OllamaCloudClient({ apiKey: 'bad', baseUrl: 'https://api.ollama.com', model: 'm' })
    await expect(client.chat([], [], new AbortController().signal, {})).rejects.toThrow(/API key/i)
  })
})