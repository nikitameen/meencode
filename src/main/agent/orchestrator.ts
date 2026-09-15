import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { readFileCached } from '../fileCache'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, FileChange, PlanStep, Settings } from '../../shared/types'
import { OllamaCloudClient } from './ollamaClient'
import { Toolkit } from './tools'
import { runLoop, truncate, compactHistoryBytes, compactHistory } from './loop'
import { complete, stripReasoning } from './quickLLM'
import { SUBAGENTS, SPAWN_AGENT_TOOL, orchestratorSystemPrompt, parsePlan, parseVerdict, type SubAgentName } from './subagents'
import { searchCodebaseIndex } from './codebaseIndexBridge'
import { buildContextBlock, type IDEContext } from '../agentContext'
import { appendHistory } from '../workspaceMemory'
import * as sessionStore from '../sessionStore'
import type { AgentMessage, ToolCall, ToolDef } from '../../shared/agent/types'

/** role-based model routing: respect per-agent overrides, then cheap vs big model defaults */
function modelForAgent(agent: SubAgentName | 'orchestrator', settings: Settings): string {
  const override = settings.subAgentModels?.[agent]
  if (override) return override
  if (agent === 'coder' || agent === 'debugger' || agent === 'orchestrator') return settings.model
  return settings.fastModel || settings.model
}

export interface AgentIO {
  emit(e: AgentEvent): void
  getSettings(): Settings
}

export class AgentSession {
  private history: AgentMessage[] = []
  private plan: PlanStep[] = []
  private toolkit: Toolkit | null = null
  private controller: AbortController | null = null
  private approvals = new Map<string, (ok: boolean) => void>()
  private sessionId: string | null = null
  busy = false
  root: string | null = null
  roots: string[] = []

  constructor(private io: AgentIO) {}

  setWorkspace(root: string | null) {
    this.setRoots(root ? [root] : [])
  }

  /** multi-root: the agent can read/edit/search across ALL workspace folders */
  setRoots(roots: string[]) {
    this.roots = roots.filter(Boolean)
    this.root = this.roots[0] ?? null
    this.history = []
    this.plan = []
    if (this.root) {
      this.toolkit = new Toolkit(this.roots, {
        onFileChange: (c) => this.emit({ type: 'file_change', change: c }),
        onOutput: (id, chunk, stream) => this.emit({ type: 'command_output', id, chunk, stream }),
        approve: (cmd) => this.requestApproval(cmd),
        autoRun: () => this.io.getSettings().autoRunCommands
      })
    } else {
      this.toolkit = null
    }
  }

  private emit(e: import('../../shared/types').AgentEventPayload): void {
    const payload: AgentEvent = { ...e, sessionId: this.sessionId ?? 'unknown' } as AgentEvent
    this.io.emit(payload)
  }

  // ---------------- run ----------------

