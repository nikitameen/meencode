import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as git from '../src/main/gitCore'
import { copyIntoWorkspace } from '../src/main/importCore'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('git integration (real git CLI)', () => {
  it('init -> stage -> commit -> state reflects changes', async () => {
    expect(git.isRepo(root)).toBe(false)
    await git.initFor(root)
    expect(git.isRepo(root)).toBe(true)

    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
    let state = await git.stateFor(root)
    expect(state.repo).toBe(true)
    expect(['master', 'main']).toContain(state.branch)
    expect(state.files.some((f) => f.path === 'a.txt' && f.untracked)).toBe(true)

    await git.stageFor(root, 'a.txt')
    state = await git.stateFor(root)
    expect(state.files.some((f) => f.path === 'a.txt' && f.staged)).toBe(true)

    await git.commitFor(root, 'first commit')
    state = await git.stateFor(root)
    expect(state.files).toHaveLength(0)

    const log = await git.logFor(root)
    expect(log.length).toBeGreaterThanOrEqual(1)
    expect(log[0]).toMatch(/^[0-9a-f]{7,} first commit$/)
  }, 30000)

  it('discard restores file content after edit', async () => {
    await git.initFor(root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'original\n')
    await git.stageFor(root, 'b.txt')
    await git.commitFor(root, 'add b')
    fs.writeFileSync(path.join(root, 'b.txt'), 'changed\n')
    await git.discardFor(root, 'b.txt')
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8').trim()).toBe('original')
  }, 30000)

  it('unstage returns file to untracked/modified', async () => {
    await git.initFor(root)
    fs.writeFileSync(path.join(root, 'c.txt'), 'x\n')
    await git.stageFor(root, 'c.txt')
    await git.unstageFor(root, 'c.txt')
    const state = await git.stateFor(root)
    expect(state.files.some((f) => f.path === 'c.txt' && !f.staged)).toBe(true)
  }, 30000)
})

describe('import into workspace', () => {
  it('copies a file into the workspace root', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'))
    const src = path.join(external, 'note.md')
    fs.writeFileSync(src, '# hello')
    const r = copyIntoWorkspace(src, root)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'note.md'), 'utf8')).toBe('# hello')
    fs.rmSync(external, { recursive: true, force: true })
  })

  it('copies a folder recursively and refuses duplicates', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'))
    fs.mkdirSync(path.join(external, 'proj'))
    fs.writeFileSync(path.join(external, 'proj', 'a.ts'), 'export {}')
    fs.mkdirSync(path.join(external, 'proj', 'sub'))
    fs.writeFileSync(path.join(external, 'proj', 'sub', 'b.ts'), 'export {}')
    const r = copyIntoWorkspace(path.join(external, 'proj'), root)
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(root, 'proj', 'a.ts'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'proj', 'sub', 'b.ts'))).toBe(true)
    // second import must refuse overwrite
    const r2 = copyIntoWorkspace(path.join(external, 'proj'), root)
    expect(r2.ok).toBe(false)
    expect(r2.reason).toBe('exists')
    fs.rmSync(external, { recursive: true, force: true })
  })
})