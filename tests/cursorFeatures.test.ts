import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { indexRoot, searchCodebaseIndex, getIndexedWorkspace } from '../src/main/agent/codebaseIndexBridge'
import { stripReasoning } from '../src/main/agent/quickLLM'

const THINK_OPEN = '<' + String.fromCharCode(116, 104, 105, 110, 107) + '>'
const THINK_CLOSE = '</' + String.fromCharCode(116, 104, 105, 110, 107) + '>'

describe('codebase index', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'))
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function getUser(id: string) {\n  return db.find(id)\n}\n')
    fs.writeFileSync(path.join(root, 'b.md'), '# docs\ngetUser fetches a user\n')
  })

  it('indexes lines and ranks matches', () => {
    const r = indexRoot(root)
    expect(r.files).toBe(2)
    expect(r.lines).toBeGreaterThan(3)
    expect(getIndexedWorkspace()).toBe(root)
    const hits = searchCodebaseIndex('getUser', 10)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0].text).toContain('getUser')
    expect(hits.every((h) => h.path.endsWith('a.ts') || h.path.endsWith('b.md'))).toBe(true)
  })

  it('requires all terms to match', () => {
    indexRoot(root)
    expect(searchCodebaseIndex('getUser zzzz', 10)).toHaveLength(0)
    expect(searchCodebaseIndex('user fetch', 10).length).toBeGreaterThanOrEqual(1)
  })

  it('returns empty for empty query', () => {
    indexRoot(root)
    expect(searchCodebaseIndex('', 10)).toHaveLength(0)
  })
})

describe('stripReasoning', () => {
  it('removes balanced reasoning blocks', () => {
    const out = stripReasoning(`${THINK_OPEN}internal${THINK_CLOSE}Answer here`)
    expect(out).toBe('Answer here')
  })

  it('removes unbalanced leading blocks', () => {
    const out = stripReasoning(`${THINK_OPEN}thinking without close`)
    expect(out).toBe('')
  })

  it('leaves plain text alone', () => {
    expect(stripReasoning('just code')).toBe('just code')
  })
})