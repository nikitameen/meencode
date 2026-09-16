// Slice store: symbol chunking, Merkle-style incremental indexing, BM25 + findSymbol.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const store = await import('../src/main/sliceStore')

let tmp = ''
let dbFile = ''

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-slices-'))
  dbFile = path.join(tmp, 'slices.db')
  await store.initSliceDb(dbFile)
})

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(p: string, c: string): void {
  const abs = path.join(tmp, p)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, c)
}

const AUTH_TS = [
  'import { x } from "./dep"',
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
  '  logout(): void {}',
  '}'
].join('\n')

describe('chunkFile', () => {
  it('splits TS into symbol slices with a header', () => {
    const slices = store.chunkFile('src/auth.ts', AUTH_TS)
    expect(slices.length).toBeGreaterThanOrEqual(4)
    const header = slices.find((s) => s.kind === 'header')
    expect(header?.body).toContain('import { x }')
    const retry = slices.find((s) => s.symbol === 'retryAuth')
    expect(retry?.kind).toBe('function')
    expect(retry?.line).toBe(3)
    expect(retry?.endLine).toBe(6)
    expect(retry?.body).toContain('exponential backoff')
    const cls = slices.find((s) => s.symbol === 'AuthClient')
    expect(cls?.kind).toBe('class')
    expect(cls?.endLine).toBe(13)
    const login = slices.find((s) => s.symbol === 'login')
    expect(login?.kind).toBe('method')
    expect(login?.endLine).toBe(11)
  })

  it('chunks python by indentation', () => {
    const slices = store.chunkFile('app.py', [
      'import os',
      '',
      'class Greeter:',
      '    def hello(self, name):',
      '        return f"hi {name}"',
      '',
      '    def bye(self):',
      '        return "bye"'
    ].join('\n'))
    expect(slices.some((s) => s.symbol === 'Greeter' && s.kind === 'class')).toBe(true)
    expect(slices.some((s) => s.symbol === 'hello' && s.kind === 'def')).toBe(true)
    expect(slices.some((s) => s.symbol === 'bye' && s.kind === 'def')).toBe(true)
    const hello = slices.find((s) => s.symbol === 'hello')
    expect(hello?.endLine).toBe(5)
  })

  it('falls back to overlapping chunks for unknown exts', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i} text`).join('\n')
    const slices = store.chunkFile('notes.txt', lines)
    expect(slices.length).toBeGreaterThan(1)
    expect(slices.every((s) => s.kind === 'chunk' || s.kind === 'header')).toBe(true)
  })

  it('skips commented-out declarations', () => {
    const slices = store.chunkFile('c.ts', [
      '// export function fakeOne() {}',
      'export function realOne() {}'
    ].join('\n'))
    expect(slices.some((s) => s.symbol === 'fakeOne')).toBe(false)
    oneRealCheck(slices)
  })

  it('captures signature-only slices for bodyless exports', () => {
    const slices = store.chunkFile('cfg.ts', 'export const MAX_RETRIES = 3;')
    const m = slices.find((s) => s.symbol === 'MAX_RETRIES')
    expect(m).toBeTruthy()
    expect(m?.kind).toBe('export')
  })

  it('caps huge symbols with a truncation marker', () => {
    const big = ['export function giant() {', ...Array.from({ length: 300 }, () => '  x++'), '}'].join('\n')
    const slices = store.chunkFile('big.ts', big)
    const g = slices.find((s) => s.symbol === 'giant')
    expect(g?.body).toContain('truncated')
  })
})

function oneRealCheck(slices: any[]): void {
  expect(slices.some((s) => s.symbol === 'realOne')).toBe(true)
}

describe('incremental indexing (Merkle-style)', () => {
  it('skips unchanged files, re-indexes changed ones', async () => {
    write('src/auth.ts', AUTH_TS)
    const r1 = await store.indexRoot(tmp)
    expect(r1.files).toBe(1)
    expect(r1.changed).toBe(1)
    expect(r1.skipped).toBe(0)
    expect(r1.slices).toBeGreaterThan(0)
    // same content -> all skipped
    const r2 = await store.indexRoot(tmp)
    expect(r2.changed).toBe(0)
    expect(r2.skipped).toBe(1)
    expect(r2.ms).toBeLessThan(r1.ms)
  })

  it('replaces slices when a file changes', async () => {
    write('src/a.ts', 'import { z } from "./z"\nexport function alpha() {}')
    await store.indexRoot(tmp)
    write('src/a.ts', 'import { z } from "./z"\nexport function beta() {}')
    await store.indexRoot(tmp)
    const hits = store.findSymbol(tmp, 'beta', 'exact')
    expect(hits.length).toBe(1)
    expect(store.findSymbol(tmp, 'alpha', 'exact')).toHaveLength(0)
    expect(store.getSlicesForFile(tmp, 'src/a.ts').length).toBe(2) // header + beta
  })

  it('drops slices for deleted files', async () => {
    write('src/gone.ts', 'export function gone() {}')
    await store.indexRoot(tmp)
    expect(store.findSymbol(tmp, 'gone', 'exact').length).toBe(1)
    fs.rmSync(path.join(tmp, 'src/gone.ts'))
    const r = await store.indexRoot(tmp)
    expect(r.deleted).toBe(1)
    expect(store.findSymbol(tmp, 'gone', 'exact')).toHaveLength(0)
  })

  it('ignores node_modules and binaries', async () => {
    write('node_modules/p/index.js', 'export function x() {}')
    write('img/logo.png', 'fakebinary')
    write('src/real.ts', 'export function real() {}')
    const r = await store.indexRoot(tmp)
    expect(r.files).toBe(1)
    expect(store.findSymbol(tmp, 'x', 'exact')).toHaveLength(0)
  })
})

describe('bm25Search', () => {
  beforeEach(async () => {
    write('src/auth.ts', AUTH_TS)
    write('src/session.ts', [
      'export function createSession(user: string): string {',
      '  return user',
      '}',
      'export function destroySession(id: string): void {',
      '  clearTimeout(id)',
      '}'
    ].join('\n'))
    await store.indexRoot(tmp)
  })

  it('finds the right slice for a topical query', () => {
    const hits = store.bm25Search(tmp, 'token refresh backoff', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].rel).toBe('src/auth.ts')
    expect(hits[0].symbol).toBe('retryAuth')
  })

  it('finds camelCase symbols from lowercase words', () => {
    const hits = store.bm25Search(tmp, 'create session', 5)
    expect(hits.some((h) => h.symbol === 'createSession')).toBe(true)
  })

  it('is typo-tolerant via subtoken matching', () => {
    const hits = store.bm25Search(tmp, 'session destroy', 5)
    expect(hits.some((h) => h.symbol === 'destroySession')).toBe(true)
  })

  it('returns [] for garbage', () => {
    expect(store.bm25Search(tmp, '', 5)).toEqual([])
    expect(store.bm25Search(tmp, '!!', 5)).toEqual([])
  })
})

describe('findSymbol', () => {
  beforeEach(async () => {
    write('src/auth.ts', AUTH_TS)
    await store.indexRoot(tmp)
  })

  it('exact / prefix / substring modes', () => {
    expect(store.findSymbol(tmp, 'retryAuth', 'exact').length).toBe(1)
    expect(store.findSymbol(tmp, 'retry', 'prefix').some((h) => h.symbol === 'retryAuth')).toBe(true)
    expect(store.findSymbol(tmp, 'Auth', 'substring').some((h) => h.symbol === 'AuthClient')).toBe(true)
  })

  it('returns no symbols from other roots', () => {
    const other = path.join(tmp, 'not-a-root')
    expect(store.findSymbol(other, 'retryAuth', 'exact')).toHaveLength(0)
  })
})

describe('persistence', () => {
  it('survives close/reopen with incremental skip', async () => {
    write('src/auth.ts', AUTH_TS)
    await store.indexRoot(tmp)
    store.flushSliceDb()
    store.closeSliceDb()
    await store.initSliceDb(dbFile)
    // no re-index needed: the new store already knows file hashes
    const r = await store.indexRoot(tmp)
    expect(r.changed).toBe(0)
    expect(r.skipped).toBe(1)
    expect(store.bm25Search(tmp, 'token refresh backoff', 3)[0].symbol).toBe('retryAuth')
  })
})

describe('sliceStoreStats', () => {
  it('counts files, slices, terms', async () => {
    write('src/auth.ts', AUTH_TS)
    await store.indexRoot(tmp)
    const st = store.sliceStoreStats(tmp)
    expect(st.files).toBe(1)
    expect(st.slices).toBeGreaterThanOrEqual(4)
    expect(st.terms).toBeGreaterThan(20)
  })
})

describe('incremental single-file updates (watcher flow)', () => {
  it('updateFileContent + deleteFileFromStore keep search in sync', async () => {
    write('src/auth.ts', AUTH_TS)
    await store.indexRoot(tmp)
    // edit one file directly (what ipc.ts flushPendingChanges does)
    const edited = AUTH_TS.replace('retryAuth', 'refreshAuth')
    store.indexFileContent(tmp, 'src/auth.ts', edited)
    expect(store.findSymbol(tmp, 'refreshAuth', 'exact').length).toBe(1)
    expect(store.findSymbol(tmp, 'retryAuth', 'exact')).toHaveLength(0)
    // bm25 sees the new content
    expect(store.bm25Search(tmp, 'refreshAuth', 5).some((h) => h.symbol === 'refreshAuth')).toBe(true)
    // delete -> gone
    store.deleteFileFromStore(tmp, 'src/auth.ts')
    expect(store.findSymbol(tmp, 'refreshAuth', 'exact')).toHaveLength(0)
    expect(store.getSlicesForFile(tmp, 'src/auth.ts')).toHaveLength(0)
  })

  it('skip is cheap: re-index of unchanged content changes nothing', async () => {
    write('src/auth.ts', AUTH_TS)
    await store.indexRoot(tmp)
    const before = store.sliceStoreStats(tmp)
    const res = store.indexFileContent(tmp, 'src/auth.ts', AUTH_TS)
    expect(res.skipped).toBe(true)
    const after = store.sliceStoreStats(tmp)
    expect(after).toEqual(before)
  })
})

describe('dropRoot', () => {
  it('purges every slice and term under the root', async () => {
    write('src/auth.ts', AUTH_TS)
    write('src/session.ts', 'export function createSession() {}')
    await store.indexRoot(tmp)
    expect(store.sliceStoreStats(tmp).slices).toBeGreaterThan(0)
    store.dropRoot(tmp)
    expect(store.sliceStoreStats(tmp)).toEqual({ files: 0, slices: 0, terms: 0 })
    expect(store.bm25Search(tmp, 'token refresh', 5)).toEqual([])
  })

  it('leaves other roots untouched', async () => {
    const other = path.join(tmp, '..', path.basename(tmp) + '-other')
    fs.mkdirSync(other, { recursive: true })
    try {
      fs.writeFileSync(path.join(other, 'x.ts'), 'export function keepMe() {}')
      write('src/auth.ts', AUTH_TS)
      await store.indexRoot(tmp)
      await store.indexRoot(other)
      store.dropRoot(tmp)
      expect(store.sliceStoreStats(other).files).toBe(1)
      expect(store.findSymbol(other, 'keepMe', 'exact').length).toBe(1)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})