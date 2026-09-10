import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Toolkit } from '../src/main/agent/tools'

let root: string
let tk: Toolkit
const events: any[] = []

function makeToolkit(autoRun = true): Toolkit {
  events.length = 0
  return new Toolkit([root], {
    onFileChange: (c) => events.push({ type: 'change', c }),
    onOutput: (id, chunk, stream) => events.push({ type: 'output', id, chunk, stream }),
    approve: async () => true,
    autoRun: () => autoRun
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-test-'))
  fs.writeFileSync(path.join(root, 'hello.txt'), 'line one\nline two\nline three\n')
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add(a: number, b: number) {\n  return a + b\n}\n')
  fs.mkdirSync(path.join(root, 'src', 'deep'))
  fs.writeFileSync(path.join(root, 'src', 'deep', 'note.md'), '# note\nhello world\n')
  tk = makeToolkit()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Toolkit — sandboxing', () => {
  it('blocks paths outside the workspace', async () => {
    const r = await tk.execute('read_file', { path: '../escape.txt' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/sandbox/i)
  })

  it('blocks absolute paths outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), 'meencode-outside.txt')
    const r = await tk.execute('read_file', { path: outside }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/sandbox/i)
  })
})

describe('Toolkit — read_file', () => {
  it('reads a file with line info', async () => {
    const r = await tk.execute('read_file', { path: 'hello.txt' }, { callId: 't', agent: 'test' })
    expect(r).toContain('# hello.txt (lines 1-3 of 3)')
    expect(r).toContain('line two')
  })

  it('supports offset paging', async () => {
    const r = await tk.execute('read_file', { path: 'hello.txt', offset: 2 }, { callId: 't', agent: 'test' })
    expect(r).toContain('lines 2-3 of 3')
  })

  it('reports missing files clearly', async () => {
    const r = await tk.execute('read_file', { path: 'nope.txt' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/not found/)
  })
})

describe('Toolkit — list_dir / search_files / grep', () => {
  it('lists dirs before files', async () => {
    const r = await tk.execute('list_dir', { path: '' }, { callId: 't', agent: 'test' })
    expect(r).toContain('D src')
    expect(r).toContain('F hello.txt')
  })

  it('globs nested patterns', async () => {
    const r = await tk.execute('search_files', { pattern: '**/*.md' }, { callId: 't', agent: 'test' })
    expect(r).toContain('src/deep/note.md')
    expect(r).not.toContain('util.ts')
  })

  it('greps with file:line matches', async () => {
    const r = await tk.execute('grep', { pattern: 'line two|hello world' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/hello\.txt:2:/)
    expect(r).toMatch(/src\/deep\/note\.md:2:/)
  })

  it('rejects invalid regex', async () => {
    const r = await tk.execute('grep', { pattern: '(' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/invalid regex/i)
  })
})

describe('Toolkit — writes and change tracking', () => {
  it('creates files and records "created" changes', async () => {
    const r = await tk.execute('write_file', { path: 'new.ts', content: 'export {}\n' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/Wrote new\.ts/)
    expect(r).toMatch(/created/)
    expect(events.some((e) => e.type === 'change' && e.c.kind === 'created' && e.c.path === 'new.ts')).toBe(true)
    expect(fs.existsSync(path.join(root, 'new.ts'))).toBe(true)
  })

  it('edits with exact string match', async () => {
    const r = await tk.execute('edit_file', { path: 'src/util.ts', old_string: 'return a + b', new_string: 'return a + b + 0' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/1 replacement/)
    expect(fs.readFileSync(path.join(root, 'src', 'util.ts'), 'utf8')).toContain('a + b + 0')
  })

  it('errors when old_string is missing', async () => {
    const r = await tk.execute('edit_file', { path: 'src/util.ts', old_string: 'NOT THERE', new_string: 'x' }, { callId: 't', agent: 'test' })
    expect(r).toMatch(/not found/i)
  })

  it('requires replace_all for multiple matches', async () => {
    fs.writeFileSync(path.join(root, 'dup.txt'), 'foo\nfoo\n')
    const r1 = await tk.execute('edit_file', { path: 'dup.txt', old_string: 'foo', new_string: 'bar' }, { callId: 't', agent: 'test' })
    expect(r1).toMatch(/occurs 2 times/)
    const r2 = await tk.execute('edit_file', { path: 'dup.txt', old_string: 'foo', new_string: 'bar', replace_all: true }, { callId: 't', agent: 'test' })
    expect(r2).toMatch(/2 replacements/)
  })

  it('reverts a created file (deletes it)', async () => {
    await tk.execute('write_file', { path: 'temp.ts', content: 'x' }, { callId: 't', agent: 'test' })
    expect(tk.revert('temp.ts')).toBe(true)
    expect(fs.existsSync(path.join(root, 'temp.ts'))).toBe(false)
  })

  it('reverts an edited file to its before content', async () => {
    await tk.execute('edit_file', { path: 'hello.txt', old_string: 'line two', new_string: 'CHANGED' }, { callId: 't', agent: 'test' })
    tk.revert('hello.txt')
    // revert is async internally; give the write a tick
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')).toBe('line one\nline two\nline three\n')
  })
})

describe('Toolkit — run_command', () => {
  it('runs a command and reports exit code', async () => {
    const cmd = process.platform === 'win32' ? 'echo hello' : 'echo hello'
    const r = await tk.execute('run_command', { command: cmd, timeout_ms: 15000 }, { callId: 'c1', agent: 'test' })
    expect(r).toMatch(/Exit code: 0/)
    expect(r).toContain('hello')
  }, 20000)
})