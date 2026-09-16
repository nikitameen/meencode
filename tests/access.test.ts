// Access graph: telemetry capture, decay-weighted behavior prior, hot files.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sessionStore = await import('../src/main/sessionStore')
const g = await import('../src/main/accessGraph')

let tmp = ''
let ws = ''

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-access-'))
  ws = path.join(tmp, 'project')
  fs.mkdirSync(ws, { recursive: true })
  const mock = await import('./mocks/electron')
  fs.rmSync(mock.app.getPath('userData'), { recursive: true, force: true })
  await sessionStore.initSessionDb()
})

describe('requestHashOf', () => {
  it('is stable under word-order and punctuation changes', () => {
    const a = g.requestHashOf('Fix the login bug!')
    const b = g.requestHashOf('the login fix: bug')
    expect(a).toBe(b)
    expect(a).not.toBe('empty')
  })

  it('ignores stopword-only chatter', () => {
    expect(g.requestHashOf('can you do this')).toBe('empty')
  })

  it('separates different topics', () => {
    expect(g.requestHashOf('add dark mode toggle')).not.toBe(g.requestHashOf('fix login bug'))
  })
})

describe('recordAccess + accessPrior', () => {
  const h = g.requestHashOf('fix the login bug')

  it('records and ranks files for the same request topic', () => {
    g.recordAccess(ws, h, 'src/auth.ts', 'edit')
    g.recordAccess(ws, h, 'src/auth.ts', 'read')
    g.recordAccess(ws, h, 'src/session.ts', 'read')
    g.recordAccess(ws, h, 'src/login.css', 'grep')
    g.flushAccessForTest()
    expect(g.accessStats(ws)).toBe(4)
    const prior = g.accessPrior(ws, h, 10)
    expect(prior.length).toBe(3)
    // edits weigh more than reads: auth.ts tops the ranking
    expect(prior[0].rel).toBe('src/auth.ts')
    expect(prior[0].edits).toBe(1)
    expect(prior[0].score).toBeGreaterThan(prior[1].score)
  })

  it('scopes priors per request topic', () => {
    const h2 = g.requestHashOf('add dark mode toggle')
    g.recordAccess(ws, h2, 'src/theme.ts', 'edit')
    g.flushAccessForTest()
    const dark = g.accessPrior(ws, h2, 10)
    expect(dark.some((p) => p.rel === 'src/theme.ts')).toBe(true)
    expect(dark.some((p) => p.rel === 'src/auth.ts')).toBe(false)
    const login = g.accessPrior(ws, h, 10)
    expect(login.some((p) => p.rel === 'src/theme.ts')).toBe(false)
  })

  it('scopes priors per workspace', () => {
    const other = g.accessPrior(path.join(tmp, 'other-ws'), h, 10)
    expect(other).toEqual([])
  })

  it('decays old accesses below fresh ones', () => {
    const db = sessionStore.getDb()
    // backdate one row by 60 days (~4+ half-lives)
    db.run('UPDATE agent_access SET ts = ? WHERE rel = ?', [Date.now() - 60 * 86400000, 'src/login.css'])
    const fresh = g.accessPrior(ws, h, 10).find((p) => p.rel === 'src/auth.ts')
    const stale = g.accessPrior(ws, h, 10).find((p) => p.rel === 'src/login.css')
    expect(fresh && stale ? fresh.score > stale.score : false).toBe(true)
  })

  it('hotFiles aggregates across all request topics', () => {
    const hot = g.hotFiles(ws, 10)
    expect(hot.length).toBeGreaterThan(0)
    expect(hot.some((p) => p.rel === 'src/auth.ts' || p.rel === 'src/theme.ts')).toBe(true)
  })

  it('prunes ancient rows', () => {
    g.pruneAccess(30) // the backdated login.css row (60d) goes away
    expect(g.accessPrior(ws, h, 10).some((p) => p.rel === 'src/login.css')).toBe(false)
  })
})

describe('tool telemetry (Toolkit integration)', () => {
  it('read/write/edit/grep log accesses with the run request hash', async () => {
    const { Toolkit } = await import('../src/main/agent/tools')
    fs.writeFileSync(path.join(ws, 'src-telemetry.ts'), 'export function one() { return 1 }')
    fs.writeFileSync(path.join(ws, 'telemetry-b.ts'), 'needle: export function two() { return 2 }')
    const tk = new Toolkit([ws], {
      approve: async () => true,
      autoRun: () => false,
      onFileChange: () => {},
      onOutput: () => {},
      emit: () => {},
      getSettings: () => ({ roots: [ws], workspace: ws }) as any
    } as any)
    tk.accessRequestHash = g.requestHashOf('telemetry test request')
    await tk.execute('read_file', { path: 'src-telemetry.ts' }, { callId: 'c1', agent: 'test' })
    await tk.execute('grep', { pattern: 'needle' }, { callId: 'c2', agent: 'test' })
    await tk.execute('edit_file', { path: 'src-telemetry.ts', old_string: 'return 1', new_string: 'return 11' }, { callId: 'c3', agent: 'test' })
    g.flushAccessForTest()
    const prior = g.accessPrior(ws, tk.accessRequestHash, 10)
    const rels = prior.map((p) => p.rel)
    expect(rels).toContain('src-telemetry.ts')
    expect(rels).toContain('telemetry-b.ts') // grep hit
    // edits count: telemetry-b.ts was only grepped; src-telemetry.ts was read + edited
    const edited = prior.find((p) => p.rel === 'src-telemetry.ts')
    expect(edited?.edits).toBe(1)
  })
})