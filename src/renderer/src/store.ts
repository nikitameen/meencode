import { create } from 'zustand'
import { EMPTY_INLINE as INLINE_EMPTY, type InlineEditState } from './components/InlineEdit'
import type { AgentEvent, FileChange, FileNode, PlanStep, Settings } from '../../shared/types'

export type FeedItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; thinking?: string; streaming?: boolean }
  | { id: string; kind: 'tool'; agent: string; name: string; argsSummary: string; status: 'running' | 'ok' | 'error'; result?: string; ms?: number }
  | { id: string; kind: 'subagent'; agent: string; task: string; state: 'start' | 'end'; summary?: string }
  | { id: string; kind: 'plan'; steps: PlanStep[] }
  | { id: string; kind: 'change'; change: FileChange }
  | { id: string; kind: 'approval'; command: string; state: 'pending' | 'approved' | 'denied' }
  | { id: string; kind: 'error'; text: string }

export type Tab = { path: string; content: string; dirty: boolean; version: number }

export type TerminalEntry = { id: string; agent: string; command: string; output: string; exit: number | null; running: boolean }

export type ChangeEntry = { change: FileChange; status: 'pending' | 'kept' | 'reverted' }

interface State {
  settings: Settings | null
  tree: FileNode[]
  files: string[]
  treeFilter: string
  sidebarOpen: boolean
  chatOpen: boolean
  terminalOpen: boolean
  tabs: Tab[]
  activeTab: string | null
  feed: FeedItem[]
  changes: ChangeEntry[]
  terminal: TerminalEntry[]
  busy: boolean
  plan: PlanStep[]
  paletteMode: null | 'commands' | 'files'
  settingsModalOpen: boolean
  reviewModalOpen: boolean
  checkpointsModalOpen: boolean
  currentAssistantId: string | null
  approvalsPending: number
  inlineEdit: import('./components/InlineEdit').InlineEditState
  searchOpen: boolean
  searchQuery: string
  searchHits: { path: string; line: number; text: string; score: number }[]
  searchBusy: boolean
  autocompleteEnabled: boolean
  indexing: boolean
  indexPct: number
  indexRootName: string | null
  indexStats: { files: number; lines: number; symbols: number } | null
}

interface Actions {
  init(): Promise<void>
  handleAgentEvent(e: AgentEvent): void
  openFile(path: string): Promise<void>
  closeTab(path: string): void
  setActiveTab(path: string): void
  markDirty(path: string): void
  saveActiveTab(): Promise<void>
  reloadFile(path: string): Promise<void>
  refreshTree(): Promise<void>
  openFolder(): Promise<void>
  send(text: string, attachCurrent: boolean, images?: { name: string; dataUrl: string }[]): Promise<void>
  revertChange(path: string): Promise<void>
  revertAll(): Promise<void>
  keepChange(path: string): void
  approve(id: string, ok: boolean): Promise<void>
  clearChat(): void
  set<K extends keyof State>(key: K, value: State[K]): void
  toggleTerminal(): void
  toggleChat(): void
  toggleSidebar(): void
}

const uid = (): string => Math.random().toString(36).slice(2, 10)

