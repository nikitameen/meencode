// Session persistence: stubbed out (better-sqlite3 removed — it crashed the app).
// All functions are no-ops; session history is no longer persisted across restarts.

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

export async function initSessionDb(): Promise<void> {
  // no-op: persistence disabled
}

export function listSessions(_limit?: number): SessionRow[] {
  return []
}

export function createSession(_id: string, _title: string, _workspace: string | null): void {}

export function appendMessage(_sessionId: string, _role: 'user' | 'assistant' | 'system', _content: string): void {}

export function getSessionMessages(_sessionId: string): SessionMessage[] {
  return []
}

export function deleteSession(_sessionId: string): void {}

export function renameSession(_sessionId: string, _title: string): void {}

export function pruneSessions(): void {}

export function isSessionDbReady(): boolean {
  return false
}

/** minimal shape other stores use; real DB is gone (better-sqlite3 removed). */
export interface DbLike {
  exec(sql: string): void
  prepare(sql: string): any
  transaction(fn: () => void): () => void
}

/** raw handle for other stores to attach tables / share a connection. Always null now. */
export function getDb(): DbLike | null {
  return null
}