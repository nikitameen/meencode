// Session persistence: native on-disk SQLite via better-sqlite3.
// This keeps only queried rows in memory instead of loading the whole DB.
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'

export interface SessionRow {
  id: string
  title: string
  workspace: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
}

export interface SessionMessage {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: number
}

let db: Database.Database | null = null
let dbFile = ''

export async function initSessionDb(): Promise<void> {
  if (db) return
  dbFile = path.join(app.getPath('userData'), 'sessions.db')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);
    CREATE TABLE IF NOT EXISTS query_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT UNIQUE NOT NULL,
      expansions_json TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_query_cache_ts ON query_cache(ts);
  `)
}

export function listSessions(limit = 100): SessionRow[] {
  if (!db) return []
  const stmt = db.prepare(`
    SELECT s.id, s.title, s.workspace, s.created_at, s.updated_at,
           COUNT(m.id) AS message_count,
           COALESCE((SELECT content FROM messages WHERE session_id = s.id ORDER BY ts DESC LIMIT 1), '') AS preview
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ?
  `)
  return stmt.all(Number(limit) || 100).map((r: any) => rowToSession(r))
}

function rowToSession(r: any): SessionRow {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    workspace: r.workspace == null ? null : String(r.workspace),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    messageCount: Number(r.message_count ?? 0),
    preview: String(r.preview ?? '')
  }
}

export function createSession(id: string, title: string, workspace: string | null): void {
  if (!db) return
  const now = Date.now()
  const stmt = db.prepare('INSERT OR REPLACE INTO sessions (id, title, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  stmt.run(id, title.slice(0, 200), workspace, now, now)
}

export function appendMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): void {
  if (!db) return
  const insert = db.prepare('INSERT INTO messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)')
  const update = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
  const now = Date.now()
  db.transaction(() => {
    insert.run(sessionId, role, content.slice(0, 100000), now)
    update.run(now, sessionId)
  })()
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  if (!db) return []
  const stmt = db.prepare('SELECT id, session_id, role, content, ts FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC')
  return stmt.all(sessionId).map((r: any) => ({
    id: Number(r.id),
    sessionId: String(r.session_id),
    role: String(r.role) as SessionMessage['role'],
    content: String(r.content ?? ''),
    ts: Number(r.ts)
  }))
}

export function deleteSession(sessionId: string): void {
  if (!db) return
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

export function renameSession(sessionId: string, title: string): void {
  if (!db) return
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title.slice(0, 200), sessionId)
}

/** Keep the DB tidy: drop sessions untouched for 90 days, keep max 200. */
export function pruneSessions(): void {
  if (!db) return
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff)
  const res = db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT -1 OFFSET 200').all()
  const delMessages = db.prepare('DELETE FROM messages WHERE session_id = ?')
  const delSession = db.prepare('DELETE FROM sessions WHERE id = ?')
  db.transaction(() => {
    for (const row of res) {
      delMessages.run((row as any).id)
      delSession.run((row as any).id)
    }
  })()
}

/** true when the DB is initialized. */
export function isSessionDbReady(): boolean {
  return db != null
}

/** raw handle for other stores to attach tables / share a connection. */
export function getDb(): Database.Database | null {
  return db
}
