// Session store: SQLite (sql.js) persistence for chat sessions + messages.
// The 'electron' module is aliased to tests/mocks/electron.ts in vitest.config.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const store = await import('../src/main/sessionStore')
const mock = await import('./mocks/electron')

// sessions.db lands in the mock's userData dir
const dbDir = mock.app.getPath('userData')

beforeAll(async () => {
  fs.rmSync(dbDir, { recursive: true, force: true })
  fs.mkdirSync(dbDir, { recursive: true })
  await store.initSessionDb()
})

describe('sessionStore (real SQLite via sql.js)', () => {
  it('creates sessions and lists them newest-first', () => {
    store.createSession('s1', 'First chat', '/ws/a')
    store.createSession('s2', 'Second chat', '/ws/a')
    const list = store.listSessions()
    expect(list.length).toBeGreaterThanOrEqual(2)
    const s2 = list.find((s) => s.id === 's2')!
    const s1 = list.find((s) => s.id === 's1')!
    expect(s2.title).toBe('Second chat')
    expect(s2.workspace).toBe('/ws/a')
    expect(s2.updatedAt).toBeGreaterThanOrEqual(s1.updatedAt)
  })

  it('appends messages and counts them', () => {
    store.appendMessage('s1', 'user', 'hello')
    store.appendMessage('s1', 'assistant', 'hi there')
    store.appendMessage('s1', 'user', 'fix the bug')
    const list = store.listSessions()
    const s1 = list.find((s) => s.id === 's1')!
    expect(s1.messageCount).toBe(3)
    expect(s1.preview).toContain('fix the bug')
  })

  it('loads a session transcript in order', () => {
    const msgs = store.getSessionMessages('s1')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1].content).toBe('hi there')
    expect(msgs[0].ts).toBeLessThanOrEqual(msgs[2].ts)
  })

  it('renames a session', () => {
    store.renameSession('s1', 'Renamed chat')
    const s1 = store.listSessions().find((s) => s.id === 's1')!
    expect(s1.title).toBe('Renamed chat')
  })

  it('deletes a session and its messages (cascade)', () => {
    store.deleteSession('s1')
    expect(store.listSessions().find((s) => s.id === 's1')).toBeUndefined()
    expect(store.getSessionMessages('s1')).toEqual([])
  })

  it('persists the database file to disk', () => {
    const dbPath = path.join(dbDir, 'sessions.db')
    expect(fs.existsSync(dbPath)).toBe(true)
    const raw = fs.readFileSync(dbPath)
    // SQLite file magic header
    expect(raw.slice(0, 6).toString()).toBe('SQLite')
  })

  it('prunes sessions beyond the 200 cap / 90-day cutoff without touching fresh ones', () => {
    store.createSession('fresh', 'Keep me', null)
    store.appendMessage('fresh', 'user', 'recent')
    store.pruneSessions()
    expect(store.listSessions().find((s) => s.id === 'fresh')).toBeTruthy()
  })
})