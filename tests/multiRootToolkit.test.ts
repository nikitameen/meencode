import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Toolkit } from '../src/main/agent/tools'

let rootA: string
let rootB: string
let tk: Toolkit
const events: any[] = []

function makeToolkit(): Toolkit {
  events.length = 0
  return new Toolkit([rootA, rootB], {
    onFileChange: (c) => events.push({ type: 'change', c }),
    onOutput: () => {},
    approve: async () => true,
    autoRun: () => true
  })
}

beforeEach(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'mrA-'))
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'mrB-'))
  fs.writeFileSync(path.join(rootA, 'alpha.txt'), 'alpha file\n')
  fs.mkdirSync(path.join(rootB, 'src'), { recursive: true })
  fs.writeFileSync(path.join(rootB, 'src', 'beta.ts'), 'export const beta = 1\n')
  tk = makeToolkit()
})

afterEach(() => {
  fs.rmSync(rootA, { recursive: true, force: true })
  fs.rmSync(rootB, { recursive: true, force: true })
})

describe('Toolkit — multi-root agent operations', () => {
  it('lists workspace folders when path is ""', async () => {
    const r = await tk.execute('list_dir', { path: '' }, { callId: 't', agent: 'test' })
    expect(r).toContain('2 folder(s)')
    expect(r).toContain('0:')
    expect(r).toContain('1:')
  })

  it('reads files via scoped paths from a second root', async () => {
    const r = await tk.execute('read_file', { path: '1:src/beta.ts' }, { callId: 't', agent: 'test' })
    expect(r).toContain('export const beta = 1')
  })

  it('finds relative files across ALL roots (root A without scope)', async () => {
    const r = await tk.execute('read_file', { path: 'alpha.txt' }, { callId: 't', agent: 'test' })
    expect(r).toContain('alpha file')
    const r2 = await tk.execute('read_file', { path: 'src/beta.ts' }, { callId: 't', agent: 'test' })
    expect(r2).toContain('beta = 1')
  })

  it('writes to a second root via scoped path and records the change', async () => {
    const r = await tk.execute('write_file', { path: '1:src/new.ts', content: 'export {}\n' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/Wrote/)
    expect(fs.existsSync(path.join(rootB, 'src', 'new.ts'))).toBe(true)
    expect(events.some((e) => e.type === 'change' && e.c.path.includes('new.ts'))).toBe(true)
  })

  it('edits files in root B by relative path (found via exists-check)', async () => {
    const r = await tk.execute('edit_file', { path: 'src/beta.ts', old_string: 'const beta = 1', new_string: 'const beta = 2' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/1 replacement/)
    expect(fs.readFileSync(path.join(rootB, 'src', 'beta.ts'), 'utf8')).toContain('beta = 2')
  })

  it('greps across all roots', async () => {
    const r = await tk.execute('grep', { pattern: 'alpha|beta' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/alpha\.txt:1:/)
    expect(r).toMatch(/src\/beta\.ts:1:/)
  })

  it('search_files globs across all roots with scoped results', async () => {
    const r = await tk.execute('search_files', { pattern: '**/*.ts' }, { callId: 't', agent: 'test' })
    expect(r).toContain('1:src/beta.ts')
    expect(r).not.toContain('alpha.txt')
  })

  it('blocks unknown folder index and sandbox escapes', async () => {
    const r = await tk.execute('read_file', { path: '5:x.ts' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/Unknown workspace folder/)
    const outside = path.join(os.tmpdir(), 'outside-mr.txt')
    const r2 = await tk.execute('read_file', { path: outside }, { callId: 't', agent: 'test' })
    expect(r2).toMatch(/sandbox/i)
  })

  it('reverts a scoped change in root B', async () => {
    await tk.execute('write_file', { path: '1:temp.ts', content: 'x' }, { callId: 't', agent: 'test' })
    expect(tk.revert('temp.ts')).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(path.join(rootB, 'temp.ts'))).toBe(false)
  })
})