  async send(text: string, attachedFile?: string | null, images?: { name: string; dataUrl: string }[], ide?: IDEContext | null): Promise<void> {
    const settings = this.io.getSettings()
    if (!this.root) {
      this.emit({ type: 'run_start', runId: 'x' })
      this.emit({ type: 'run_end', runId: 'x', error: 'Open a workspace folder first.' })
      return
    }
    if (!settings.apiKey) {
      this.emit({ type: 'run_start', runId: 'x' })
      this.emit({ type: 'run_end', runId: 'x', error: 'Add your Ollama Cloud API key in Settings first.' })
      return
    }

    const runId = randomUUID().slice(0, 8)
    if (this.busy) {
      this.emit({ type: 'run_end', runId, error: 'The agent is already running.' })
      return
    }
    this.busy = true
    const controller = new AbortController()
    this.controller = controller
    this.toolkit!.runId = runId
    this.emit({ type: 'run_start', runId })

    // ---- session persistence ----
    if (sessionStore.isSessionDbReady()) {
      if (!this.sessionId) {
        this.sessionId = randomUUID().slice(0, 8)
        sessionStore.createSession(this.sessionId, text.replace(/\n/g, ' ').slice(0, 80) || 'New chat', this.root)
        this.io.emit({ type: 'session_start', sessionId: this.sessionId, title: text.slice(0, 80) })
      }
      sessionStore.appendMessage(this.sessionId, 'user', text)
    } else if (!this.sessionId) {
      this.sessionId = randomUUID().slice(0, 8)
      this.io.emit({ type: 'session_start', sessionId: this.sessionId, title: text.slice(0, 80) })
    }

    try {
      let content = await this.enrichContext(text, attachedFile, ide ?? null)
      const userImages = (images ?? []).slice(0, 4)
      if (userImages.length > 0) {
        // vision request: content parts (text + images) per the OpenAI-compatible schema
        const parts: unknown[] = [{ type: 'text', text: content }]
        for (const img of userImages) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
        }
        this.history.push({ role: 'user', content: parts as unknown as string })
        content = '[images attached]'
      } else {
        this.history.push({ role: 'user', content })
      }
      const result = await runLoop(
        {
          chat: (msgs, tools, signal, cb) =>
            new OllamaCloudClient({
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: modelForAgent('orchestrator', settings)
            }).chat(msgs, tools, signal, cb),
          tools: this.orchestratorTools(),
          execute: (call) => this.executeOrchestratorTool(call, settings, runId),
          emit: (e) => this.emit(e),
          agent: 'orchestrator',
          maxIterations: settings.maxIterations,
          signal: controller.signal
        },
        orchestratorSystemPrompt(this.root, `${os.platform()}-${os.arch()}`),
        this.history
      )
      this.history.push(...result.newMessages)
      this.history = compactHistoryBytes(this.history)
      if (result.aborted || result.error) {
        // partial run: everything the agent read/learned is in newMessages and
        // now merged into history — a follow-up prompt continues where this
        // left off instead of re-reading the workspace from scratch
        if (this.sessionId && sessionStore.isSessionDbReady()) {
          sessionStore.appendMessage(this.sessionId, 'assistant', result.aborted
            ? 'Stopped. Everything read this run is kept in context — continue where I left off.'
            : `Run error: ${result.error}`)
        }
        this.emit({
          type: 'message',
          role: 'assistant',
          content: result.aborted
            ? 'Stopped. I kept everything I read this run — tell me to continue and I will pick up where I left off.'
            : `Run error: ${result.error}`
        })
        this.emit({ type: 'run_end', runId, error: result.aborted ? 'aborted' : result.error })
        return
      }

      if (result.hitIterationLimit) {
        // Summarize progress and start a fresh iteration so long tasks can keep going.
        await this.summarizeAndResume(runId, text, settings)
        return
      }

      this.emit({ type: 'message', role: 'assistant', content: result.content })
      // persist to SQLite + markdown history
      if (this.sessionId && sessionStore.isSessionDbReady()) {
        sessionStore.appendMessage(this.sessionId, 'assistant', result.content)
      }
      try { appendHistory(text, result.content) } catch { /* best-effort */ }
    } catch (e: any) {
      if (controller.signal.aborted) {
        this.emit({ type: 'run_end', runId, error: 'aborted' })
        return
      }
      this.emit({ type: 'run_end', runId, error: e?.message ?? String(e) })
      return
    } finally {
      this.busy = false
      this.controller = null
    }
    this.emit({ type: 'run_end', runId })
  }

  // ---------------- context summarization + resume ----------------

  private async summarizeAndResume(runId: string, originalText: string, settings: Settings): Promise<void> {
    const summary = await this.summarizeContext(settings)
    this.emit({ type: 'message', role: 'assistant', content: `Reached the iteration limit for this step. I'm summarizing what was done and continuing with a fresh context.\n\n**Summary so far:**\n${summary}` })

    // Replace history with a compact resume context
    const resumeMessage: AgentMessage = {
      role: 'user',
      content: `Continue the following task from where it left off.\n\nOriginal request:\n${originalText}\n\nSummary of progress so far:\n${summary}\n\nContinue working toward the goal. Do not repeat steps already completed unless verification is needed.`
    }
    this.history = compactHistory([resumeMessage], 4)

    const newRunId = randomUUID().slice(0, 8)
    this.toolkit!.runId = newRunId
    this.emit({ type: 'run_start', runId: newRunId })

    try {
      const result = await runLoop(
        {
          chat: (msgs, tools, signal, cb) =>
            new OllamaCloudClient({
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: modelForAgent('orchestrator', settings)
            }).chat(msgs, tools, signal, cb),
          tools: this.orchestratorTools(),
          execute: (call) => this.executeOrchestratorTool(call, settings, newRunId),
          emit: (e) => this.emit(e),
          agent: 'orchestrator',
          maxIterations: settings.maxIterations,
          signal: this.controller?.signal ?? new AbortController().signal
        },
        orchestratorSystemPrompt(this.root!, `${os.platform()}-${os.arch()}`),
        this.history
      )
      this.history.push(...result.newMessages)
      this.history = compactHistoryBytes(this.history)
      if (result.aborted || result.error) {
        this.emit({ type: 'message', role: 'assistant', content: result.aborted ? 'Stopped during resume.' : `Resume error: ${result.error}` })
        this.emit({ type: 'run_end', runId: newRunId, error: result.aborted ? 'aborted' : result.error })
        return
      }
      this.emit({ type: 'message', role: 'assistant', content: result.content })
      if (this.sessionId && sessionStore.isSessionDbReady()) {
        sessionStore.appendMessage(this.sessionId, 'assistant', result.content)
      }
    } catch (e: any) {
      this.emit({ type: 'run_end', runId: newRunId, error: e?.message ?? String(e) })
    }
  }

  private async summarizeContext(settings: Settings): Promise<string> {
    // Build a compact transcript of the recent turns for summarization
    const transcript = this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => {
        const prefix = m.role === 'user' ? 'User' : 'Assistant'
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
        return `${prefix}: ${truncate(text, 2000)}`
      })
      .join('\n\n')

    const changes = this.toolkit?.getChanges() ?? []
    const changesText = changes.length > 0
      ? `Files changed so far:\n${changes.map((c) => `- ${c.path} (${c.kind})`).join('\n')}`
      : 'No files have been changed yet.'

    const user = `Summarize the progress of this coding task so another AI can resume it with a fresh context.

Transcript:
${transcript}

${changesText}

Provide a concise summary (3-6 bullet points) covering:
- What was already done
- What is still pending
- Key files/code locations involved
- Any errors, decisions, or open questions
Do not include greetings or explanations outside the bullet points.`

    try {
      const raw = await complete(settings, {
        system: 'You are a concise engineering summarizer. Output only bullet points.',
        user,
        maxTokens: 1200,
        temperature: 0.2
      })
      return stripReasoning(raw).trim() || 'No summary available.'
    } catch (e: any) {
      return `Task in progress. Recent context is preserved; continuing may require re-reading relevant files. (${e?.message ?? 'summary failed'})`
    }
  }

  stop() {
    this.controller?.abort()
  }

  // ---------------- context enrichment (@mentions, @codebase, rules) ----------------

  private async enrichContext(text: string, attachedFile?: string | null, ide?: IDEContext | null): Promise<string> {
    let out = text
    const root = this.root!

    // full auto-context: IDE state, git, workspace memory, relevant code, last failure
    try {
      const ctx = buildContextBlock(
        ide ?? { activeFile: null, openTabs: [] },
        text
      )
      if (ctx) {
        out += `\n\n${ctx}`
        this.lastContextBlock = ctx
      }
    } catch { /* context assembly must never break a run */ }

    // NOTE: project rules / AGENTS.md / CLAUDE.md are injected by the knowledge
    // base (agentContext.buildContextBlock) — seeded from those files and
    // managed in SQLite. No file reads here anymore.

    // @file mentions
    const mentions = [...text.matchAll(/@([\w./-]+\.[\w]+)/g)].map((m) => m[1])
    for (const rel of [...new Set(mentions)].slice(0, 5)) {
      try {
        const abs = path.resolve(root, rel)
        if (!abs.startsWith(path.resolve(root))) continue
        const file = await readFileCached(abs, 6000)
        if (file) out += `\n\n--- @${rel} ---\n${file}`
      } catch { /* skip missing */ }
    }

    // @codebase keyword search
    if (/@codebase\b/i.test(text)) {
      const query = text.replace(/@codebase\b/gi, '').trim()
      const hits = this.searchCodebase(query || text, 25)
      if (hits.length > 0) {
        const block = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
        out += `\n\n--- @codebase keyword search results for "${query || text}" ---\n${block}`
      }
    }

    // attached current file
    if (attachedFile) {
      try {
        const abs = path.resolve(root, attachedFile)
        const file = await readFileCached(abs, 8000)
        if (file) out += `\n\n--- Attached file: ${attachedFile} ---\n${file}`
      } catch { /* ignore missing attachment */ }
    }
    return out
  }

  private searchCodebase(query: string, limit: number): { path: string; line: number; text: string }[] {
    return searchCodebaseIndex(query, limit)
  }

  reset() {
    this.history = []
    this.plan = []
    this.sessionId = null
  }

  /** Restore a historical session: returns the transcript or null. */
  loadSession(sessionId: string): { role: 'user' | 'assistant'; content: string }[] | null {
    if (!sessionStore.isSessionDbReady()) return null
    const msgs = sessionStore.getSessionMessages(sessionId)
    if (msgs.length === 0) return null
    // rebuild agent history from user/assistant pairs
    const history: AgentMessage[] = []
    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'assistant') {
        history.push({ role: m.role, content: m.content })
      }
    }
    this.history = compactHistoryBytes(history, 30, 60000)
    this.sessionId = sessionId
    this.plan = []
    return history.map((h) => ({ role: h.role as 'user' | 'assistant', content: String(h.content) }))
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  // ---------------- approvals ----------------

  private requestApproval(command: string): Promise<boolean> {
    const id = randomUUID().slice(0, 8)
    this.emit({ type: 'approval_request', id, command })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id)
        this.emit({ type: 'approval_result', id, approved: false })
        resolve(false)
      }, 120000)
      this.approvals.set(id, (ok) => {
        clearTimeout(timer)
        this.emit({ type: 'approval_result', id, approved: ok })
        resolve(ok)
      })
    })
  }

  resolveApproval(id: string, ok: boolean): boolean {
    const fn = this.approvals.get(id)
    if (!fn) return false
    this.approvals.delete(id)
    fn(ok)
    return true
  }

  // ---------------- changes ----------------

  revert(path: string): boolean {
    return this.toolkit?.revert(path) ?? false
  }

  revertAll(): number {
    return this.toolkit?.revertAll() ?? 0
  }

  getChanges(): FileChange[] {
    return this.toolkit?.getChanges() ?? []
  }

  // ---------------- tooling ----------------

  private orchestratorTools(): ToolDef[] {
    if (!this.toolkit) return []
    const readOnly = this.toolkit.defs.filter((d) => ['list_dir', 'read_file', 'search_files', 'grep', 'search_codebase', 'run_command'].includes(d.name))
    return [...readOnly, SPAWN_AGENT_TOOL]
  }

  private async executeOrchestratorTool(call: ToolCall, settings: Settings, runId: string): Promise<string> {
    if (call.name === 'spawn_agent') {
      return this.runSubAgent(call.args?.agent, String(call.args?.task ?? ''), settings, runId)
    }
    return this.toolkit!.execute(call.name, call.args ?? {}, { callId: call.id, agent: 'orchestrator' })
  }

  private async runSubAgent(name: unknown, task: string, settings: Settings, runId: string): Promise<string> {
    const agentName = String(name ?? '') as SubAgentName
    const def = SUBAGENTS[agentName]
    if (!def) return `Error: unknown agent "${agentName}". Valid agents: planner, coder, reviewer, debugger, researcher.`
    if (!task.trim()) return `Error: task is required.`

    this.emit({ type: 'subagent_start', agent: agentName, task: truncate(task, 160) })
    const tools = this.toolkit!.defs.filter((d) => def.tools.includes(d.name))
    const messages: AgentMessage[] = [
      { role: 'system', content: def.system },
      { role: 'user', content: this.subAgentContext(agentName, task) }
    ]

    let result
    try {
      result = await runLoop(
        {
          chat: (msgs, tl, signal, cb) =>
            new OllamaCloudClient({
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: modelForAgent(agentName, settings)
            }).chat(msgs, tl, signal, cb),
          tools,
          execute: (call) => this.executeToolWithRetry(call, agentName),
          emit: (e) => this.emit(e),
          agent: agentName,
          maxIterations: def.maxIterations,
          signal: this.controller!.signal
        },
        def.system,
        messages.slice(1) // history = the user message
      )
    } catch (e: any) {
      this.emit({ type: 'subagent_end', agent: agentName, summary: `failed: ${e?.message ?? e}` })
      return `Sub-agent ${agentName} failed: ${e?.message ?? e}`
    }

    this.emit({ type: 'subagent_end', agent: agentName, summary: truncate(result.content, 200) })

    if (agentName === 'planner') {
      const plan = parsePlan(result.content)
      if (plan) {
        this.plan = plan
        this.emit({ type: 'plan', steps: plan })
        return `Plan created with ${plan.length} steps:\n${JSON.stringify(plan.map(({ id, title }) => ({ id, title })), null, 2)}\nExecute the steps in order by spawning a coder per step — include "[sN]" in each task.`
      }
      return `Planner could not produce a valid plan. Raw output:\n${truncate(result.content, 2000)}\nYou may re-spawn the planner or proceed without a formal plan.`
    }

    if (agentName === 'coder') {
      const m = task.match(/\[s(\d+)\]/)
      if (m && this.plan.length > 0) {
        const step = this.plan.find((s) => s.id === `s${m[1]}`)
        if (step) {
          const succeeded = !result.error && !result.content.startsWith('Error:')
          this.emit({ type: 'plan_update', id: step.id, status: succeeded ? 'done' : 'failed' })
          if (succeeded && this.io.getSettings().autoRunCommands !== false) {
            // Auto-review significant coder steps when the user allows command auto-run (proxy for "trust").
            // We run the review in the background but do not block here; the result will feed the next orchestrator turn.
            void this.runBackgroundReviewer(task, settings, runId)
          }
        }
      }
    }

    if (agentName === 'reviewer') {
      const verdict = parseVerdict(result.content)
      return `${result.content}\n\n(Verdict: ${verdict ?? 'UNKNOWN — treat as FIX and investigate'})`
    }

    return result.content
  }

  private async runBackgroundReviewer(task: string, settings: Settings, runId: string): Promise<void> {
    try {
      const changes = this.toolkit?.getChanges() ?? []
      if (changes.length === 0) return
      const reviewTask = `Review the most recent coder step and its changes for correctness. The coder was asked:\n${task}`
      const verdict = await this.runSubAgent('reviewer', reviewTask, settings, runId)
      const v = parseVerdict(verdict)
      if (v === 'FIX') {
        // spawn a debugger to address the review issues
        const issues = verdict.replace(/VERDICT:\s*FIX/i, '').trim()
        void this.runSubAgent('debugger', `The reviewer found issues with the last coder step.\n\nTask context:\n${task}\n\nReviewer issues:\n${issues}\n\nFix the issues with minimal changes and verify.`, settings, runId)
      }
    } catch { /* best-effort background review */ }
  }

  private async executeToolWithRetry(call: ToolCall, agent: string): Promise<string> {
    const result = await this.toolkit!.execute(call.name, call.args ?? {}, { callId: call.id, agent })
    const isRetryable = call.name === 'edit_file' || call.name === 'write_file'
    if (!isRetryable) return result
    if (!result.startsWith('Error:')) return result
    if (call.name === 'edit_file' && result.includes('old_string not found')) {
      // Re-read the file and return a richer error so the LLM can correct itself in the next turn.
      const pathArg = String((call.args as any)?.path ?? '')
      try {
        const abs = this.toolkit!.resolve(pathArg)
        const current = await fs.promises.readFile(abs, 'utf8')
        return `${result}\n\nCurrent file content (first 3000 chars):\n${truncate(current, 3000)}\n\nHint: re-read the file and use an exact, unique old_string that currently exists.`
      } catch { /* fall through */ }
    }
    return result
  }

  private subAgentContext(agentName: SubAgentName, task: string): string {
    let ctx = task
    if (agentName === 'reviewer' && this.toolkit) {
      const changes = this.toolkit.getChanges()
      if (changes.length > 0) {
        const parts = changes.slice(0, 10).map((c) => {
          const head = `--- ${c.path} (${c.kind}) ---`
          const before = c.kind === 'created' ? '(new file)' : c.before?.slice(0, 1500) ?? '(empty)'
          const after = c.after?.slice(0, 1500) ?? '(deleted)'
          return `${head}\nBEFORE:\n${before}\nAFTER:\n${after}`
        })
        ctx += `\n\nChanged files this session:\n${parts.join('\n\n')}`
      }
    }
    if (agentName === 'coder' && this.plan.length > 0) {
      ctx += `\n\nCurrent plan (JSON):\n${JSON.stringify(this.plan)}`
    }
    // read-only agents get the workspace memory overview too
    if ((agentName === 'researcher' || agentName === 'planner' || agentName === 'coder') && this.lastContextBlock) {
      ctx += `\n\n${this.lastContextBlock}`
    }
    return ctx
  }

  private lastContextBlock = ''
}