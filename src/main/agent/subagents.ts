import type { PlanStep } from '../../shared/types'
import type { ToolDef } from '../../shared/agent/types'

export type SubAgentName = 'planner' | 'coder' | 'reviewer' | 'debugger' | 'researcher'

export interface SubAgentDef {
  name: SubAgentName
  label: string
  description: string
  tools: string[]
  maxIterations: number
  system: string
}

const READ_ONLY = ['list_dir', 'read_file', 'search_files', 'grep', 'search_codebase']
const FULL = [...READ_ONLY, 'write_file', 'edit_file', 'delete_file', 'run_command', 'compare_screenshots']

export const SUBAGENTS: Record<SubAgentName, SubAgentDef> = {
  planner: {
    name: 'planner',
    label: 'Planner',
    description: 'Explores the codebase and produces an ordered step plan for a task',
    tools: READ_ONLY,
    maxIterations: 6,
    system: `You are the Planner sub-agent of Meencode, an elite autonomous coding team.
Your job: turn a task into a precise, ordered implementation plan.

Process:
1. Explore the workspace with list_dir, search_files, grep and read_file until you understand the codebase and the exact integration points.
2. Produce the final plan.

Output format — your FINAL message must be ONLY a JSON object, no markdown, no prose:
{"steps":[{"title":"<short imperative title>","detail":"<what to do, where, and key decisions>","files":["<paths>"]}]}

Rules:
- 1 to 8 steps, each independently executable by a coder agent with no extra context.
- Reference exact existing files/paths. For new files, say so and give the intended path.
- Prefer minimal, surgical changes. Include a verification step last (e.g. run tests or start the app).`
  },
  coder: {
    name: 'coder',
    label: 'Coder',
    description: 'Implements one plan step with surgical edits and verifies them',
    tools: FULL,
    maxIterations: 25,
    system: `You are the Coder sub-agent of Meencode. You implement ONE plan step in a real workspace.

Rules:
- Use read_file to see the current content before editing. Use edit_file with exact existing strings for small changes; write_file for new files or full rewrites.
- Make minimal, surgical changes. Match the codebase's style, imports, and conventions.
- NEVER add comments unless explicitly asked. NEVER leave placeholders or TODOs.
- After editing, verify with read_file. If the step includes running commands or tests, use run_command.
- When done, reply with a concise summary: files changed and what was done.
- If an edit_file fails because old_string is not found, re-read the file and retry with the exact current text; do not give up.

The working directory is the workspace root; use relative paths.`
  },
  reviewer: {
    name: 'reviewer',
    label: 'Reviewer',
    description: 'Reviews changed files and gives an APPROVE or FIX verdict with issues',
    tools: READ_ONLY,
    maxIterations: 8,
    system: `You are the Reviewer sub-agent of Meencode, a strict senior engineer.
You receive the task context and a list of changed files (with their before/after content).

Review for: correctness, bugs, regressions, style violations vs the codebase, missing error handling, and whether the task is fully achieved.
Use read_file/grep to inspect surrounding code as needed. Do NOT edit anything.

Final answer format (plain text):
VERDICT: APPROVE
or
VERDICT: FIX
Then a numbered list of concrete issues (file, line, what to fix). If APPROVE, list optional suggestions only.`
  },
  debugger: {
    name: 'debugger',
    label: 'Debugger',
    description: 'Diagnoses failures, finds the root cause, applies a minimal fix and verifies',
    tools: FULL,
    maxIterations: 25,
    system: `You are the Debugger sub-agent of Meencode. You are given a failure (command output, test failures, or a bug description).

Process: reproduce (run_command if applicable) -> read the relevant code -> identify the root cause -> apply the minimal fix with edit_file/write_file -> verify by re-running.

Rules: minimal diffs, no comments unless asked, verify before finishing. Summarize: root cause, fix, verification result.`
  },
  researcher: {
    name: 'researcher',
    label: 'Researcher',
    description: 'Gathers precise context about the workspace with file:line references',
    tools: READ_ONLY,
    maxIterations: 8,
    system: `You are the Researcher sub-agent of Meencode. You gather precise context about the workspace.
Your tools are read-only. Answer the given question with concrete file:line references and short code quotes. Be dense and factual; no speculation. End with a short "Key findings" list.`
  }
}

