// Access graph: the agent's behavioral telemetry.
// Every tool call that touches a file (read/grep/edit/write/delete) is logged
// per (workspace, request-hash). Aggregated into a decay-weighted behavior
// prior: which files this project's work actually touches, per topic.
// This is the signal no other tool has — retrieval ranking learns from usage.
import crypto from 'node:crypto'
import { getDb } from './sessionStore'

export type AccessKind = 'read' | 'grep' | 'search' | 'edit' | 'write' | 'delete'

export interface AccessRow {
  id: number
  workspace: string
  requestHash: string
  rel: string
  kind: AccessKind
  weight: number
  ts: number
}

export interface AccessPrior {
  rel: string
  score: number
  reads: number
  edits: number
}

const HALF_LIFE_DAYS = 14
const KIND_WEIGHT: Record<AccessKind, number> = {
  read: 1,
  grep: 0.6,
  search: 0.3,
  edit: 2.5,
  write: 2.5,
  delete: 0.5
}

function ensureTable(): void {
  const db = getDb()
  if (!db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      rel TEXT NOT NULL,
      kind TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_access_ws_rel ON agent_access(workspace, rel, ts);
    CREATE INDEX IF NOT EXISTS idx_access_req ON agent_access(workspace, request_hash);
  `)
}

/** Stable short hash of a user request (topic key for the graph). */
export function requestHashOf(text: string): string {
  const norm = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .sort()
    .join(' ')
  return norm ? crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16) : 'empty'
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'what', 'when', 'how', 'why',
  'can', 'could', 'should', 'would', 'make', 'made', 'does', 'did', 'done', 'have', 'has',
  'please', 'need', 'want', 'about', 'into', 'from', 'are', 'was', 'were', 'will', 'there',
  'then', 'than', 'them', 'they', 'its', 'just', 'now', 'get', 'got', 'use', 'using', 'add',
  'fix', 'fixing', 'change', 'update', 'refactor', 'look', 'see', 'try', 'like', 'some',
  'bug', 'not', 'but', 'all', 'any', 'too', 'very'
])

let flushTimer: NodeJS.Timeout | null = null
const pending: AccessRow[] = []

/** Queue one access record; batched insert + periodic pruning to keep the DB cheap. */
export function recordAccess(workspace: string, requestHash: string, rel: string, kind: AccessKind): void {
  if (!getDb() || !rel) return
  ensureTable()
  pending.push({ id: 0, workspace, requestHash, rel: rel.slice(0, 300), kind, weight: 0, ts: Date.now() })
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPending()
  }, 2000)
}

function flushPending(): void {
  const db = getDb()
  if (!db || pending.length === 0) return
  const batch = pending.splice(0, pending.length)
  try {
    db.exec('BEGIN TRANSACTION')
    for (const r of batch) {
      db.run('INSERT INTO agent_access (workspace, request_hash, rel, kind, ts) VALUES (?, ?, ?, ?, ?)',
        [r.workspace, r.requestHash, r.rel, r.kind, r.ts])
    }
    db.exec('COMMIT')
  } catch {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
  }
}

/** Drop rows older than N half-lives; cap rows per workspace. Best-effort, periodic. */
export function pruneAccess(maxAgeDays = 90): void {
  const db = getDb()
  if (!db) return
  try {
    db.run('DELETE FROM agent_access WHERE ts < ?', [Date.now() - maxAgeDays * 86400000])
  } catch { /* table may not exist */ }
}

/**
 * Behavior prior for a request: files historically touched by similar requests.
 * score = sum over rows of kindWeight * 2^(-ageDays / HALF_LIFE).
 */
export function accessPrior(workspace: string, requestHash: string, limit = 10): AccessPrior[] {
  const db = getDb()
  if (!db) return []
  try {
    const res = db.exec(
      `SELECT rel, kind, ts FROM agent_access
       WHERE workspace = ? AND request_hash = ?
       ORDER BY ts DESC LIMIT 2000`,
      [workspace, requestHash]
    )
    if (!res || !res[0]) return []
    const cols = res[0].columns
    const now = Date.now()
    const agg = new Map<string, AccessPrior>()
    for (const row of res[0].values) {
      const r = Object.fromEntries(row.map((v: any, i: number) => [cols[i], v]))
      const rel = String(r.rel)
      const kind = String(r.kind) as AccessKind
      const ageDays = Math.max(0, (now - Number(r.ts)) / 86400000)
      const decay = Math.pow(2, -ageDays / HALF_LIFE_DAYS)
      const w = (KIND_WEIGHT[kind] ?? 1) * decay
      let cur = agg.get(rel)
      if (!cur) {
        cur = { rel, score: 0, reads: 0, edits: 0 }
        agg.set(rel, cur)
      }
      cur.score += w
      if (kind === 'edit' || kind === 'write') cur.edits++
      else if (kind === 'read') cur.reads++
    }
    return [...agg.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  } catch {
    return []
  }
}

/** Global hot files for a workspace (all requests) — useful as a fallback prior. */
export function hotFiles(workspace: string, limit = 10): AccessPrior[] {
  const db = getDb()
  if (!db) return []
  try {
    const res = db.exec(
      `SELECT rel, kind, ts FROM agent_access
       WHERE workspace = ?
       ORDER BY ts DESC LIMIT 10000`,
      [workspace]
    )
    if (!res || !res[0]) return []
    const cols = res[0].columns
    const now = Date.now()
    const agg = new Map<string, AccessPrior>()
    for (const row of res[0].values) {
      const r = Object.fromEntries(row.map((v: any, i: number) => [cols[i], v]))
      const rel = String(r.rel)
      const kind = String(r.kind) as AccessKind
      const ageDays = Math.max(0, (now - Number(r.ts)) / 86400000)
      const w = (KIND_WEIGHT[kind] ?? 1) * Math.pow(2, -ageDays / HALF_LIFE_DAYS)
      let cur = agg.get(rel)
      if (!cur) {
        cur = { rel, score: 0, reads: 0, edits: 0 }
        agg.set(rel, cur)
      }
      cur.score += w
      if (kind === 'edit' || kind === 'write') cur.edits++
      else if (kind === 'read') cur.reads++
    }
    return [...agg.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  } catch {
    return []
  }
}

/** Row count for diagnostics/tests. Flushes pending writes first. */
export function accessStats(workspace: string): number {
  flushPending()
  const db = getDb()
  if (!db) return 0
  try {
    const res = db.exec('SELECT COUNT(*) AS n FROM agent_access WHERE workspace = ?', [workspace])
    const n = res?.[0]?.values?.[0]?.[0]
    return Number(n ?? 0)
  } catch {
    return 0
  }
}

/** Test hook: force-flush the pending queue. */
export function flushAccessForTest(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushPending()
}