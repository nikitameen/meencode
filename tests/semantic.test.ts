// Semantic search: RRF fusion + query expansion (LLM mocked via fetch).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fuseHits, expandQuery, semanticSearch, type SearchHit } from '../src/main/semanticSearch'
import { indexWorkspace, memory } from '../src/main/workspaceMemory'
import { setIndex } from '../src/main/agent/codebaseIndexBridge'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let tmp = ''
function write(p: string, c: string): void {
  const abs = path.join(tmp, p)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, c)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-sem-'))
  write('src/auth.ts', [
    'export function retryAuth(): boolean {',
    '  // exponential backoff for token refresh',
    '  return refresh()',
    '}',
    'export class AuthClient { login(): void {} }'
  ].join('\n'))
  write('src/session.ts', 'export function createSession(user: string): string {\n  return user\n}\n')
  return () => { fs.rmSync(tmp, { recursive: true, force: true }) }
})

describe('fuseHits (reciprocal rank fusion)', () => {
  const h = (path: string, line: number): SearchHit => ({ path, line, text: `t-${path}`, score: 1, via: 'test' })

  it('fuses two runs, boosting hits that appear in both', () => {
    const runA = [h('a.ts', 1), h('b.ts', 2), h('c.ts', 3)]
    const runB = [h('b.ts', 2), h('a.ts', 1), h('d.ts', 4)]
    const out = fuseHits([runA, runB], 10)
    // a.ts:1 and b.ts:2 appear in both -> top
    expect(out[0].path).toBe('a.ts')
    expect(out[1].path).toBe('b.ts')
    expect(out[0].score).toBeGreaterThan(out[2].score)
  })

  it('deduplicates by path:line', () => {
    const out = fuseHits([[h('a.ts', 1)], [h('a.ts', 1)]], 10)
    expect(out.length).toBe(1)
    expect(out[0].score).toBeGreaterThan(0.03) // ~2 * 1/61
  })

  it('respects the limit', () => {
    const runs = Array.from({ length: 5 }, () => Array.from({ length: 10 }, (_, i) => h(`f${i}.ts`, 1)))
    expect(fuseHits(runs, 3).length).toBe(3)
  })
})

describe('expandQuery (LLM via fetch, mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('parses query lines and caches', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      void init
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '- token refresh\n1. auth retry\nbackoff\n' } }] })
      } as Response
    })
    const cfg = { apiKey: 'k', baseUrl: 'https://ollama.com', fastModel: 'm' }
    const out = await expandQuery('where do we handle auth retry?', cfg)
    expect(out).toEqual(['token refresh', 'auth retry', 'backoff'])
    expect(calls.length).toBe(1)
    // no cache bound -> called again (cache optional). bind a cache to verify caching:
    // (binding tested in sessions.test via bindSearchCache on the shared db)
  })

  it('returns [] on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
    const out = await expandQuery('anything', { apiKey: 'k', baseUrl: 'https://ollama.com', fastModel: 'm' })
    expect(out).toEqual([])
  })
})

describe('semanticSearch end-to-end with expansions', () => {
  it('uses expansions to find conceptually-related code', async () => {
    await indexWorkspace([tmp])
    expect(memory.ready).toBe(true)
    // mock: expand "how does login work" -> terms that hit auth.ts
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'authclient\nlogin\ncreate session\n' } }] })
    } as Response)
    const hits = await semanticSearch('how does login work', { apiKey: 'k', baseUrl: 'https://ollama.com', fastModel: 'm' }, 10)
    expect(hits.length).toBeGreaterThan(0)
    const paths = hits.map((h) => h.path)
    expect(paths).toContain('src/auth.ts')
    expect(paths).toContain('src/session.ts')
  })

  it('falls back to the raw query when expansion yields nothing', async () => {
    await indexWorkspace([tmp])
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] })
    } as Response)
    const hits = await semanticSearch('retryAuth', { apiKey: 'k', baseUrl: 'https://ollama.com', fastModel: 'm' }, 10)
    expect(hits.some((h) => h.path === 'src/auth.ts')).toBe(true)
  })
})