export const useStore = create<State & Actions>((set, get) => ({
  settings: null,
  tree: [],
  files: [],
  treeFilter: '',
  sidebarOpen: true,
  chatOpen: true,
  terminalOpen: false,
  tabs: [],
  activeTab: null,
  feed: [],
  changes: [],
  terminal: [],
  busy: false,
  plan: [],
  paletteMode: null,
  settingsModalOpen: false,
  reviewModalOpen: false,
  checkpointsModalOpen: false,
  currentAssistantId: null,
  approvalsPending: 0,
  inlineEdit: INLINE_EMPTY,
  searchOpen: false,
  searchQuery: '',
  searchHits: [],
  searchBusy: false,
  autocompleteEnabled: true,
  indexing: false,
  indexPct: 0,
  indexRootName: null,
  indexStats: null,

  set: (key, value) => set({ [key]: value } as any),

  async init() {
    const settings = await window.meencode.settings.get()
    set({ settings })
    if (settings.workspace) {
      await get().refreshTree()
    }
    // auto-indexing runs in the main process on init; subscribe to its progress
    window.meencode.index.onEvent((e) => {
      const s = get()
      if (e.phase === 'start') set({ indexing: true, indexPct: 0, indexRootName: null })
      else if (e.phase === 'progress') {
        set({ indexing: true, indexPct: e.pct ?? 0, indexRootName: (e as any).rootName ?? null })
      } else if (e.phase === 'done') {
        const st = (e as any).stats
        set({
          indexing: false,
          indexPct: 100,
          indexStats: st ? { files: st.files, lines: st.lines, symbols: st.symbols } : null
        })
      } else if (e.phase === 'error') set({ indexing: false })
      void s
    })
  },

  async refreshTree() {
    const [tree, files] = await Promise.all([window.meencode.fs.tree(), window.meencode.fs.listFiles()])
    set({ tree, files })
  },

  async openFolder() {
    const ws = await window.meencode.fs.openFolder()
    if (ws) {
      set({ tabs: [], activeTab: null, feed: [], changes: [], terminal: [] })
      await get().refreshTree()
    }
  },

  handleAgentEvent(e: AgentEvent) {
    const s = get()
    switch (e.type) {
      case 'run_start':
        set({ busy: true, currentAssistantId: null })
        break
      case 'token': {
        const cur = s.currentAssistantId
        if (cur) {
          set({
            feed: s.feed.map((f) => (f.id === cur && f.kind === 'assistant' ? { ...f, text: f.text + e.text } : f))
          })
        } else {
          const id = uid()
          set({ currentAssistantId: id, feed: [...s.feed, { id, kind: 'assistant', text: e.text, streaming: true }] })
        }
        break
      }
      case 'thinking': {
        let cur = s.currentAssistantId
        if (!cur) {
          const id = uid()
          set({ currentAssistantId: id, feed: [...s.feed, { id, kind: 'assistant', text: '', thinking: '', streaming: true }] })
          cur = id
        }
        set({
          feed: get().feed.map((f) => (f.id === cur && f.kind === 'assistant' ? { ...f, thinking: (f.thinking ?? '') + e.text } : f))
        })
        break
      }
      case 'message': {
        if (e.role === 'assistant') {
          const cur = s.currentAssistantId
          const exists = cur && s.feed.some((f) => f.id === cur && f.kind === 'assistant')
          if (exists) {
            set({
              feed: s.feed.map((f) => (f.id === cur && f.kind === 'assistant' ? { ...f, text: e.content, streaming: false } : f))
            })
          } else {
            set({ feed: [...s.feed, { id: uid(), kind: 'assistant', text: e.content }] })
          }
          set({ currentAssistantId: null })
        }
        break
      }
      case 'tool_start': {
        const isCmd = e.name === 'run_command'
        const command = isCmd ? String((e.args as any)?.command ?? '') : ''
        set({
          currentAssistantId: null,
          feed: [
            ...s.feed,
            {
              id: e.id,
              kind: 'tool',
              agent: e.agent,
              name: e.name,
              argsSummary: summarizeArgs(e.name, e.args),
              status: 'running'
            }
          ],
          ...(isCmd
            ? { terminal: [...s.terminal, { id: e.id, agent: e.agent, command, output: '', exit: null, running: true }] }
            : {})
        })
        break
      }
      case 'tool_end': {
        set({
          feed: s.feed.map((f) => (f.id === e.id && f.kind === 'tool' ? { ...f, status: e.ok ? 'ok' : 'error', result: e.result, ms: e.ms } : f)),
          terminal: s.terminal.map((t) => (t.id === e.id ? { ...t, running: false, exit: e.ok ? t.exit : 1 } : t))
        })
        break
      }
      case 'subagent_start':
        set({ feed: [...s.feed, { id: `sa-${uid()}`, kind: 'subagent', agent: e.agent, task: e.task, state: 'start' }] })
        break
      case 'subagent_end':
        set({
          feed: s.feed.map((f, i, arr) => {
            // update the last matching start item for this agent
            let lastIdx = -1
            for (let j = 0; j < arr.length; j++) {
              const cur = arr[j]
              if (cur.kind === 'subagent' && cur.agent === e.agent && cur.state === 'start') lastIdx = j
            }
            if (i === lastIdx && f.kind === 'subagent') {
              return { ...f, state: 'end' as const, summary: e.summary }
            }
            return f
          })
        })
        break
      case 'plan':
        set({ feed: [...s.feed, { id: uid(), kind: 'plan', steps: e.steps }], plan: e.steps })
        break
      case 'plan_update': {
        set({
          plan: s.plan.map((p) => (p.id === e.id ? { ...p, status: e.status } : p)),
          feed: s.feed.map((f) => {
            if (f.kind !== 'plan') return f
            const idx = s.feed.reduce((acc, cur, i) => (cur.kind === 'plan' ? i : acc), -1)
            if (idx === -1) return f
            const target = s.feed[idx]
            if (target.kind !== 'plan' || target.id !== f.id) return f
            return { ...f, steps: (f as any).steps.map((p: PlanStep) => (p.id === e.id ? { ...p, status: e.status } : p)) }
          })
        })
        break
      }
      case 'file_change': {
        const change = e.change
        set({
          changes: [...s.changes.filter((c) => c.change.path !== change.path), { change, status: 'pending' }],
          feed: [...s.feed, { id: `fc-${uid()}`, kind: 'change', change }]
        })
        void get().openFile(change.path)
        break
      }
      case 'command_output': {
        set({
          terminal: s.terminal.map((t) => (t.id === e.id ? { ...t, output: (t.output + e.chunk).slice(-20000) } : t))
        })
        break
      }
      case 'approval_request':
        set({
          approvalsPending: s.approvalsPending + 1,
          feed: [...s.feed, { id: e.id, kind: 'approval', command: e.command, state: 'pending' }],
          currentAssistantId: null
        })
        break
      case 'approval_result':
        set({
          approvalsPending: Math.max(0, s.approvalsPending - 1),
          feed: s.feed.map((f) => (f.id === e.id && f.kind === 'approval' ? { ...f, state: e.approved ? 'approved' : 'denied' } : f))
        })
        break
      case 'run_end': {
        const feed = [...get().feed]
        const cur = get().currentAssistantId
        if (cur) {
          const idx = feed.findIndex((f) => f.id === cur)
          if (idx !== -1 && feed[idx].kind === 'assistant') (feed[idx] as any).streaming = false
        }
        const nextFeed = e.error ? [...feed, { id: uid(), kind: 'error' as const, text: e.error }] : feed
        set({ busy: false, currentAssistantId: null, feed: nextFeed, approvalsPending: 0 })
        break
      }
    }
  },

  async openFile(path) {
    const s = get()
    const existing = s.tabs.find((t) => t.path === path)
    if (existing) {
      await s.reloadFile(path)
      set({ activeTab: path })
      return
    }
    try {
      const content = await window.meencode.fs.read(path)
      set({ tabs: [...s.tabs, { path, content, dirty: false, version: 1 }], activeTab: path })
    } catch (e: any) {
      console.error('openFile failed', e)
    }
  },

  closeTab(path) {
    const s = get()
    const idx = s.tabs.findIndex((t) => t.path === path)
    const tabs = s.tabs.filter((t) => t.path !== path)
    const activeTab = s.activeTab === path ? (idx > 0 ? tabs[idx - 1]?.path ?? null : tabs[0]?.path ?? null) : s.activeTab
    set({ tabs, activeTab })
  },

  setActiveTab(path) {
    set({ activeTab: path })
  },

  markDirty(path) {
    set({
      tabs: get().tabs.map((t) => (t.path === path ? { ...t, dirty: true } : t))
    })
  },

  async saveActiveTab() {
    const s = get()
    if (!s.activeTab) return
    const tab = s.tabs.find((t) => t.path === s.activeTab)
    if (!tab) return
    const model = getModel(tab.path)
    const content = model?.getValue() ?? tab.content
    await window.meencode.fs.write(tab.path, content)
    set({ tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, dirty: false, content } : t)) })
  },

  async reloadFile(path) {
    const s = get()
    const tab = s.tabs.find((t) => t.path === path)
    if (!tab || tab.dirty) return
    try {
      const content = await window.meencode.fs.read(path)
      const bump = tab.version + 1
      set({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, content, version: bump } : t)) })
    } catch { /* deleted */ }
  },

  async send(text, attachCurrent, images) {
    const s = get()
    if (!text.trim()) return
    const attached = attachCurrent && s.activeTab ? s.activeTab : null
    set({ feed: [...s.feed, { id: uid(), kind: 'user', text }], currentAssistantId: null })
    const ide = collectIdeContext()
    await window.meencode.agent.send(text, attached, images, ide)
  },

  async revertChange(path) {
    await window.meencode.agent.revert(path)
    set({
      changes: get().changes.map((c) => (c.change.path === path ? { ...c, status: 'reverted' } : c)),
      feed: get().feed.map((f) => (f.kind === 'change' && f.change.path === path ? { ...f, change: { ...f.change, kind: 'deleted' as const, after: f.change.before, before: f.change.after } } : f))
    })
    await get().reloadFile(path)
  },

  async revertAll() {
    await window.meencode.agent.revertAll()
    set({ changes: get().changes.map((c) => ({ ...c, status: 'reverted' as const })) })
    for (const t of get().tabs) await get().reloadFile(t.path)
  },

  keepChange(path) {
    set({ changes: get().changes.map((c) => (c.change.path === path ? { ...c, status: 'kept' } : c)) })
  },

  async approve(id, ok) {
    await window.meencode.agent.approve(id, ok)
  },

  clearChat() {
    void window.meencode.agent.reset()
    set({ feed: [], plan: [], changes: [], terminal: [] })
  },

  toggleTerminal() {
    set({ terminalOpen: !get().terminalOpen })
  },
  toggleChat() {
    set({ chatOpen: !get().chatOpen })
  },
  toggleSidebar() {
    set({ sidebarOpen: !get().sidebarOpen })
  }
}))

