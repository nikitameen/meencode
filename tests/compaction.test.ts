// History compaction: context blocks must not accumulate across turns.
import { describe, it, expect } from 'vitest'
import { compactHistoryBytes } from '../src/main/agent/loop'
import type { AgentMessage } from '../src/shared/types'

const user = (i: number, withCtx: boolean): AgentMessage => ({
  role: 'user',
  content: withCtx
    ? `Question ${i}\n\n--- Workspace memory (auto-generated overview) ---\n${'x'.repeat(2500)}\n\n--- Recent session history ---\n${'y'.repeat(2000)}`
    : `Question ${i}`
})

describe('compactHistoryBytes', () => {
  it('strips context blocks from all but the newest user message', () => {
    const h: AgentMessage[] = [
      user(1, true), { role: 'assistant', content: 'A1' },
      user(2, true), { role: 'assistant', content: 'A2' },
      user(3, true)
    ]
    const out = compactHistoryBytes(h, 30, 60000)
    const users = out.filter((m) => m.role === 'user') as { content: string }[]
    expect(users.length).toBe(3)
    // oldest two are stripped
    expect(users[0].content).not.toContain('Workspace memory')
    expect(users[1].content).not.toContain('Workspace memory')
    // newest keeps its context
    expect(users[2].content).toContain('Workspace memory')
  })

  it('enforces a hard byte budget by dropping oldest messages', () => {
    const h: AgentMessage[] = []
    for (let i = 0; i < 20; i++) {
      h.push(user(i, false))
      h.push({ role: 'assistant', content: 'B'.repeat(5000) })
    }
    const out = compactHistoryBytes(h, 30, 20000)
    const total = out.reduce((n, m) => n + String(m.content).length, 0)
    expect(total).toBeLessThanOrEqual(20000)
    expect(out.length).toBeLessThan(h.length)
    // the newest user turn always survives
    const users = out.filter((m) => m.role === 'user') as { content: string }[]
    expect(users[users.length - 1].content).toContain('Question 19')
  })

  it('never drops below 2 messages', () => {
    const h: AgentMessage[] = [
      user(0, false),
      { role: 'assistant', content: 'Z'.repeat(50000) },
      user(1, false)
    ]
    const out = compactHistoryBytes(h, 30, 100)
    expect(out.length).toBeGreaterThanOrEqual(2)
  })
})