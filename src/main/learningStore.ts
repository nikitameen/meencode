// Learning store: the agent's "brain" that improves with usage.
// Captures:
// - explicit feedback (thumbs up/down) on assistant messages
// - correction pairs: agent wrote X, user later wrote Y for the same file
// - learned rules: project-specific patterns extracted from corrections and feedback
// All data is stored in the shared SQLite DB and summarized into prompt-ready rules.
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './sessionStore'
import { buildKnowledgeBlock, addKnowledge, updateKnowledge, activeKnowledge, KnowledgeKind } from './knowledgeStore'

export type FeedbackKind = 'positive' | 'negative'

export interface FeedbackRow {
  id: number
  sessionId: string
  messageId: string
  runId: string
  kind: FeedbackKind
  comment: string | null
  ts: number
}

export interface CorrectionRow {
  id: number
  workspace: string | null
  path: string
  agentAfter: string
  userAfter: string
  agentRunId: string
  ts: number
}

export interface LearnedRuleRow {
  id: number
  workspace: string | null
  rule: string
  evidence: string
  score: number
  ts: number
}

function ensureTable(): void {
  const db = getDb()
  if (!db) throw new Error('learning store requires the session DB')
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      comment TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_feedback_run ON feedback(run_id);

    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT,
      path TEXT NOT NULL,
      agent_after TEXT NOT NULL,
      user_after TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_corrections_workspace ON corrections(workspace, ts);
    CREATE INDEX IF NOT EXISTS idx_corrections_path ON corrections(path, ts);

    CREATE TABLE IF NOT EXISTS learned_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT,
      rule TEXT NOT NULL,
      evidence TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learned_rules_workspace ON learned_rules(workspace, score DESC, ts);
  `)
}

let seeded = false
let rulesCache: { workspace: string | null; text: string; ts: number } | null = null

/** Called once the DB is ready. */
export function initLearning(workspace: string | null): void {
  const db = getDb()
  if (!db) return
  ensureTable()
  if (seeded) return
  seeded = true
  seedFromHistory(workspace)
}

function rowToFeedback(r: any): FeedbackRow {
  return {
    id: Number(r.id),
    sessionId: String(r.session_id),
    messageId: String(r.message_id),
    runId: String(r.run_id),
    kind: String(r.kind) as FeedbackKind,
    comment: r.comment == null ? null : String(r.comment),
    ts: Number(r.ts)
  }
}

function rowToCorrection(r: any): CorrectionRow {
  return {
    id: Number(r.id),
    workspace: r.workspace == null ? null : String(r.workspace),
    path: String(r.path),
    agentAfter: String(r.agent_after),
    userAfter: String(r.user_after),
    agentRunId: String(r.agent_run_id),
    ts: Number(r.ts)
  }
}

function rowToLearnedRule(r: any): LearnedRuleRow {
  return {
    id: Number(r.id),
    workspace: r.workspace == null ? null : String(r.workspace),
    rule: String(r.rule),
    evidence: String(r.evidence),
    score: Number(r.score),
    ts: Number(r.ts)
  }
}

export function addFeedback(sessionId: string, messageId: string, runId: string, kind: FeedbackKind, comment?: string): FeedbackRow | null {
  const db = getDb()
  if (!db) return null
  ensureTable()
  rulesCache = null
  const info = db.prepare(
    'INSERT INTO feedback (session_id, message_id, run_id, kind, comment, ts) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, messageId, runId, kind, comment ?? null, Date.now())
  return getFeedback(Number(info.lastInsertRowid))
}

export function getFeedback(id: number): FeedbackRow | null {
  const db = getDb()
  if (!db) return null
  const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as any
  return r ? rowToFeedback(r) : null
}

export function listFeedback(sessionId: string, limit = 100): FeedbackRow[] {
  const db = getDb()
  if (!db) return []
  ensureTable()
  return db.prepare('SELECT * FROM feedback WHERE session_id = ? ORDER BY ts DESC LIMIT ?').all(sessionId, limit).map(rowToFeedback)
}

export function addCorrection(workspace: string | null, filePath: string, agentAfter: string, userAfter: string, agentRunId: string): CorrectionRow | null {
  const db = getDb()
  if (!db) return null
  ensureTable()
  rulesCache = null
  const info = db.prepare(
    'INSERT INTO corrections (workspace, path, agent_after, user_after, agent_run_id, ts) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(workspace, filePath, agentAfter.slice(0, 50000), userAfter.slice(0, 50000), agentRunId, Date.now())
  return getCorrection(Number(info.lastInsertRowid))
}

export function getCorrection(id: number): CorrectionRow | null {
  const db = getDb()
  if (!db) return null
  const r = db.prepare('SELECT * FROM corrections WHERE id = ?').get(id) as any
  return r ? rowToCorrection(r) : null
}

export function listCorrections(workspace: string | null, limit = 100): CorrectionRow[] {
  const db = getDb()
  if (!db) return []
  ensureTable()
  return db.prepare('SELECT * FROM corrections WHERE workspace IS NULL OR workspace = ? ORDER BY ts DESC LIMIT ?').all(workspace ?? '', limit).map(rowToCorrection)
}

/** Summarize recent feedback + corrections into concise learned rules using the fast model. */
export async function distillRules(workspace: string | null, cfg: { apiKey: string; baseUrl: string; fastModel: string }): Promise<void> {
  const db = getDb()
  if (!db) return
  ensureTable()
  const feedback = listFeedbackForWorkspace(workspace, 50)
  const corrections = listCorrections(workspace, 20)
  if (feedback.length === 0 && corrections.length === 0) return

  const fbText = feedback.length
    ? feedback.map((f) => `[${f.kind}] ${f.comment ?? 'no comment'}`).join('\n')
    : 'No recent feedback.'
  const corrText = corrections.length
    ? corrections.map((c) => `File: ${c.path}\nAgent wrote:\n${preview(c.agentAfter, 400)}\nUser corrected to:\n${preview(c.userAfter, 400)}`).join('\n\n---\n\n')
    : 'No recent corrections.'

  const prompt = `You are a coding tutor observing a junior AI developer. Based on the recent user feedback and user corrections below, write 3-8 concise, actionable rules that the AI should follow from now on when working in this project. Each rule must be a single sentence. Avoid generic advice; focus on patterns specific to the evidence.

Recent feedback:
${fbText}

Recent corrections (agent wrote → user fixed):
${corrText}

Output ONLY the rules, one per line, prefixed with "- ".`

    try {
    const { complete } = await import('./agent/quickLLM')
    const settings = { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.fastModel, fastModel: cfg.fastModel, maxIterations: 30, autoRunCommands: false, workspace: workspace, roots: workspace ? [workspace] : [] }
    const raw = await complete(settings, { system: 'You write concise coding rules. One rule per line. No preamble.', user: prompt, maxTokens: 1200, temperature: 0.2 })
    const lines = raw.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('- '))
    if (lines.length === 0) return
    rulesCache = null
    const now = Date.now()
    const insert = db.prepare('INSERT INTO learned_rules (workspace, rule, evidence, score, ts) VALUES (?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (const line of lines) {
        const rule = line.replace(/^- /, '').trim()
        if (!rule) continue
        insert.run(workspace, rule.slice(0, 400), `auto-distilled from ${feedback.length} feedback + ${corrections.length} corrections`, 1.0, now)
      }
    })()
    syncRulesToKnowledge(workspace)
  } catch (e) {
    console.warn('distillRules failed:', e)
  }
}

function listFeedbackForWorkspace(workspace: string | null, limit = 50): FeedbackRow[] {
  // Feedback is global per session; we don't tie sessions to workspaces in this table,
  // so we return recent global feedback. Corrections are workspace-scoped.
  const db = getDb()
  if (!db) return []
  ensureTable()
  return db.prepare('SELECT * FROM feedback ORDER BY ts DESC LIMIT ?').all(limit).map(rowToFeedback)
}

function preview(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n[...]' : s
}

/** Keep learned rules in sync with the knowledge base so they are auto-injected into prompts. */
function syncRulesToKnowledge(workspace: string | null): void {
  const rules = listLearnedRules(workspace, 50)
  const title = 'Auto-learned project rules'
  const existing = activeKnowledge(workspace).find((r) => r.kind === 'rule' && r.title === title)
  const content = rules.map((r) => `- ${r.rule}`).join('\n')
  if (existing) {
    updateKnowledge(existing.id, { content })
  } else {
    addKnowledge({ kind: 'rule', title, content, workspace, enabled: true })
  }
}

export function listLearnedRules(workspace: string | null, limit = 100): LearnedRuleRow[] {
  const db = getDb()
  if (!db) return []
  ensureTable()
  return db.prepare('SELECT * FROM learned_rules WHERE workspace IS NULL OR workspace = ? ORDER BY score DESC, ts DESC LIMIT ?').all(workspace ?? '', limit).map(rowToLearnedRule)
}

export function getLearnedRule(id: number): LearnedRuleRow | null {
  const db = getDb()
  if (!db) return null
  const r = db.prepare('SELECT * FROM learned_rules WHERE id = ?').get(id) as any
  return r ? rowToLearnedRule(r) : null
}

export function updateRuleScore(id: number, delta: number): LearnedRuleRow | null {
  const db = getDb()
  if (!db) return null
  rulesCache = null
  db.prepare('UPDATE learned_rules SET score = score + ?, ts = ? WHERE id = ?').run(delta, Date.now(), id)
  syncRulesToKnowledge(getWorkspaceFromRuleId(id))
  return getLearnedRule(id)
}

function getWorkspaceFromRuleId(id: number): string | null {
  const r = getLearnedRule(id)
  return r?.workspace ?? null
}

/** Build the prompt block of learned rules (cached per workspace). */
export function buildLearningBlock(workspace: string | null): string {
  if (rulesCache?.workspace === workspace) return rulesCache.text
  const rules = listLearnedRules(workspace, 30)
  let text = ''
  if (rules.length > 0) {
    text = `--- Learned project rules (from your feedback and corrections) ---\n${rules.map((r) => `- ${r.rule}`).join('\n')}`
  }
  // Also merge in the auto-synced knowledge block if present
  const kb = buildKnowledgeBlock(workspace)
  if (kb) {
    text = text ? `${text}\n\n${kb}` : kb
  }
  rulesCache = { workspace, text, ts: Date.now() }
  return text
}

export function invalidateLearningCache(): void {
  rulesCache = null
}

/** Seed from any existing LEARNED_RULES.md or feedback file in the workspace. */
function seedFromHistory(workspace: string | null): void {
  if (!workspace) return
  const files: [string, string][] = [
    ['LEARNED_RULES.md', 'Auto-learned project rules'],
    ['.meencode/feedback.md', 'User feedback history']
  ]
  for (const [name, title] of files) {
    const p = path.join(workspace, name)
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8')
        if (raw.trim()) {
          addKnowledge({ kind: 'rule', title, content: raw, workspace, enabled: true })
        }
      }
    } catch { /* ignore */ }
  }
}
