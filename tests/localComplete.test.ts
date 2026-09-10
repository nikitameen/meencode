import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildLocalVocab, localComplete, isVocabReady } from '../src/main/agent/localComplete'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src', 'users.ts'),
    [
      'export interface User { id: string; name: string }',
      'export function getUserById(id: string) {',
      '  return database.find(id)',
      '}',
      'export function getUserByName(name: string) {',
      '  return database.find(name)',
      '}',
      'const userPermissions = loadPermissions()'
    ].join('\n')
  )
  buildLocalVocab(root)
})

describe('local instant completion', () => {
  it('builds vocabulary and reports readiness', () => {
    const r = buildLocalVocab(root)
    expect(r.words).toBeGreaterThan(5)
    expect(r.lines).toBeGreaterThan(0)
    expect(isVocabReady(root)).toBe(true)
    expect(isVocabReady(path.join(root, 'nope'))).toBe(false)
  })

  it('completes a mid-word identifier from workspace vocabulary', () => {
    const r = localComplete('const u = getUserBy', 'typescript')
    expect(['Id', 'Name']).toContain(r)
  })

  it('completes a mid-word identifier even after other words', () => {
    const r = localComplete('export function getUserByI', 'typescript')
    expect(r).toBe('d')
  })

  it('returns empty for tiny inputs', () => {
    expect(localComplete('a', 'typescript')).toBe('')
    expect(localComplete('', 'typescript')).toBe('')
  })

  it('does not suggest the same word being typed', () => {
    const r = localComplete('const getUserById = ', 'typescript')
    expect(r).not.toContain('getUserById = ')
  })
})