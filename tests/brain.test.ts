import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')),
    getAppPath: () => process.cwd()
  },
  net: {}
}))

const { initSliceDb, indexFileContent, indexRoot, bm25Search, importersOf, importsOf, closeSliceDb } = await import('../src/main/sliceStore')
const { embed, cosine, buildVectorIndex, vectorSearch } = await import('../src/main/vectorIndex')
const { extractImports, resolveImport, isTestPath, isApiRoutePath } = await import('../src/main/depGraph')
const { findRelevantCode, brainBlock } = await import('../src/main/repoBrain')

let root: string

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'))
  await initSliceDb(path.join(root, 'test-slices.db'))
})

afterEach(() => {
  closeSliceDb()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('vector index — local embeddings', () => {
  it('embeds similar phrases closer than unrelated ones', () => {
    const a = embed('user authentication login flow')
    const b = embed('authenticate the user on login')
    const c = embed('database migration schema')
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c))
  })

  it('vector search finds paraphrased code', async () => {
    indexFileContent(root, 'auth.ts', 'export function verifyCredentials(user: string, pass: string): boolean {\n  return user === pass\n}\n')
    indexFileContent(root, 'migrations.ts', 'export function runMigrations(): void {\n  console.log("db migrate")\n}\n')
    buildVectorIndex(root, [
      { id: 1, rel: 'auth.ts', line: 1, endLine: 3, symbol: 'verifyCredentials', kind: 'function', body: 'export function verifyCredentials(user: string, pass: string): boolean {\n  return user === pass\n}' },
      { id: 2, rel: 'migrations.ts', line: 1, endLine: 3, symbol: 'runMigrations', kind: 'function', body: 'export function runMigrations(): void {\n  console.log("db migrate")\n}' }
    ])
    // paraphrase with shared stems (user/verify/credentials) — the local
    // vector channel's realistic job; full synonym gaps (login~auth) are
    // bridged by the LLM expansion channel in the fused brain query.
    const hits = vectorSearch(root, 'verify the user credentials', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].rel).toBe('auth.ts')
  })
})

describe('dependency graph', () => {
  it('extracts ES and CJS imports', () => {
    const imps = extractImports('a.ts', 'import x from "./b"\nconst y = require("./c")\nimport "./d"')
    expect(imps).toContain('./b')
    expect(imps).toContain('./c')
    expect(imps).toContain('./d')
  })

  it('resolves relative imports to workspace files', () => {
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1\n')
    expect(resolveImport(root, 'a.ts', './b')).toBe('b.ts')
    expect(resolveImport(root, 'a.ts', 'lodash')).toBe('') // bare packages are not edges
  })

  it('records importers via indexFileContent', () => {
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 1\n')
    indexFileContent(root, 'a.ts', 'import { b } from "./b"\nexport const a = b\n')
    expect(importersOf(root, 'b.ts')).toContain('a.ts')
    expect(importsOf(root, 'a.ts')).toContain('b.ts')
  })

  it('tags tests and api routes', () => {
    expect(isTestPath('tests/auth.test.ts')).toBe(true)
    expect(isTestPath('src/auth.ts')).toBe(false)
    expect(isApiRoutePath('api/routes/login.ts')).toBe(true)
  })
})

describe('repository brain — fused retrieval', () => {
  it('finds the right code for a paraphrased request', () => {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
    const authBody = 'export function authenticate(user: string, pass: string): boolean {\n  return user === pass\n}\n'
    const billingBody = 'export function chargeCard(amount: number): void {\n  console.log(amount)\n}\n'
    const testBody = 'import { authenticate } from "../auth"\ntest("logs in", () => {\n  expect(authenticate("u", "p")).toBe(false)\n})\n'
    fs.writeFileSync(path.join(root, 'auth.ts'), authBody)
    fs.writeFileSync(path.join(root, 'billing.ts'), billingBody)
    fs.writeFileSync(path.join(root, 'tests', 'auth.test.ts'), testBody)
    indexFileContent(root, 'auth.ts', authBody)
    indexFileContent(root, 'billing.ts', billingBody)
    indexFileContent(root, 'tests/auth.test.ts', testBody)

    // "login" ~ authenticate is bridged by the LLM expansion channel,
    // exactly as the orchestrator feeds it in production
    const res = findRelevantCode([root], 'make the login check work', {
      expansions: ['authenticate user credentials verify password']
    })
    expect(res.cards.length).toBeGreaterThan(0)
    expect(res.cards.some((c) => c.rel === 'auth.ts')).toBe(true)
    // the related test is discovered via the dependency graph
    expect(res.relatedTests.some((t) => t.includes('auth.test.ts'))).toBe(true)
    const block = brainBlock(res)
    expect(block).toContain('auth.ts')
    expect(block).toContain('Related tests')
  })

  it('returns an empty result for an empty index', () => {
    const res = findRelevantCode([root], 'anything')
    expect(res.cards).toHaveLength(0)
    expect(brainBlock(res)).toBe('')
  })
})