export const SPAWN_AGENT_TOOL: ToolDef = {
  name: 'spawn_agent',
  description: 'Delegate work to a specialist sub-agent and await its result. agents: planner (turn a task into a step plan), coder (implement one step), reviewer (review changes), debugger (fix a failure), researcher (gather context).',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: ['planner', 'coder', 'reviewer', 'debugger', 'researcher'] },
      task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent' }
    },
    required: ['agent', 'task']
  }
}

export function orchestratorSystemPrompt(root: string, platform: string): string {
  // Detect dominant language from root folder name heuristics (refined at runtime by workspace snapshot)
  const langHints: string[] = []
  const r = root.toLowerCase()
  if (r.includes('py') || r.includes('python') || r.includes('django') || r.includes('flask')) langHints.push('Python: use type hints, follow PEP 8, prefer f-strings, no mutable defaults.')
  if (r.includes('rust') || r.includes('cargo')) langHints.push('Rust: follow idiomatic ownership/borrow patterns, use ? for errors, no unwrap in library code.')
  if (r.includes('go') || r.includes('golang')) langHints.push('Go: gofmt style, error returns last, interfaces for abstractions, no global state.')
  const langBlock = langHints.length > 0 ? `\n\nDetected language hints:\n${langHints.join('\n')}` : ''

  return `You are Meencode, an elite autonomous coding agent — running inside the Meencode desktop editor.
Primary workspace: ${root}. Platform: ${platform}. Today: ${new Date().toISOString().slice(0, 10)}.${langBlock}

Multi-root workspace: list_dir("") shows all folders ("0: name", "1: name"...). Use "N:rel" scoped paths for other folders; plain paths resolve against folder 0. search_files/grep search ALL folders.

TOOLS: list_dir, read_file, write_file, edit_file, delete_file, search_files, grep, search_codebase, run_command (cwd = primary folder).

HOW YOU WORK — MAXIMUM SPEED & DIRECT EXECUTION:
1. Call tools directly — no preamble, no reasoning-out-loud in the reply, no narrating your steps.
2. The prompt carries relevant code slices (prefetched). If the code is already provided, DO NOT re-read it — edit immediately using edit_file or write_file.
3. Exploration budget: at most 1-2 search/read calls before editing. Edit directly and verify cleanly.
4. Finish fast: edit → (verify if needed) → reply concisely. No verbose explanations or summaries of steps.
5. Never re-read a file you just edited unless an edit fails.
6. Code style: minimal surgical diffs, match existing codebase conventions, no TODOs/placeholders, no dummy data.`}

// ---------------- plan parsing ----------------

export function parsePlan(text: string): PlanStep[] | null {
  // find a JSON object containing a "steps" array, tolerating ```json fences
  let raw = text.trim()
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) raw = fence[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  let obj: any
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(obj.steps)) return null
  const steps: PlanStep[] = []
  obj.steps.slice(0, 8).forEach((s: any, i: number) => {
    if (!s || typeof s !== 'object') return
    steps.push({
      id: `s${i + 1}`,
      title: String(s.title ?? `Step ${i + 1}`).slice(0, 160),
      detail: String(s.detail ?? '').slice(0, 1200),
      files: Array.isArray(s.files) ? s.files.map(String).slice(0, 20) : [],
      status: 'pending'
    })
  })
  return steps.length > 0 ? steps : null
}

export function parseVerdict(text: string): 'APPROVE' | 'FIX' | null {
  const m = text.match(/VERDICT:\s*(APPROVE|FIX)/i)
  return m ? (m[1].toUpperCase() as 'APPROVE' | 'FIX') : null
}