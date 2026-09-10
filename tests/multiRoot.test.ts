import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// settingsStore needs electron's app.getPath — stub the module before import
vi.mock('electron', () => ({
  app: {
    getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')),
    getAppPath: () => process.cwd()
  }
}))

const store = await import('../src/main/settingsStore')

let dirA: string
let dirB: string

beforeEach(() => {
  dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'rootA-'))
  dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'rootB-'))
  fs.writeFileSync(path.join(dirA, 'a.txt'), 'A')
  fs.writeFileSync(path.join(dirB, 'b.ts'), 'B')
  store.updateSettings({ roots: [dirA, dirB], workspace: dirA })
})

describe('multi-root workspace', () => {
  it('addRoots merges folders and dedupes', () => {
    const s = store.addRoots([dirA, dirB])
    expect(s.roots).toHaveLength(2)
    const s2 = store.addRoots([dirA])
    expect(s2.roots).toHaveLength(2) // no duplicate
  })

  it('removeRoot removes the right folder', () => {
    const s = store.removeRoot(dirA)
    expect(s.roots).toEqual([path.resolve(dirB)])
    expect(s.workspace).toBe(path.resolve(dirB)) // first root becomes primary
  })

  it('resolveScoped maps "N:rel" to the right root', () => {
    const r = store.resolveScoped('1:b.ts')
    expect(r.abs).toBe(path.join(path.resolve(dirB), 'b.ts'))
    expect(r.root).toBe(path.resolve(dirB))
    expect(r.rel).toBe('b.ts')
    const r2 = store.resolveScoped('0:a.txt')
    expect(r2.abs).toBe(path.join(path.resolve(dirA), 'a.txt'))
  })

  it('unscoped paths resolve against root 0', () => {
    const r = store.resolveScoped('a.txt')
    expect(r.abs).toBe(path.join(path.resolve(dirA), 'a.txt'))
  })

  it('sandbox: scoped escape is blocked per root', () => {
    expect(() => store.resolveScoped('0:../outside.txt')).toThrow(/sandbox/)
    expect(() => store.resolveScoped('2:x')).toThrow(/Unknown workspace folder/)
  })

  it('toScoped finds the owning root index', () => {
    expect(store.toScoped(path.join(dirA, 'a.txt'))).toBe('0:a.txt')
    expect(store.toScoped(path.join(dirB, 'b.ts'))).toBe('1:b.ts')
    expect(store.toScoped(dirA)).toBe('0:')
    expect(() => store.toScoped(path.join(os.tmpdir(), 'elsewhere.txt'))).toThrow(/outside/)
  })

  it('migrates a legacy single workspace into roots', async () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'))
    fs.writeFileSync(path.join(legacy, 'x.md'), 'x')
    const s = store.updateSettings({ roots: [legacy] })
    expect(s.roots).toEqual([path.resolve(legacy)])
    expect(s.workspace).toBe(path.resolve(legacy))
    fs.rmSync(legacy, { recursive: true, force: true })
  })
})