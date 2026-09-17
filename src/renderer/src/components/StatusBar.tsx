import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'
import { getTheme, toggleTheme } from '../theme'
import type { GitState } from '../../../preload/index'
import { getActiveEditor, languageFor } from '../store'

export function StatusBar() {
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0]
  const busy = sessions.some((s) => s.busy)
  const changes = activeSession?.changes.filter((c) => c.status === 'pending').length ?? 0
  const approvals = sessions.reduce((n, s) => n + s.approvalsPending, 0)
  const settings = useStore((s) => s.settings)
  const set = useStore((s) => s.set)
  const workspace = useStore((s) => s.settings?.workspace)
  const indexing = useStore((s) => s.indexing)
  const indexPct = useStore((s) => s.indexPct)
  const indexStats = useStore((s) => s.indexStats)
  const activeTab = useStore((s) => s.activeTab)
  const [git, setGit] = useState<GitState | null>(null)
  const autocomplete = useStore((s) => s.autocompleteEnabled)
  const [theme, setThemeName] = useState(getTheme())
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number } | null>(null)
  const wsName = settings?.workspace ? settings.workspace.split(/[/\\]/).pop() : null
  const runningCount = sessions.filter((s) => s.busy).length

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

  // Track cursor position from Monaco
  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const ed = getActiveEditor()
        if (!ed) { setCursorPos(null); return }
        const pos = ed.getPosition?.()
        if (pos) setCursorPos({ line: pos.lineNumber, col: pos.column })
      } catch { /* editor not ready */ }
    }, 500)
    return () => clearInterval(interval)
  }, [activeTab])

  const lang = activeTab ? languageFor(activeTab) : null

  // Rough token estimate: chars / 4
  const totalContextChars = activeSession?.feed.reduce((acc, f) => {
    if (f.kind === 'user' || f.kind === 'assistant') return acc + (f as any).text?.length ?? 0
    return acc
  }, 0) ?? 0
  const tokenEstimate = Math.round(totalContextChars / 4)

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className={`status-agent ${busy ? 'busy' : ''}`}>
          <span className="status-pulse-ring" />
          <span className="status-dot" />
          {busy ? `Agent working${runningCount > 1 ? ` (${runningCount})` : ''}…` : 'Agent idle'}
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
        {indexing ? (
          <span className="status-approval" title={`Indexing workspace (${indexPct}%)`}>
            <Icon name="search" size={11} /> Indexing {indexPct}%
          </span>
        ) : indexStats && indexStats.files > 0 ? (
          <span className="status-btn" title={`Workspace index: ${indexStats.files} files, ${indexStats.lines} lines, ${indexStats.symbols} symbols`}>
            <Icon name="search" size={11} /> {indexStats.files} indexed
          </span>
        ) : null}
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
        {/* Line / col from active editor */}
        {cursorPos && (
          <span className="status-btn status-cursor" title="Cursor position">
            Ln {cursorPos.line}, Col {cursorPos.col}
          </span>
        )}
        {/* Language of active file */}
        {lang && lang !== 'plaintext' && (
          <span className="status-btn status-lang" title={`Language: ${lang}`}>
            {lang}
          </span>
        )}
        {/* Token estimate */}
        {tokenEstimate > 100 && (
          <span className="status-btn status-tokens" title="Estimated context tokens (characters ÷ 4)">
            ~{tokenEstimate > 1000 ? `${(tokenEstimate / 1000).toFixed(1)}k` : tokenEstimate} tokens
          </span>
        )}
        <button className="status-btn" title="Toggle light/dark theme (Ctrl+Shift+T)" onClick={() => toggleTheme()}>
          <Icon name={theme === 'light' ? 'eye' : 'eyeOff'} size={11} /> {theme}
        </button>
        <button className="status-btn" title="AI Autocomplete" onClick={() => set('autocompleteEnabled', !useStore.getState().autocompleteEnabled)}>
          <span className="status-dot" style={{ background: autocomplete ? 'var(--green)' : 'var(--faint)', animation: autocomplete ? 'pulse 1.4s ease infinite' : 'none' }} />
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