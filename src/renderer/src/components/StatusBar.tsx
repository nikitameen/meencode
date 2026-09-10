import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'
import { getTheme, toggleTheme } from '../theme'
import type { GitState } from '../../../preload/index'

export function StatusBar() {
  const busy = useStore((s) => s.busy)
  const changes = useStore((s) => s.changes.filter((c) => c.status === 'pending').length)
  const settings = useStore((s) => s.settings)
  const set = useStore((s) => s.set)
  const approvals = useStore((s) => s.approvalsPending)
  const workspace = useStore((s) => s.settings?.workspace)
  const [git, setGit] = useState<GitState | null>(null)
  const autocomplete = useStore((s) => s.autocompleteEnabled)
  const [theme, setThemeName] = useState(getTheme())
  const wsName = settings?.workspace ? settings.workspace.split(/[\\/]/).pop() : null

  useEffect(() => {
    const onChange = () => setThemeName(getTheme())
    document.addEventListener('meencode:theme-changed', onChange)
    return () => document.removeEventListener('meencode:theme-changed', onChange)
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const g = await window.meencode.git.state()
        if (alive) setGit(g)
      } catch { /* no workspace */ }
    }
    void tick()
    const t = setInterval(tick, 8000)
    return () => { alive = false; clearInterval(t) }
  }, [workspace])

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className={`status-agent ${busy ? 'busy' : ''}`}>
          <span className="status-dot" />
          {busy ? 'Agent working…' : 'Agent idle'}
        </span>
        {approvals > 0 && (
          <span className="status-approval">
            <Icon name="alert" size={11} /> {approvals} approval{approvals > 1 ? 's' : ''} pending
          </span>
        )}
        {wsName && (
          <button className="status-btn" onClick={() => void useStore.getState().openFolder()} title="Switch workspace">
            {wsName}
          </button>
        )}
        {git?.repo && (
          <span className="status-btn git-indicator" title={`${git.files.length} changed · ${git.branch}`}>
            <Icon name="git" size={11} /> {git.branch}
            {(git.ahead > 0 || git.behind > 0) && (
              <span className="git-ab">
                {git.ahead > 0 && <span>↑{git.ahead}</span>}
                {git.behind > 0 && <span>↓{git.behind}</span>}
              </span>
            )}
            {git.files.length > 0 && <span className="git-dirty">{git.files.length}*</span>}
          </span>
        )}
      </div>
      <div className="status-right">
        <button className="status-btn" title="Toggle light/dark theme (Ctrl+Shift+T)" onClick={() => toggleTheme()}>
          <Icon name={theme === 'light' ? 'eye' : 'eyeOff'} size={11} /> {theme}
        </button>
        <button className="status-btn" title="AI Autocomplete" onClick={() => set('autocompleteEnabled', !useStore.getState().autocompleteEnabled)}>
          <span className={`status-dot ${useStore.getState().autocompleteEnabled ? 'busy' : ''}`} style={{ background: autocomplete ? 'var(--green)' : 'var(--faint)' }} />
          AI Tab
        </button>
        <button className="status-btn" title="Search codebase (Ctrl+Shift+F)" onClick={() => set('searchOpen', !useStore.getState().searchOpen)}>
          <Icon name="search" size={11} /> codebase
        </button>
        <button className="status-btn" title="Checkpoints" onClick={() => set('checkpointsModalOpen', true)}>
          <Icon name="revert" size={11} /> checkpoints
        </button>
        <button className="status-btn" onClick={() => set('reviewModalOpen', true)} title="Review changes">
          {changes > 0 && <span className="changes-dot" />}
          {changes} change{changes === 1 ? '' : 's'}
        </button>
        <button className="status-btn" onClick={() => set('settingsModalOpen', true)} title="Settings">
          {settings?.model ?? 'no model'}
        </button>
        <span className="status-hint">⌃⇧P commands</span>
      </div>
    </div>
  )
}