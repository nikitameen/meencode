import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, FileChange, PlanStep, Settings } from '../../shared/types'
import { OllamaCloudClient } from './ollamaClient'
import { Toolkit } from './tools'
import { runLoop, truncate, compactHistory } from './loop'
import { SUBAGENTS, SPAWN_AGENT_TOOL, orchestratorSystemPrompt, parsePlan, parseVerdict, type SubAgentName } from './subagents'
import { searchCodebaseIndex } from './codebaseIndexBridge'
import { buildContextBlock, type IDEContext } from '../agentContext'
import type { AgentMessage, ToolCall, ToolDef } from '../../shared/agent/types'

/** role-based model routing: cheap roles use the fast model, code roles use the big model */
function modelForAgent(agent: SubAgentName, settings: { model: string; fastModel?: string }): string {
  if (agent === 'coder' || agent === 'debugger') return settings.model
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
        onFileChange: (c) => this.io.emit({ type: 'file_change', change: c }),
        onOutput: (id, chunk, stream) => this.io.emit({ type: 'command_output', id, chunk, stream }),
        approve: (cmd) => this.requestApproval(cmd),
        autoRun: () => this.io.getSettings().autoRunCommands
      })
    } else {
      this.toolkit = null
    }
  }

  // ---------------- run ----------------

  async send(text: string, attachedFile?: string | null, images?: { name: string; dataUrl: string }[], ide?: IDEContext | null): Promise<void> {
    const settings = this.io.getSettings()
    if (!this.root) {
      this.io.emit({ type: 'run_start', runId: 'x' })
      this.io.emit({ type: 'run_end', runId: 'x', error: 'Open a workspace folder first.' })
      return
    }
    if (!settings.apiKey) {
      this.io.emit({ type: 'run_start', runId: 'x' })
      this.io.emit({ type: 'run_end', runId: 'x', error: 'Add your Ollama Cloud API key in Settings first.' })
      return
    }
    if (this.busy) {
      this.io.emit({ type: 'run_start', runId: 'x' })
      this.io.emit({ type: 'run_end', runId: 'x', error: 'The agent is already running.' })
      return
    }

    const runId = randomUUID().slice(0, 8)
    this.busy = true
    const controller = new AbortController()
    this.controller = controller
    this.toolkit!.runId = runId
    this.io.emit({ type: 'run_start', runId })

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

    try {
      const result = await runLoop(
        {
          chat: (msgs, tools, signal, cb) =>
            new OllamaCloudClient({
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.fastModel || settings.model
            }).chat(msgs, tools, signal, cb),
          tools: this.orchestratorTools(),
          execute: (call) => this.executeOrchestratorTool(call, settings, runId),
          emit: (e) => this.io.emit(e),
          agent: 'orchestrator',
          maxIterations: settings.maxIterations,
          signal: controller.signal
        },
        orchestratorSystemPrompt(this.root, `${os.platform()}-${os.arch()}`),
        this.history
      )
      this.history.push(...result.newMessages)
      this.history = compactHistory(this.history)
      this.io.emit({ type: 'message', role: 'assistant', content: result.content })
    } catch (e: any) {
      if (controller.signal.aborted) {
        this.io.emit({ type: 'run_end', runId, error: 'aborted' })
        return
      }
      this.io.emit({ type: 'run_end', runId, error: e?.message ?? String(e) })
      return
    } finally {
      this.busy = false
      this.controller = null
    }
    this.io.emit({ type: 'run_end', runId })
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

    // project rules (Cursor-style), incl. AGENTS.md / CLAUDE.md
    try {
      for (const name of ['.meencoderules', 'meencoderules.md', '.cursorrules', 'AGENTS.md', 'CLAUDE.md']) {
        const p = path.join(root, name)
        if (fs.existsSync(p)) {
          out += `\n\n--- Project rules (${name}) ---\n${truncate(await fs.promises.readFile(p, 'utf8'), 4000)}`
          break
        }
      }
    } catch { /* ignore */ }

    // @file mentions
    const mentions = [...text.matchAll(/@([\w./-]+\.[\w]+)/g)].map((m) => m[1])
    for (const rel of [...new Set(mentions)].slice(0, 5)) {
      try {
        const abs = path.resolve(root, rel)
        if (!abs.startsWith(path.resolve(root))) continue
        const file = await fs.promises.readFile(abs, 'utf8')
        out += `\n\n--- @${rel} ---\n${truncate(file, 6000)}`
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
        const file = await fs.promises.readFile(abs, 'utf8')
        out += `\n\n--- Attached file: ${attachedFile} ---\n${truncate(file, 8000)}`
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
  }

  // ---------------- approvals ----------------

  private requestApproval(command: string): Promise<boolean> {
    const id = randomUUID().slice(0, 8)
    this.io.emit({ type: 'approval_request', id, command })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id)
        this.io.emit({ type: 'approval_result', id, approved: false })
        resolve(false)
      }, 120000)
      this.approvals.set(id, (ok) => {
        clearTimeout(timer)
        this.io.emit({ type: 'approval_result', id, approved: ok })
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

    this.io.emit({ type: 'subagent_start', agent: agentName, task: truncate(task, 160) })
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
          execute: (call) => this.toolkit!.execute(call.name, call.args ?? {}, { callId: call.id, agent: agentName }),
          emit: (e) => this.io.emit(e),
          agent: agentName,
          maxIterations: def.maxIterations,
          signal: this.controller!.signal
        },
        def.system,
        messages.slice(1) // history = the user message
      )
    } catch (e: any) {
      this.io.emit({ type: 'subagent_end', agent: agentName, summary: `failed: ${e?.message ?? e}` })
      return `Sub-agent ${agentName} failed: ${e?.message ?? e}`
    }

    this.io.emit({ type: 'subagent_end', agent: agentName, summary: truncate(result.content, 200) })

    if (agentName === 'planner') {
      const plan = parsePlan(result.content)
      if (plan) {
        this.plan = plan
        this.io.emit({ type: 'plan', steps: plan })
        return `Plan created with ${plan.length} steps:\n${JSON.stringify(plan.map(({ id, title }) => ({ id, title })), null, 2)}\nExecute the steps in order by spawning a coder per step — include "[sN]" in each task.`
      }
      return `Planner could not produce a valid plan. Raw output:\n${truncate(result.content, 2000)}\nYou may re-spawn the planner or proceed without a formal plan.`
    }

    if (agentName === 'coder') {
      const m = task.match(/\[s(\d+)\]/)
      if (m && this.plan.length > 0) {
        const step = this.plan.find((s) => s.id === `s${m[1]}`)
        if (step) this.io.emit({ type: 'plan_update', id: step.id, status: 'done' })
      }
    }

    if (agentName === 'reviewer') {
      const verdict = parseVerdict(result.content)
      return `${result.content}\n\n(Verdict: ${verdict ?? 'UNKNOWN — treat as FIX and investigate'})`
    }

    return result.content
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