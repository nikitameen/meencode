import { describe, it, expect, vi } from 'vitest'
import { runLoop } from '../src/main/agent/loop'
import type { ToolDef } from '../src/shared/agent/types'

const noopTools: ToolDef[] = []
const emit = () => {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('parallel tool execution', () => {
  it('runs batched read tools concurrently (total ~= one call, not N)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', args: {} },
          { id: 'b', name: 'read_file', args: {} },
          { id: 'c', name: 'grep', args: {} }
        ]
      })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
    const t0 = Date.now()
    const res = await runLoop(
      {
        chat: chat as any,
        tools: noopTools,
        execute: async () => { await sleep(300); return 'ok' },
        emit,
        agent: 'orchestrator',
        maxIterations: 5,
        signal: new AbortController().signal
      },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    const elapsed = Date.now() - t0
    expect(res.toolCallsMade).toBe(3)
    // parallel: ~300ms total. sequential would be ~900ms.
    expect(elapsed).toBeLessThan(650)
    expect(res.content).toBe('done')
  })

  it('runs batched spawn_agent calls to different agents concurrently', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 's1', name: 'spawn_agent', args: { agent: 'coder', task: 'step 1' } },
          { id: 's2', name: 'spawn_agent', args: { agent: 'reviewer', task: 'check' } }
        ]
      })
      .mockResolvedValueOnce({ content: 'all done', toolCalls: [] })
    const t0 = Date.now()
    const res = await runLoop(
      {
        chat: chat as any,
        tools: noopTools,
        execute: async () => { await sleep(300); return 'sub-result' },
        emit,
        agent: 'orchestrator',
        maxIterations: 5,
        signal: new AbortController().signal
      },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    const elapsed = Date.now() - t0
    expect(res.toolCallsMade).toBe(2)
    expect(elapsed).toBeLessThan(650) // sequential would be ~600ms+ overhead — parallel ~300ms
    expect(res.content).toBe('all done')
  })

  it('stays sequential for two spawns of the SAME agent (dependent work)', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 's1', name: 'spawn_agent', args: { agent: 'coder', task: 'a' } },
          { id: 's2', name: 'spawn_agent', args: { agent: 'coder', task: 'b' } }
        ]
      })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
    const t0 = Date.now()
    await runLoop(
      {
        chat: chat as any,
        tools: noopTools,
        execute: async () => { await sleep(250); return 'r' },
        emit,
        agent: 'orchestrator',
        maxIterations: 5,
        signal: new AbortController().signal
      },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(480) // 2 × 250ms sequential
  })

  it('stays sequential when write tools are in the batch', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'w', name: 'write_file', args: {} },
          { id: 'r', name: 'read_file', args: {} }
        ]
      })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] })
    const t0 = Date.now()
    await runLoop(
      {
        chat: chat as any,
        tools: noopTools,
        execute: async () => { await sleep(250); return 'r' },
        emit,
        agent: 'orchestrator',
        maxIterations: 5,
        signal: new AbortController().signal
      },
      'sys',
      [{ role: 'user', content: 'go' }]
    )
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(480)
  })
})