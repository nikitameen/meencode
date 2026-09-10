// Knowledge store: SQLite-backed rules, instructions, skills, snippets.
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// init the session DB first (knowledge attaches to the same sql.js handle)
const sessionStore = await import('../src/main/sessionStore')
const knowledge = await import('../src/main/knowledgeStore')

let tmp = ''
let ws = ''

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meencode-kb-'))
  ws = path.join(tmp, 'myproject')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, '.cursorrules'), 'Always use tabs. Never add comments.')
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'Run tests after every change.')
  // point the mock electron's userData at the temp dir
  const mock = await import('./mocks/electron')
  fs.rmSync(mock.app.getPath('userData'), { recursive: true, force: true })
  await sessionStore.initSessionDb()
})

describe('knowledgeStore', () => {
  it('seeds rules files once, then never re-seeds', () => {
    knowledge.ensureKnowledge(ws)
    let list = knowledge.listKnowledge(ws)
    const seeded = list.filter((r) => r.workspace === ws)
    expect(seeded.length).toBe(2) // .cursorrules + AGENTS.md
    expect(seeded.some((r) => r.title.includes('.cursorrules'))).toBe(true)
    expect(seeded.some((r) => r.title.includes('AGENTS.md'))).toBe(true)
    // ensure again — no duplicates
    knowledge.ensureKnowledge(ws)
    list = knowledge.listKnowledge(ws)
    expect(list.filter((r) => r.workspace === ws).length).toBe(2)
  })

  it('adds global and workspace entries and lists both', () => {
    knowledge.addKnowledge({ kind: 'skill', title: 'Release checklist', content: '1. bump version\n2. run tests\n3. tag', workspace: null, enabled: true })
    knowledge.addKnowledge({ kind: 'snippet', title: 'Retry helper', content: 'async function retry(fn, n) {}', workspace: ws, enabled: true })
    const list = knowledge.listKnowledge(ws)
    expect(list.some((r) => r.title === 'Release checklist' && r.workspace === null)).toBe(true)
    expect(list.some((r) => r.title === 'Retry helper' && r.workspace === ws)).toBe(true)
  })

  it('scopes: workspace entries are invisible to other workspaces', () => {
    const other = knowledge.listKnowledge('/some/other/ws')
    expect(other.some((r) => r.title === 'Retry helper')).toBe(false)
    expect(other.some((r) => r.title === 'Release checklist')).toBe(true) // global visible
  })

  it('updateKnowledge edits title/content/enabled', () => {
    const added = knowledge.addKnowledge({ kind: 'rule', title: 'Draft', content: 'old', workspace: ws, enabled: true })!
    const updated = knowledge.updateKnowledge(added.id, { title: 'Final', content: 'new content', enabled: false })
    expect(updated?.title).toBe('Final')
    expect(updated?.content).toBe('new content')
    expect(updated?.enabled).toBe(false)
  })

  it('disabled entries are excluded from the prompt block', () => {
    const before = knowledge.buildKnowledgeBlock(ws)
    const disabled = knowledge.addKnowledge({ kind: 'rule', title: 'Secret rule xyz', content: 'should not appear', workspace: ws, enabled: false })!
    const after = knowledge.buildKnowledgeBlock(ws)
    expect(after).not.toContain('should not appear')
    expect(after.includes('Always use tabs') || before.includes('Always use tabs')).toBe(true)
    knowledge.deleteKnowledge(disabled.id)
  })

  it('buildKnowledgeBlock sections by kind with budgets', () => {
    knowledge.addKnowledge({ kind: 'skill', title: 'Deploy', content: '1. build\n2. upload', workspace: ws, enabled: true })
    const block = knowledge.buildKnowledgeBlock(ws)
    expect(block).toContain('Project rules')
    expect(block).toContain('Skills')
    expect(block).toContain('Deploy')
  })

  it('findSkillByTitle matches exactly then fuzzily', () => {
    expect(knowledge.findSkillByTitle('Deploy', ws)?.title).toBe('Deploy')
    expect(knowledge.findSkillByTitle('deploy', ws)?.title).toBe('Deploy')
    expect(knowledge.findSkillByTitle('nope', ws)).toBeNull()
  })

  it('deleteKnowledge removes entries', () => {
    const added = knowledge.addKnowledge({ kind: 'rule', title: 'Temp', content: 'x', workspace: ws, enabled: true })!
    knowledge.deleteKnowledge(added.id)
    expect(knowledge.getKnowledge(added.id)).toBeNull()
  })
})