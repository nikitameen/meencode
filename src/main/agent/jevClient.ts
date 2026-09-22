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

// ---------------- code-focus partner ----------------

/** Jev completion analytics: given the user's request and what actually
 *  changed on disk, decide whether the work is genuinely DONE. This is the
 *  quality gate that stops both premature "Done!" claims and endless
 *  polishing. Returns 'complete' | 'fix' | null (null = Jev unavailable,
 *  caller falls back to its own heuristics). */
export async function jevCompletionVerdict(
  settings: Settings,
  request: string,
  changes: { path: string; kind: string; afterExcerpt: string }[],
  finalText: string
): Promise<'complete' | 'fix' | null> {
  if (changes.length === 0) return null // nothing to analyze — heuristics handle it
  const answers = await jevDecide(
    settings,
    {
      request,
      changes: changes.map((c) => ({ path: c.path, kind: c.kind, content: c.afterExcerpt.slice(0, 800) })),
      agentFinalReply: finalText.slice(0, 600)
    },
    {
      done: {
        type: 'choice',
        instructions: 'A coding agent claims it finished the user request. Compare the request with the ACTUAL file changes shown. Is the requested behavior genuinely implemented and coherent? complete = changes plausibly fulfill the request. fix = changes are partial, miss the point, break something, or contradict the request.',
        criteria: {
          complete: 'The changes plausibly implement what was asked',
          fix: 'The changes are incomplete, off-target, or visibly broken'
        }
      }
    },
    8000
  )
  const ans = (answers as Record<string, any> | null)?.done
  if (!ans || ans.type !== 'choice') return null
  return ans.choice === 'complete' ? 'complete' : 'fix'
}

/** Jev exploration sufficiency: should the agent keep exploring the codebase
 *  or start editing? Stops wasteful read-loops. Returns 'edit' | 'explore' |
 *  null (null = no signal, caller default). */
export async function jevExplorationVerdict(
  settings: Settings,
  request: string,
  recentToolCalls: string[],
  turnsWithoutEdit: number
): Promise<'edit' | 'explore' | null> {
  // only consult Jev once wandering becomes suspicious
  if (turnsWithoutEdit < 3) return null
  const answers = await jevDecide(
    settings,
    { request, recentToolCalls, turnsWithoutEdit },
    {
      next: {
        type: 'choice',
        instructions: 'A coding agent is working on the request and has only been reading/searching so far. Based on the request and the files it examined, does it have ENOUGH context to edit correctly now, or does it genuinely need more exploration? edit = enough context — start editing. explore = the request touches areas not yet examined.',
        criteria: {
          edit: 'The examined files plausibly cover what the request needs',
          explore: 'Key areas for this request have not been examined yet'
        }
      }
    },
    7000
  )
  const ans = (answers as Record<string, any> | null)?.next
  if (!ans || ans.type !== 'choice') return null
  return ans.choice === 'edit' ? 'edit' : 'explore'
}

/** Jev as the agent's coding partner: one call classifies the user's intent
 *  and returns a short focus directive injected into the run so the agent
 *  writes code instead of narrating. Returns null when Jev is unavailable —
 *  the caller just skips the directive. */
export async function jevFocusDirective(settings: Settings, userText: string): Promise<string | null> {
  const answers = await jevDecide(
    settings,
    { request: userText },
    {
      intent: {
        type: 'choice',
        instructions: 'Classify the user\'s request to a coding agent by what they mainly want. edit = change/add/fix code or files. explain = understand code, architecture, or behavior. run = execute/verify via commands or tests. review = audit quality/bugs of existing code. setup = configure, scaffold, or install. chat = anything else.',
        criteria: {
          edit: 'Wants code or files changed, created, fixed, or refactored',
          explain: 'Wants an explanation or understanding of existing code',
          run: 'Wants commands, builds, or tests executed',
          review: 'Wants existing code audited for bugs or quality',
          setup: 'Wants configuration, scaffolding, or installation',
          chat: 'General conversation, no concrete code work'
        }
      },
      ambiguity: {
        type: 'noul',
        instructions: 'Is the request underspecified for direct implementation — would a careful engineer need to ask a clarifying question before writing correct code?',
        criteria: {
          true: 'Requirements are vague, contradictory, or missing key details',
          false: 'The request is specific enough to implement directly'
        }
      }
    },
    7000
  )
  const ans = answers as Record<string, any> | null
  if (!ans?.intent || ans.intent.type !== 'choice') return null
  const intent = String(ans.intent.choice ?? 'edit')
  const ambiguous = jevNoul(answers, 'ambiguity') ?? 0

  switch (intent) {
    case 'edit':
      return ambiguous >= 0.75
        ? 'FOCUS (Jev partner): the request is underspecified. Read the relevant files FIRST with read_file, infer the most reasonable interpretation from the code, implement it, and state the interpretation you chose in ONE sentence at the end. Do not ask questions unless implementation is impossible.'
        : 'FOCUS (Jev partner): this is a code-change request. Go straight to edits: read only what is needed (1-2 calls), then write_file/edit_file. No plan narration, no step summaries — code first, one-line confirmation after.'
    case 'run':
      return 'FOCUS (Jev partner): this is a run/verify request. Execute the commands/tests with run_command, report exit codes and failures concisely, and fix what fails if the fix is obvious.'
    case 'review':
      return 'FOCUS (Jev partner): this is a code-review request. Read the target code, list concrete findings (file:line, issue, suggested fix), and only apply edits if the user asked for fixes.'
    case 'setup':
      return 'FOCUS (Jev partner): this is a setup/scaffold request. Create or modify the config files directly, verify the setup works, and report what was configured in one line each.'
    case 'explain':
      return 'FOCUS (Jev partner): this is an explanation request. Answer directly from the code (read files as needed). No edits — cite file:line for every claim.'
    default:
      return 'FOCUS (Jev partner): answer the user directly and concisely.'
  }
}