// ---------------- Monaco model registry (module-level, avoids prop drilling) ----------------

import * as monaco from 'monaco-editor'

const models = new Map<string, monaco.editor.ITextModel>()

export function getModel(path: string): monaco.editor.ITextModel | null {
  return models.get(path) ?? null
}

export function ensureModel(path: string, content: string): monaco.editor.ITextModel {
  let m = models.get(path)
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(content, languageFor(path), monaco.Uri.parse(`meencode://file/${encodeURI(path)}`))
    models.set(path, m)
  }
  return m
}

export function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    sh: 'shell', bash: 'shell', sql: 'sql', txt: 'plaintext'
  }
  return map[ext] ?? 'plaintext'
}

function summarizeArgs(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  switch (name) {
    case 'read_file': return String(a.path ?? '')
    case 'write_file': return String(a.path ?? '')
    case 'edit_file': return String(a.path ?? '')
    case 'delete_file': return String(a.path ?? '')
    case 'list_dir': return String(a.path ?? '.')
    case 'search_files': return String(a.pattern ?? '')
    case 'grep': return String(a.pattern ?? '')
    case 'run_command': return String(a.command ?? '')
    case 'spawn_agent': return `${a.agent}: ${String(a.task ?? '').slice(0, 80)}`
    default: return JSON.stringify(a).slice(0, 80)
  }
}

