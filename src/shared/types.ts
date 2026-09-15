import type { AgentMessage } from './agent/types'

export type FileNode = { name: string; path: string; type: 'file' | 'dir'; children?: FileNode[] }
export type ChangeKind = 'created' | 'modified' | 'deleted'
export type FileChange = {
  path: string
  kind: ChangeKind
  before: string | null
  after: string | null
  ts: number
}
export type ChatRole = 'user' | 'assistant' | 'system'
export type PlanStep = {
  id: string
  title: string
  detail: string
  files: string[]
  status: 'pending' | 'in_progress' | 'done' | 'failed'
}
export type AgentModelSettings = {
  model: string
  fastModel: string
  /** per-sub-agent model overrides (optional) */
  subAgentModels?: Partial<Record<'planner' | 'coder' | 'reviewer' | 'debugger' | 'researcher' | 'orchestrator', string>>
}

export type Settings = {
  apiKey: string
  baseUrl: string
  model: string
  /** small/fast model for planning, research, review, autocomplete (defaults to model) */
  fastModel: string
  /** per-sub-agent model overrides */
  subAgentModels?: Partial<Record<'planner' | 'coder' | 'reviewer' | 'debugger' | 'researcher' | 'orchestrator', string>>
  maxIterations: number
  autoRunCommands: boolean
  /** legacy single-root (kept in sync with roots[0]) */
  workspace: string | null
  /** multi-root workspace folders */
  roots: string[]
  /** MCP servers configured for this workspace */
  mcpServers?: MCPServerConfig[]
}

export type MCPServerConfig = {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
  /** timeout in ms for a single tool call */
  timeout?: number
}

type AgentEventBase =
  | { type: 'run_start'; runId: string }
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'message'; role: ChatRole; content: string; runId?: string }
  | { type: 'tool_start'; id: string; agent: string; name: string; args: unknown }
  | { type: 'tool_end'; id: string; agent: string; name: string; ok: boolean; result: string; ms: number }
  | { type: 'subagent_start'; agent: string; task: string }
  | { type: 'subagent_end'; agent: string; summary: string }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'plan_update'; id: string; status: PlanStep['status'] }
  | { type: 'file_change'; change: FileChange }
  | { type: 'command_output'; id: string; chunk: string; stream: 'stdout' | 'stderr' }
  | { type: 'approval_request'; id: string; command: string }
  | { type: 'approval_result'; id: string; approved: boolean }
  | { type: 'session_start'; sessionId: string; title: string }
  | { type: 'run_end'; runId: string; error?: string }

export type AgentEvent = AgentEventBase & { sessionId: string }

export type AgentEventPayload = AgentEventBase

export type { AgentMessage }