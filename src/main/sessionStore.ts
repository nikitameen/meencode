// Session persistence: real SQLite (sql.js WASM) in the main process.
// Stores chat sessions + messages; auto-saves to userData/sessions.db.
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import initSqlJs from 'sql.js'

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

let db: import('sql.js').Database | null = null
let dbFile = ''
let saving = false

export async function initSessionDb(): Promise<void> {
  if (db) return
  const wasmPath = path.join(process.resourcesPath ?? '', 'sql-wasm.wasm')
  const appPath = app.getAppPath()
  // dev: node_modules; packaged: bundled resource
  const wasm =
    fs.existsSync(wasmPath)
      ? wasmPath
      : path.join(appPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  const wasmBinary = fs.readFileSync(wasm)
  const buffer = wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer
  const SQL = await initSqlJs({ wasmBinary: buffer })
  dbFile = path.join(app.getPath('userData'), 'sessions.db')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  if (fs.existsSync(dbFile)) {
    db = new SQL.Database(fs.readFileSync(dbFile))
  } else {
    db = new SQL.Database()
  }
  db.run(`
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
  `)
  persist()
}

function persist(): void {
  if (!db || saving) return
  saving = true
  try {
    const data = Buffer.from(db.export())
    fs.writeFileSync(dbFile, data)
  } catch { /* disk issue — keep in-memory */ } finally {
    saving = false
  }
}

function rowToSession(r: Record<string, unknown>): SessionRow {
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

export function listSessions(limit = 100): SessionRow[] {
  if (!db) return []
  const res = db.exec(`
    SELECT s.id, s.title, s.workspace, s.created_at, s.updated_at,
           COUNT(m.id) AS message_count,
           COALESCE((SELECT content FROM messages WHERE session_id = s.id ORDER BY ts DESC LIMIT 1), '') AS preview
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ${Number(limit) || 100}
  `)
  if (!res[0]) return []
  const cols = res[0].columns
  return res[0].values.map((v) => rowToSession(Object.fromEntries(cols.map((c, i) => [c, v[i]]))))
}

export function createSession(id: string, title: string, workspace: string | null): void {
  if (!db) return
  const now = Date.now()
  db.run('INSERT OR REPLACE INTO sessions (id, title, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id, title.slice(0, 200), workspace, now, now
  ])
  persist()
}

export function appendMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): void {
  if (!db) return
  db.run('INSERT INTO messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)', [
    sessionId, role, content.slice(0, 100000), Date.now()
  ])
  db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [Date.now(), sessionId])
  persist()
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  if (!db) return []
  const stmt = db.prepare('SELECT id, session_id, role, content, ts FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC')
  stmt.bind([sessionId])
  const out: SessionMessage[] = []
  while (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, unknown>
    out.push({
      id: Number(r.id),
      sessionId: String(r.session_id),
      role: String(r.role) as SessionMessage['role'],
      content: String(r.content ?? ''),
      ts: Number(r.ts)
    })
  }
  stmt.free()
  return out
}

export function deleteSession(sessionId: string): void {
  if (!db) return
  db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
  db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
  persist()
}

export function renameSession(sessionId: string, title: string): void {
  if (!db) return
  db.run('UPDATE sessions SET title = ? WHERE id = ?', [title.slice(0, 200), sessionId])
  persist()
}

/** Keep the DB tidy: drop sessions untouched for 90 days, keep max 200. */
export function pruneSessions(): void {
  if (!db) return
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  db.run('DELETE FROM sessions WHERE updated_at < ?', [cutoff])
  const res = db.exec('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT -1 OFFSET 200')
  if (res[0]) {
    for (const v of res[0].values) {
      db.run('DELETE FROM messages WHERE session_id = ?', [String(v[0])])
      db.run('DELETE FROM sessions WHERE id = ?', [String(v[0])])
    }
  }
  persist()
}

/** true when the DB is initialized. */
export function isSessionDbReady(): boolean {
  return db != null
}