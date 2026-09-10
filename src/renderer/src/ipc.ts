import { useStore } from './store'
import type { MeencodeAPI } from '../../preload/index'

declare global {
  interface Window {
    meencode: MeencodeAPI
  }
}

let initialized = false

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
  window.meencode.fsEvents.on(async ({ path }) => {
    const s = store.getState()
    await s.refreshTree()
    // reload open, non-dirty tabs touched by the change
    for (const t of s.tabs) {
      if (!t.dirty && (path.endsWith(t.path) || path.replace(/\\/g, '/').endsWith('/' + t.path))) {
        await s.reloadFile(t.path)
      }
    }
  })
}

export const api = (): MeencodeAPI => window.meencode