import { useStore } from './store'
import type { MeencodeAPI } from '../../preload/index'

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
    if (e.kind === 'output') {
      useStore.setState({
        terminal: s.terminal.map((t) => (t.id === e.id ? { ...t, output: (t.output + e.data).slice(-20000) } : t))
      })
    } else if (e.kind === 'exit') {
      useStore.setState({
        terminal: s.terminal.map((t) => (t.id === e.id ? { ...t, running: false, exit: e.code ?? 0 } : t))
      })
    }
  })
  window.meencode.fsEvents.on(({ path }) => {
    // batch bursts of changes into ONE tree refresh
    fsPending.add(path)
    if (fsFlushTimer != null) window.clearTimeout(fsFlushTimer)
    fsFlushTimer = window.setTimeout(async () => {
      fsFlushTimer = null
      const changed = [...fsPending]
      fsPending.clear()
      const s = store.getState()
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
}

export const api = (): MeencodeAPI => window.meencode