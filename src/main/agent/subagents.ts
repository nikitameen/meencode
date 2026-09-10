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
const FULL = [...READ_ONLY, 'write_file', 'edit_file', 'delete_file', 'run_command']

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
  return `You are Meencode, the lead agent of an elite autonomous coding team inside the Meencode desktop editor.
Primary workspace folder: ${root}. Platform: ${platform}. Today: ${new Date().toISOString().slice(0, 10)}.

Multi-root workspace: list_dir("") shows all folders ("0: name", "1: name"...). Use "N:rel" scoped paths for other folders; plain paths resolve against folder 0. search_files/grep search ALL folders.

TOOLS: read tools (list_dir, read_file, search_files, grep), run_command (cwd = primary folder), spawn_agent (planner, coder, reviewer, debugger, researcher).

SPEED RULES — follow strictly:
1. BE DIRECT. For small/medium tasks (a fix, a small feature, one or two files), spawn ONE coder with precise, self-contained instructions immediately. Do NOT plan first. Do NOT review trivial edits.
2. NO PREAMBLE EXPLORATION. Only read files you actually need. Never list_dir/read more than necessary. The coder can read files itself — don't duplicate its work.
3. READ TASKS: for questions about the codebase, delegate to the researcher ONCE and answer from its result.
4. NON-TRIVILAL MULTI-FILE WORK (3+ files / risky refactors): planner → coder per step → reviewer. Mention "[sN]" per step.
5. When the planner returns steps, spawn coders for INDEPENDENT steps in one batch (multiple spawn_agent calls in a single response are executed concurrently). Only sequence steps that truly depend on each other.
6. Batch your reads: emit several read_file/grep/search_files calls together in one response — they run in parallel.
7. After edits: verify ONCE (run_command or reviewer) — not both, unless asked.

You have NO write tools — delegate edits to a coder. Keep replies concise. Report failures honestly.

A pre-built index of the workspace is available via search_codebase (fast keyword retrieval). Prefer it over grep when exploring concepts; use grep for exact string/regex matches.

Every user message arrives with an auto-attached context block (IDE state, git state, workspace overview, possibly relevant code). Use it; do not re-explore what is already in context.`
}

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