// ---------------- active editor registry ----------------

let activeEditor: unknown = null

export function setActiveEditor(editor: unknown): void {
  activeEditor = editor
}

export function getActiveEditor(): any {
  return activeEditor
}

// ---------------- IDE context for the agent ----------------

/** Snapshot of what the user is looking at — sent with every agent message. */
function collectIdeContext(): {
  activeFile: string | null
  cursorLine?: number
  selection?: string
  openTabs: string[]
  diagnostics?: { path: string; line: number; severity: string; message: string }[]
} {
  const s = useStore.getState()
  const ed = getActiveEditor()
  const out: {
    activeFile: string | null
    cursorLine?: number
    selection?: string
    openTabs: string[]
    diagnostics?: { path: string; line: number; severity: string; message: string }[]
  } = { activeFile: s.activeTab, openTabs: s.tabs.map((t: Tab) => t.path) }
  try {
    if (ed && s.activeTab) {
      const selection = ed.getSelection()
      const model = ed.getModel()
      if (selection && model) {
        out.cursorLine = selection.positionLineNumber ?? 1
        const sel = model.getValueInRange(selection)
        if (sel && sel.trim()) out.selection = sel.slice(0, 2000)
      }
      // monaco typescript markers = current "problems"
      const mon = (window as any).monaco
      if (mon?.editor?.getModelMarkers) {
        const markers = mon.editor.getModelMarkers({ resource: model.uri })
        out.diagnostics = markers
          .filter((m: any) => m.severity >= 4)
          .slice(0, 15)
          .map((m: any) => ({
            path: s.activeTab!,
            line: m.startLineNumber,
            severity: m.severity === 8 ? 'error' : 'warning',
            message: String(m.message ?? '').slice(0, 200)
          }))
      }
    }
  } catch { /* editor not ready */ }
  return out
}
