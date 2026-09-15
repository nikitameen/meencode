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
  db.exec(`
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
let activeCache: { workspace: string | null; rows: KnowledgeRow[] } | null = null

/** Create the table + seed once from rules files of the given workspace. */
export function ensureKnowledge(workspace: string | null): void {
  const db = getDb()
  if (!db) return
  ensureTable()
  if (seeded || !workspace) return
  seeded = true
  // seed only if the store is completely empty
  const row = db.prepare('SELECT COUNT(*) AS n FROM knowledge').get() as any
  const count = Number(row?.n ?? 0)
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

function rowToKnowledge(r: any): KnowledgeRow {
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
  activeCache = null
  const now = Date.now()
  const info = db.prepare('INSERT INTO knowledge (kind, title, content, workspace, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    input.kind, input.title.slice(0, 160), input.content.slice(0, 50000), input.workspace, input.enabled ? 1 : 0, now, now
  )
  return getKnowledge(Number(info.lastInsertRowid))
}

export function getKnowledge(id: number): KnowledgeRow | null {
  const db = getDb()
  if (!db) return null
  const r = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as any
  return r ? rowToKnowledge(r) : null
}

/** List entries: global (workspace IS NULL) + the given workspace's own. */
export function listKnowledge(workspace: string | null): KnowledgeRow[] {
  const db = getDb()
  if (!db) return []
  ensureTable()
  const rows = db.prepare(
    'SELECT * FROM knowledge WHERE workspace IS NULL OR workspace = ? ORDER BY kind ASC, updated_at DESC'
  ).all(workspace ?? '') as any[]
  return rows.map(rowToKnowledge)
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
  activeCache = null
  db.prepare('UPDATE knowledge SET kind = ?, title = ?, content = ?, workspace = ?, enabled = ?, updated_at = ? WHERE id = ?').run(
    next.kind, next.title, next.content, next.workspace, next.enabled ? 1 : 0, Date.now(), id
  )
  return getKnowledge(id)
}

export function deleteKnowledge(id: number): void {
  const db = getDb()
  if (!db) return
  activeCache = null
  db.prepare('DELETE FROM knowledge WHERE id = ?').run(id)
}

/** Everything that should be injected into the agent prompt right now. Cached per workspace until invalidated. */
export function activeKnowledge(workspace: string | null): KnowledgeRow[] {
  if (activeCache?.workspace === workspace) return activeCache.rows
  const db = getDb()
  if (!db) return []
  ensureTable()
  const rows = db.prepare(
    'SELECT * FROM knowledge WHERE enabled = 1 AND (workspace IS NULL OR workspace = ?) ORDER BY kind ASC, updated_at DESC'
  ).all(workspace ?? '') as any[]
  const out = rows.map(rowToKnowledge)
  activeCache = { workspace, rows: out }
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
      lines.push(`### ${e.title}${e.workspace ? '' : ' (global)'}`)
      lines.push(chunk)
      budget -= chunk.length
    }
    if (lines.length > 0) sections.push(`--- ${titles[kind]} ---\n${lines.join('\n')}`)
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
