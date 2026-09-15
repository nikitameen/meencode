import { useStore } from './store'
import type { MeencodeAPI } from '../../preload/index'

export type { MeencodeAPI }

declare global {
  interface Window {
    meencode: MeencodeAPI
  }
}

let initialized = false
let fsFlushTimer: number | null = null
const fsPending = new Set<string>()

export function initBridge(): void {
  if (initialized) return
  initialized = true
  const store = useStore
  window.meencode.agent.onEvent((e) => useStore.getState().handleAgentEvent(e))
  window.meencode.exec.onEvent((e) => {
    const s = store.getState()
    const activeSessionId = s.activeSessionId
    if (e.kind === 'output') {
      useStore.setState({
        sessions: s.sessions.map((sess) =>
          sess.id === activeSessionId
            ? { ...sess, terminal: sess.terminal.map((t) => (t.id === e.id ? { ...t, output: (t.output + e.data).slice(-20000) } : t)) }
            : sess
        )
      })
    } else if (e.kind === 'exit') {
      useStore.setState({
        sessions: s.sessions.map((sess) =>
          sess.id === activeSessionId
            ? { ...sess, terminal: sess.terminal.map((t) => (t.id === e.id ? { ...t, running: false, exit: e.code ?? 0 } : t)) }
            : sess
        )
      })
    }
  })
  window.meencode.fsEvents.on(({ path: filePath, root }) => {
    // batch bursts of changes into ONE tree refresh
    fsPending.add(filePath)
    if (fsFlushTimer != null) window.clearTimeout(fsFlushTimer)
    fsFlushTimer = window.setTimeout(async () => {
      fsFlushTimer = null
      const changed = [...fsPending]
      fsPending.clear()
      const s = store.getState()
      // detect corrections: user edited files the agent changed in this session
      detectCorrections(changed, root)
      // single tree refresh per burst (no await per event)
      void s.refreshTree()
      // reload open, non-dirty tabs touched by the burst
      const touched = new Set<string>()
      for (const p of changed) {
        for (const t of s.tabs) {
          if (t.dirty || touched.has(t.path)) continue
          if (p.endsWith(t.path) || p.replace(/\\/g, '/').endsWith('/' + t.path)) touched.add(t.path)
        }
      }
      for (const tp of touched) await s.reloadFile(tp)
    }, 400)
  })

  function detectCorrections(changedPaths: string[], root: string): void {
    const s = store.getState()
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    if (!session) return
    const agentChanges = session.changes.filter((c) => c.status === 'kept' || c.status === 'pending')
    if (agentChanges.length === 0) return
    for (const abs of changedPaths) {
      const rel = abs.slice(root.length + (root.endsWith('\\') || root.endsWith('/') ? 0 : 1)).replace(/\\/g, '/')
      const match = agentChanges.find((c) => c.change.path === rel)
      if (!match) continue
      // file was changed by agent and then touched by user outside the agent
      const active = s.tabs.find((t) => t.path === `${0}:${rel}` || t.path.endsWith(`:${rel}`))
      if (!active || active.dirty) continue
      // read current file content and compare to agent's after state
      window.meencode.fs.read(active.path).then((userAfter) => {
        const agentAfter = match.change.after ?? ''
        if (userAfter !== agentAfter) {
          // find the most recent assistant runId from the feed
          const lastAssistant = [...session.feed].reverse().find((f) => f.kind === 'assistant' && 'runId' in f && f.runId) as { runId?: string } | undefined
          const runId = lastAssistant?.runId ?? 'unknown'
          void window.meencode.agent.feedback(s.activeSessionId!, '', runId, 'negative', `User corrected ${rel}`)
          // notify main to store the correction pair
          void window.meencode.agent.correction?.(s.activeSessionId!, rel, agentAfter, userAfter, runId)
        }
      }).catch(() => {})
    }
  }
}

export const api = (): MeencodeAPI => window.meencode
