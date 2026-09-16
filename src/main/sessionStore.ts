// Session persistence: SQLite via sql.js (WebAssembly). No native modules, works in Electron + Node.
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

let db: any = null
let dbFile = ''
let sqlPromise: Promise<any> | null = null

function wasmPath(): string {
  return path.join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm')
}

function ensureSql(): Promise<any> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmPath() })
  }
  return sqlPromise
}

function loadDbBuffer(): Uint8Array | undefined {
  try {
    if (fs.existsSync(dbFile)) {
      return new Uint8Array(fs.readFileSync(dbFile))
    }
  } catch (e) {
    console.warn('failed to load session db file:', (e as Error).message)
  }
  return undefined
}

function saveDb(): void {
  if (!db) return
  try {
    const data = db.export() as Uint8Array
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    fs.writeFileSync(dbFile, Buffer.from(data))
  } catch (e) {
    console.warn('failed to save session db:', (e as Error).message)
  }
}

function execOne(sql: string, params?: any[]): { [key: string]: any } | null {
  if (!db) return null
  const res = db.exec(sql, params)
  if (!res || !res[0] || !res[0].values || !res[0].values[0]) return null
  const cols = res[0].columns
  return Object.fromEntries(res[0].values[0].map((v: any, i: number) => [cols[i], v]))
}

function execAll(sql: string, params?: any[]): any[] {
  if (!db) return []
  const res = db.exec(sql, params)
  if (!res || !res[0]) return []
  const cols = res[0].columns
  return res[0].values.map((row: any[]) => Object.fromEntries(row.map((v, i) => [cols[i], v])))
}

function run(sql: string, params?: any[]): void {
  if (!db) return
  db.run(sql, params)
  saveDb()
}

// ---------------- better-sqlite3 compatible shim (sql.js) ----------------
// Drop-in replacement for the old better-sqlite3 API: prepare().get/.all/.run,
// lastInsertRowid, and db.transaction(). Keeps call sites unchanged.

interface ShimStmt {
  get: (...params: any[]) => any | null
  all: (...params: any[]) => any[]
  run: (...params: any[]) => { changes: number; lastInsertRowid: number }
}

function wrapStmt(rawDb: any, rawStmt: any): ShimStmt {
  return {
    get: (...params: any[]) => {
      rawStmt.bind(params)
      const found = rawStmt.step()
      const out = found ? rawStmt.getAsObject() : null
      rawStmt.reset()
      return out
    },
    all: (...params: any[]) => {
      rawStmt.bind(params)
      const out: any[] = []
      while (rawStmt.step()) out.push(rawStmt.getAsObject())
      rawStmt.reset()
      return out
    },
    run: (...params: any[]) => {
      rawStmt.bind(params)
      rawStmt.step()
      rawStmt.reset()
      const r = rawDb.exec('SELECT last_insert_rowid() AS id, changes() AS n')
      const id = r?.[0]?.values?.[0]?.[0]
      const n = r?.[0]?.values?.[0]?.[1]
      return { changes: Number(n ?? 0), lastInsertRowid: Number(id ?? 0) }
    }
  }
}

function wrapDb(raw: any): void {
  raw.prepare = ((sql: string) => wrapStmt(raw, raw.__prepare__(sql))) as any
  raw.transaction = (fn: (...args: any[]) => any) => {
    return (...args: any[]) => {
      raw.run('BEGIN TRANSACTION')
      try {
        const out = fn(...args)
        raw.run('COMMIT')
        saveDb()
        return out
      } catch (e) {
        try { raw.run('ROLLBACK') } catch { /* ignore */ }
        throw e
      }
    }
  }
}

export async function initSessionDb(): Promise<void> {
  if (db) return
  dbFile = path.join(app.getPath('userData'), 'sessions.db')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const SQL = await ensureSql()
  db = new SQL.Database(loadDbBuffer())
  // sql.js prepare -> __prepare__; expose better-sqlite3-style prepare().get/.all/.run
  const raw = db as any
  raw.__prepare__ = raw.prepare.bind(raw)
  wrapDb(raw)
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
  saveDb()
}

export function listSessions(limit = 100): SessionRow[] {
  if (!db) return []
  const rows = execAll(`
    SELECT s.id, s.title, s.workspace, s.created_at, s.updated_at,
           COUNT(m.id) AS message_count,
           COALESCE((SELECT content FROM messages WHERE session_id = s.id ORDER BY ts DESC LIMIT 1), '') AS preview
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ?
  `, [Number(limit) || 100])
  return rows.map(rowToSession)
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
  run('INSERT OR REPLACE INTO sessions (id, title, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, title.slice(0, 200), workspace, now, now])
}

export function appendMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string): void {
  if (!db) return
  const now = Date.now()
  db.run('BEGIN TRANSACTION')
  try {
    db.run('INSERT INTO messages (session_id, role, content, ts) VALUES (?, ?, ?, ?)',
      [sessionId, role, content.slice(0, 100000), now])
    db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, sessionId])
    db.run('COMMIT')
    saveDb()
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  if (!db) return []
  const rows = execAll('SELECT id, session_id, role, content, ts FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC', [sessionId])
  return rows.map((r: any) => ({
    id: Number(r.id),
    sessionId: String(r.session_id),
    role: String(r.role) as SessionMessage['role'],
    content: String(r.content ?? ''),
    ts: Number(r.ts)
  }))
}

export function deleteSession(sessionId: string): void {
  if (!db) return
  db.run('BEGIN TRANSACTION')
  try {
    db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
    db.run('COMMIT')
    saveDb()
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
}

export function renameSession(sessionId: string, title: string): void {
  if (!db) return
  run('UPDATE sessions SET title = ? WHERE id = ?', [title.slice(0, 200), sessionId])
}

/** Keep the DB tidy: drop sessions untouched for 90 days, keep max 200. */
export function pruneSessions(): void {
  if (!db) return
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  db.run('BEGIN TRANSACTION')
  try {
    db.run('DELETE FROM sessions WHERE updated_at < ?', [cutoff])
    const res = execAll('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT -1 OFFSET 200')
    for (const row of res) {
      db.run('DELETE FROM messages WHERE session_id = ?', [row.id])
      db.run('DELETE FROM sessions WHERE id = ?', [row.id])
    }
    db.run('COMMIT')
    saveDb()
  } catch (e) {
    try { db.run('ROLLBACK') } catch { /* ignore */ }
  }
}

/** true when the DB is initialized. */
export function isSessionDbReady(): boolean {
  return db != null
}

/** raw handle for other stores to attach tables / share a connection. */
export function getDb(): any | null {
  return db
}
