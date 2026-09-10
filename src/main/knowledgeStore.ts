// Knowledge store: rules, instructions, skills and snippets in SQLite.
// Global entries apply everywhere; workspace-scoped entries apply per project.
// Seeded from .meencoderules / .cursorrules / AGENTS.md / CLAUDE.md on first run.
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './sessionStore'

export type KnowledgeKind = 'rule' | 'instruction' | 'skill' | 'snippet'
export const KNOWLEDGE_KINDS: KnowledgeKind[] = ['rule', 'instruction', 'skill', 'snippet']

export interface KnowledgeRow {
  id: number
  kind: KnowledgeKind
  title: string
  content: string
  workspace: string | null   // null = global
  enabled: boolean
  createdAt: number
  updatedAt: number
}

const KIND_DESC: Record<KnowledgeKind, string> = {
  rule: 'Always-follow conventions injected into every agent prompt',
  instruction: 'Persistent directives for the agent (like AGENTS.md)',
  skill: 'Reusable procedures the agent can follow step by step',
  snippet: 'Code patterns to reuse verbatim'
}

export function kindDescription(kind: KnowledgeKind): string {
  return KIND_DESC[kind] ?? ''
}

function ensureTable(): void {
  const db = getDb()
  if (!db) throw new Error('knowledge store requires the session DB')
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      workspace TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_ws ON knowledge(workspace, kind, enabled);
  `)
}

let seeded = false

/** Create the table + seed once from rules files of the given workspace. */
export function ensureKnowledge(workspace: string | null): void {
  const db = getDb()
  if (!db) return
  ensureTable()
  if (seeded || !workspace) return
  seeded = true
  // seed only if the store is completely empty
  const res = db.exec('SELECT COUNT(*) AS n FROM knowledge')
  const count = Number(res[0]?.values[0]?.[0] ?? 0)
  if (count > 0) return
  const files: [string, KnowledgeKind, string][] = [
    ['.meencoderules', 'rule', 'Project rules (.meencoderules)'],
    ['meencoderules.md', 'rule', 'Project rules (meencoderules.md)'],
    ['.cursorrules', 'rule', 'Project rules (.cursorrules)'],
    ['AGENTS.md', 'instruction', 'Agent instructions (AGENTS.md)'],
    ['CLAUDE.md', 'instruction', 'Agent instructions (CLAUDE.md)']
  ]
  for (const [name, kind, title] of files) {
    const p = path.join(workspace, name)
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8')
        if (raw.trim()) addKnowledge({ kind, title, content: raw, workspace, enabled: true })
      }
    } catch { /* unreadable */ }
  }
}

function rowToKnowledge(r: Record<string, unknown>): KnowledgeRow {
  return {
    id: Number(r.id),
    kind: String(r.kind) as KnowledgeKind,
    title: String(r.title ?? ''),
    content: String(r.content ?? ''),
    workspace: r.workspace == null ? null : String(r.workspace),
    enabled: Number(r.enabled ?? 1) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }
}

export interface KnowledgeInput {
  kind: KnowledgeKind
  title: string
  content: string
  workspace: string | null
  enabled: boolean
}

export function addKnowledge(input: KnowledgeInput): KnowledgeRow | null {
  const db = getDb()
  if (!db) return null
  ensureTable()
  const now = Date.now()
  db.run('INSERT INTO knowledge (kind, title, content, workspace, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    input.kind, input.title.slice(0, 160), input.content.slice(0, 50000), input.workspace, input.enabled ? 1 : 0, now, now
  ])
  const res = db.exec('SELECT last_insert_rowid() AS id')
  const id = Number(res[0]?.values[0]?.[0] ?? 0)
  return getKnowledge(id)
}

export function getKnowledge(id: number): KnowledgeRow | null {
  const db = getDb()
  if (!db) return null
  const stmt = db.prepare('SELECT * FROM knowledge WHERE id = ?')
  stmt.bind([id])
  let out: KnowledgeRow | null = null
  if (stmt.step()) out = rowToKnowledge(stmt.getAsObject())
  stmt.free()
  return out
}

/** List entries: global (workspace IS NULL) + the given workspace's own. */
export function listKnowledge(workspace: string | null): KnowledgeRow[] {
  const db = getDb()
  if (!db) return []
  ensureTable()
  const stmt = db.prepare(
    'SELECT * FROM knowledge WHERE workspace IS NULL OR workspace = ? ORDER BY kind ASC, updated_at DESC'
  )
  stmt.bind([workspace ?? ''])
  const out: KnowledgeRow[] = []
  while (stmt.step()) out.push(rowToKnowledge(stmt.getAsObject()))
  stmt.free()
  return out
}

export function updateKnowledge(id: number, patch: Partial<KnowledgeInput>): KnowledgeRow | null {
  const db = getDb()
  if (!db) return null
  const cur = getKnowledge(id)
  if (!cur) return null
  const next = {
    kind: patch.kind ?? cur.kind,
    title: (patch.title ?? cur.title).slice(0, 160),
    content: (patch.content ?? cur.content).slice(0, 50000),
    workspace: patch.workspace !== undefined ? patch.workspace : cur.workspace,
    enabled: patch.enabled ?? cur.enabled
  }
  db.run('UPDATE knowledge SET kind = ?, title = ?, content = ?, workspace = ?, enabled = ?, updated_at = ? WHERE id = ?', [
    next.kind, next.title, next.content, next.workspace, next.enabled ? 1 : 0, Date.now(), id
  ])
  return getKnowledge(id)
}

export function deleteKnowledge(id: number): void {
  const db = getDb()
  if (!db) return
  db.run('DELETE FROM knowledge WHERE id = ?', [id])
}

/** Everything that should be injected into the agent prompt right now. */
export function activeKnowledge(workspace: string | null): KnowledgeRow[] {
  const db = getDb()
  if (!db) return []
  ensureTable()
  const stmt = db.prepare(
    'SELECT * FROM knowledge WHERE enabled = 1 AND (workspace IS NULL OR workspace = ?) ORDER BY kind ASC, updated_at DESC'
  )
  stmt.bind([workspace ?? ''])
  const out: KnowledgeRow[] = []
  while (stmt.step()) out.push(rowToKnowledge(stmt.getAsObject()))
  stmt.free()
  return out
}

/**
 * Build the prompt block from active knowledge, with budgets:
 * rules/instructions 3500 chars total, skills 2500, snippets 1500.
 */
export function buildKnowledgeBlock(workspace: string | null): string {
  const rows = activeKnowledge(workspace)
  if (rows.length === 0) return ''
  const sections: string[] = []
  const byKind = new Map<KnowledgeKind, KnowledgeRow[]>()
  for (const r of rows) {
    const arr = byKind.get(r.kind) ?? []
    arr.push(r)
    byKind.set(r.kind, arr)
  }
  const budgets: Record<KnowledgeKind, number> = { rule: 3500, instruction: 3500, skill: 2500, snippet: 1500 }
  const titles: Record<KnowledgeKind, string> = {
    rule: 'Project rules (stored in the knowledge base — follow strictly)',
    instruction: 'Agent instructions (stored in the knowledge base)',
    skill: 'Skills (reusable procedures)',
    snippet: 'Code patterns to reuse'
  }
  for (const kind of KNOWLEDGE_KINDS) {
    const entries = byKind.get(kind)
    if (!entries || entries.length === 0) continue
    let budget = budgets[kind]
    const lines: string[] = []
    for (const e of entries) {
      if (budget <= 100) break
      const chunk = e.content.slice(0, budget)
      lines.push(`### ${e.title}${e.workspace ? '' : ' (global)'}\n${chunk}`)
      budget -= chunk.length
    }
    if (lines.length > 0) sections.push(`--- ${titles[kind]} ---\n${lines.join('\n\n')}`)
  }
  return sections.join('\n\n')
}

/** Expose a skill by title for the agent to request explicitly. */
export function findSkillByTitle(title: string, workspace: string | null): KnowledgeRow | null {
  const rows = activeKnowledge(workspace).filter((r) => r.kind === 'skill')
  const t = title.trim().toLowerCase()
  const exact = rows.find((r) => r.title.toLowerCase() === t)
  if (exact) return exact
  return rows.find((r) => r.title.toLowerCase().includes(t)) ?? null
}