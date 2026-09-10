// Workspace memory: multi-root indexing, symbol extraction, memory.md generation,
// and retrieval helpers.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexWorkspace, findSymbol, retrieveRelevant, buildMemoryMarkdown, memory, writeMemoryFile } from '../src/main/workspaceMemory'
import { setIndex, searchCodebaseIndex } from '../src/main/agent/codebaseIndexBridge'

let tmp = ''

function write(p: string, content: string): string {
  const abs = path.join(tmp, p)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-mem-'))
  write('src/app.ts', [
    'export function main(): void {',
    '  console.log("hello")',
    '}',
    'export class Widget {',
    '  render(): void { return }',
    '}',
    'export type Config = { url: string }'
  ].join('\n'))
  write('src/util/helper.ts', [
    'import { Config } from "./app"',
    'export const answer = 42',
    'function internalHelper(cfg: Config) {',
    '  return cfg.url',
    '}'
  ].join('\n'))
  write('tools/script.py', 'def run_pipeline():\n    pass\n\nclass Pipeline:\n    pass\n')
  write('assets/logo.png', 'fake-binary')
})

describe('workspace memory / auto-context', () => {
  it('indexes all roots with progress', async () => {
    let progressCalls = 0
    const stats = await indexWorkspace([tmp], (done, total, name) => {
      progressCalls++
      expect(total).toBeGreaterThanOrEqual(4)
      expect(typeof name).toBe('string')
      void done
    })
    expect(stats.files).toBeGreaterThanOrEqual(3)
    expect(stats.lines).toBeGreaterThan(5)
    expect(memory.ready).toBe(true)
  })

  it('extracts symbols (functions, classes, exports, types)', () => {
    const main = findSymbol('main')
    expect(main.length).toBeGreaterThan(0)
    expect(main[0].kind).toBe('function')
    expect(main[0].path).toBe('src/app.ts')
    expect(findSymbol('Widget')[0].kind).toBe('class')
    expect(findSymbol('Config')[0].path).toBe('src/app.ts')
    expect(findSymbol('run_pipeline').length).toBeGreaterThan(0)
  })

  it('feeds the shared search index used by @codebase and the search_codebase tool', () => {
    // simulate the bridge binding done in ipc
    const hits = searchCodebaseIndex('console', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].path).toContain('src/app.ts')
  })

  it('retrieves relevant code for a user message', () => {
    const hits = retrieveRelevant('internalHelper cfg url', 5)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('writes .meencode/memory.md with structure and symbols', async () => {
    await indexWorkspace([tmp])
    const p = writeMemoryFile(memory.stats!)
    expect(p).toBeTruthy()
    const raw = fs.readFileSync(p!, 'utf8')
    expect(raw).toContain('# Workspace memory')
    expect(raw).toContain('Folder 0')
    expect(raw).toContain('Key symbols')
  })

  it('builds deterministic markdown without a filesystem', () => {
    const md = buildMemoryMarkdown({ roots: [tmp], files: 3, lines: 10, symbols: 4, ms: 5, memoryPath: null })
    expect(md).toContain('## Key symbols')
    expect(md).toContain('Rules for agents')
  })
})