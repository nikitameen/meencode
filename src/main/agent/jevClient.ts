import type { Settings } from '../../shared/types'
import { proxySafeFetch } from '../proxyFetch'

/** Jev AI — typed decision layer. POST /v1/systemone: one state, many typed
 *  questions, answers with probabilities. NOT a chat endpoint: it cannot drive
 *  the agent loop; it makes the loop FASTER by answering bounded decisions
 *  (command safety, task difficulty routing) without a full LLM round-trip. */

const JEV_BASE = 'https://thejevai.com'

export type JevQuestion =
  | { type: 'noul'; instructions: string | object; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string | object; criteria: Record<string, string | object | null> }
  | { type: 'score'; instructions: string | object; criteria: (string | object)[] }

export interface JevAnswerNoul { type: 'noul'; noul: number }
export interface JevAnswerChoice { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface JevAnswerScore { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export type JevAnswer = JevAnswerNoul | JevAnswerChoice | JevAnswerScore

export function jevConfigured(settings: Settings): boolean {
  return Boolean(settings.jevApiKey)
}

/** Ask Jev one or more typed questions about a state. Returns answers keyed by
 *  question id, or null on any failure (callers must treat null as "no signal"
 *  and fall back, never as yes/no). */
export async function jevDecide(
  settings: Settings,
  state: string | object,
  questions: Record<string, JevQuestion>,
  timeoutMs = 8000
): Promise<Record<string, JevAnswer> | null> {
  if (!settings.jevApiKey) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await proxySafeFetch(`${JEV_BASE}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.jevApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      signal: controller.signal
    })
    if (res.status === 401 || res.status === 403) return null
    if (!res.ok) return null
    const j: any = await res.json()
    const answers = j?.data?.result?.answers ?? j?.result?.answers ?? j?.answers
    return answers ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** yes-probability for a noul question, or null when unavailable. */
export function jevNoul(answers: Record<string, JevAnswer> | null, id: string): number | null {
  const a = answers?.[id]
  if (!a || a.type !== 'noul') return null
  const v = Number(a.noul)
  return Number.isFinite(v) ? v : null
}

// ---------------- command safety gate ----------------

/** instant local pre-filter: commands that are obviously safe read-only
 *  inspection skip the Jev call entirely; obviously dangerous ones skip
 *  straight to human approval. Anything ambiguous goes to Jev.
 *  NOTE: the safe pattern forbids shell operators (&, |, <, >) — any chained,
 *  piped, or redirected command is never locally "safe" and goes to Jev. */
const SAFE_RE = /^(?:git\s+(?:status|log|diff|branch|show|remote|rev-parse|blame)\b|ls\b|dir\b|pwd\b|cat\b|type\b|head\b|tail\b|wc\b|echo\b|find\s|ripgrep\b|rg\b|node\s+--version|npm\s+(?:ls|list|view|root|config\s+get)\b|npx\s+tsc\b|tsc\b|pytest\s+--collect-only\b)(?:\s[^&|<>]*)?$/i

const DANGEROUS_RE = /(?:\brm\s+-rf\b|\bdel\s+\/[sq]\b|\brd\s+\/s\b|\bformat\b|\bmkfs\b|\bdd\s+if=|:\(\)\{.*\};:|\bcurl\b[^|]*\|\s*(?:ba)?sh\b|\bwget\b[^|]*\|\s*(?:ba)?sh\b|\|\s*(?:ba)?sh\b|\bgit\s+push\s+--force\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[fx]d\b|\bshutdown\b|\breboot\b)/i

export type CommandVerdict = 'safe' | 'risky' | 'unknown'

export function localCommandVerdict(command: string): CommandVerdict {
  const cmd = command.trim()
  if (!cmd) return 'risky'
  if (DANGEROUS_RE.test(cmd)) return 'risky'
  if (SAFE_RE.test(cmd)) return 'safe'
  return 'unknown'
}

/** Jev risk gate for shell commands. Fast path: local regex decides obvious
 *  cases in 0ms; ambiguous commands ask Jev one noul question (~1s). Never
 *  throws — unknown means "ask the human". */
export async function jevCommandVerdict(settings: Settings, command: string): Promise<CommandVerdict> {
  const local = localCommandVerdict(command)
  if (local !== 'unknown') return local
  const answers = await jevDecide(
    settings,
    {
      command,
      context: 'A coding agent working inside the user\'s workspace sandbox wants to run this shell command.'
    },
    {
      safe_to_autorun: {
        type: 'noul',
        instructions: 'Is this command safe to auto-run without human approval? Safe: read-only inspection, builds, tests, linters, formatters, git read operations, installs into the local project. Unsafe: deletes or overwrites user data, force-pushes, resets hard, mutates system config, touches anything outside the workspace, network write operations, or anything irreversible.',
        criteria: {
          true: 'Read-only or easily reversible, confined to the workspace',
          false: 'Destructive, irreversible, or affects anything outside the workspace'
        }
      }
    },
    6000
  )
  const p = jevNoul(answers, 'safe_to_autorun')
  if (p === null) return 'unknown'
  // conservative threshold: auto-run only when Jev is confidently sure it is safe
  if (p >= 0.9) return 'safe'
  if (p <= 0.35) return 'risky'
  return 'unknown'
}

// ---------------- task difficulty routing ----------------

/** Jev difficulty gate for sub-agent tasks: send easy tasks to the fast model,
 *  hard ones to the big model — instead of guessing by role. */
export async function jevTaskNeedsBigModel(settings: Settings, agent: string, task: string): Promise<boolean | null> {
  const answers = await jevDecide(
    settings,
    { agent, task },
    {
      difficulty: {
        type: 'noul',
        instructions: 'Does this coding-agent task need the strong/big model for correctness? Big model needed for: complex multi-file refactors, subtle bug diagnosis, security-sensitive changes, architectural decisions, ambiguous requirements. Fast model suffices for: simple edits, boilerplate generation, reading and summarizing, straightforward tests, simple renames.',
        criteria: {
          true: 'Complex, subtle, or high-stakes — needs the strong model',
          false: 'Simple, mechanical, or read-only — the fast model is enough'
        }
      }
    },
    6000
  )
  const p = jevNoul(answers, 'difficulty')
  if (p === null) return null
  return p >= 0.6
}