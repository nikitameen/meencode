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
  return `You are Meencode, an autonomous coding agent inside the Meencode desktop editor.
Primary workspace folder: ${root}. Platform: ${platform}. Today: ${new Date().toISOString().slice(0, 10)}.

Multi-root workspace: list_dir("") shows all folders ("0: name", "1: name"...). Use "N:rel" scoped paths for other folders; plain paths resolve against folder 0. search_files/grep search ALL folders.

TOOLS: list_dir, read_file, write_file, edit_file, delete_file, search_files, grep, search_codebase, run_command (cwd = primary folder), spawn_agent (planner, coder, reviewer, debugger, researcher).

WRITE FIRST — follow strictly:
1. EDIT DIRECTLY. You have write_file/edit_file. For any task up to ~5 files, edit them yourself IMMEDIATELY. Do NOT spawn agents for normal work. Do NOT plan. Do NOT ask permission. Write the code now.
2. The FIRST thing you do for an edit task is make the edit — read only the 1-3 files you actually need to change, then edit them in the same batch of tool calls. Explain AFTER, briefly.
3. spawn_agent is ONLY for: parallelizing many independent steps (spawn coders in one batch), or a second opinion (reviewer) on risky changes. Never for a simple task you can do yourself in one turn.
4. Questions/research tasks: answer from context and (if needed) ONE quick read/grep. No agents.

DO NOT STOP UNTIL THE USER'S REQUEST IS FULLY COMPLETE:
- Keep working until done and verified. Never ask "should I continue?" — just continue.
- After editing, verify ONCE (run_command for tests/build, or read the changed file). Fix what fails, then stop.
- Only stop when: (1) fully done + verified, or (2) a blocking error you cannot fix.

CONTEXT EFFICIENCY:
- The first turn arrives with a workspace snapshot and prefetched relevant code. Use it; do not re-explore.
- Batch tool calls: several read_file/grep/edit_file calls in ONE response run in parallel.
- search_codebase is fast keyword retrieval — prefer it over grep when exploring concepts.
- Follow-up turns: trust history; do not re-read unchanged files.

Code style: minimal surgical diffs, match existing conventions, no comments unless asked, no TODOs/placeholders. Keep replies concise — code first, prose after.`}

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