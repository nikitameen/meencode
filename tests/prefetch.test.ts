// Prefetch pack: BM25 + identifier + behavior-prior fusion into one budgeted pack.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sessionStore = await import('../src/main/sessionStore')
const sliceStore = await import('../src/main/sliceStore')
const g = await import('../src/main/accessGraph')
const pf = await import('../src/main/prefetch')

let tmp = ''
let ws = ''
let dbFile = ''

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-prefetch-'))
  ws = path.join(tmp, 'project')
  fs.mkdirSync(ws, { recursive: true })
  dbFile = path.join(tmp, 'slices.db')
  await sliceStore.initSliceDb(dbFile)
  const mock = await import('./mocks/electron')
  fs.rmSync(mock.app.getPath('userData'), { recursive: true, force: true })
  await sessionStore.initSessionDb()
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const write = (p: string, c: string): void => {
  const abs = path.join(ws, p)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, c)
}

beforeEach(async () => {
  // fresh project files + slice index; keep the shared access graph (tests build their own priors)
  write('src/auth.ts', [
    'import { store } from "./store"',
    '',
    'export function retryAuth(): boolean {',
    '  // exponential backoff for token refresh',
    '  return refresh()',
    '}',
    '',
    'export class AuthClient {',
    '  login(user: string): string {',
    '    return user',
    '  }',
    '}'
  ].join('\n'))
  write('src/theme.ts', [
    'export function applyTheme(name: string): void {',
    '  document.body.classList.toggle("dark", name === "dark")',
    '}',
    'export const THEME_KEY = "meencode.theme"'
  ].join('\n'))
  write('src/settings.ts', [
    'export interface Settings {',
    '  apiKey: string',
    '  autoRunCommands: boolean',
    '}',
    'export function loadSettings(): Settings {',
    '  return { apiKey: "", autoRunCommands: false }',
    '}'
  ].join('\n'))
  await sliceStore.indexRoot(ws)
})

describe('buildPrefetchPack: index channel', () => {
  it('finds the relevant slice for a topical request', () => {
    const pack = pf.buildPrefetchPack([ws], 'fix the token refresh retry logic', {})
    expect(pack).toBeTruthy()
    expect(pack).toContain('retryAuth')
    expect(pack).toContain('src/auth.ts')
    expect(pack).not.toContain('applyTheme')
  })

  it('uses expansions to widen the search', () => {
    const pack = pf.buildPrefetchPack([ws], 'theming', { expansions: ['theme dark toggle'] })
    expect(pack).toContain('applyTheme')
  })

  it('respects the character budget', () => {
    const pack = pf.buildPrefetchPack([ws], 'settings auth theme retry', { budgetChars: 2500 })
    expect(pack.length).toBeLessThanOrEqual(3500) // header lines + candidates add a little over budget
  })

  it('returns empty for chatter with no code relevance', () => {
    expect(pf.buildPrefetchPack([ws], 'hello there', {})).toBe('')
  })
})

describe('buildPrefetchPack: behavior channel', () => {
  it('injects slices from files the agent touched on similar requests', () => {
    const hash = g.requestHashOf('make the status bar show index progress')
    g.recordAccess(ws, hash, 'src/indexing.ts', 'edit')
    g.flushAccessForTest()
    write('src/indexing.ts', 'export function autoIndex(force: boolean): void {\n  void force\n}')
    void sliceStore.indexFileContent(ws, 'src/indexing.ts', fs.readFileSync(path.join(ws, 'src/indexing.ts'), 'utf8'))
    const pack = pf.buildPrefetchPack([ws], 'show index progress in the status bar', {})
    expect(pack).toContain('src/indexing.ts')
    expect(pack).toContain('behavior')
  })

  it('boosts index hits for behaviorally hot files', () => {
    const hash = g.requestHashOf('fix the token refresh retry logic')
    g.recordAccess(ws, hash, 'src/auth.ts', 'edit')
    g.recordAccess(ws, hash, 'src/auth.ts', 'read')
    g.flushAccessForTest()
    const pack = pf.buildPrefetchPack([ws], 'fix the token refresh retry logic', {})
    expect(pack).toMatch(/behavior\+index|index\+behavior/)
  })

  it('suggests hot files as candidates when not included', () => {
    const hash = g.requestHashOf('completely unrelated topic xyz')
    g.recordAccess(ws, hash, 'src/hotfile.ts', 'read')
    g.flushAccessForTest()
    write('src/hotfile.ts', 'export function hotStuff() {}')
    void sliceStore.indexFileContent(ws, 'src/hotfile.ts', 'export function hotStuff() {}')
    const pack = pf.buildPrefetchPack([ws], 'something about the ui layout here', {})
    expect(pack).toContain('src/hotfile.ts')
  })
})

describe('buildPrefetchPack: identifier channel', () => {
  it('pulls symbols named in the request even when BM25 misses', () => {
    const pack = pf.buildPrefetchPack([ws], 'use AuthClient and THEME_KEY for this', {})
    expect(pack).toContain('AuthClient')
    expect(pack).toContain('THEME_KEY')
  })
})
describe('buildPrefetchPack: multi-root', () => {
  it('scopes display paths with N: prefixes', () => {
    const other = path.join(tmp, 'other-root')
    fs.mkdirSync(other, { recursive: true })
    try {
      fs.writeFileSync(path.join(other, 'util.ts'), 'export function retryAuthHelper(): number {\n  return 42\n}')
      void sliceStore.indexFileContent(other, 'util.ts', fs.readFileSync(path.join(other, 'util.ts'), 'utf8'))
      const pack = pf.buildPrefetchPack([ws, other], 'token refresh retry logic', {})
      expect(pack).toContain('0:src/auth.ts')
      expect(pack).toContain('1:util.ts')
    } finally {
      sliceStore.dropRoot(other)
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
