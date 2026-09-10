import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function SessionHistoryPanel() {
  const open = useStore((s) => s.historyOpen)
  const sessions = useStore((s) => s.sessions)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const loadSession = useStore((s) => s.loadSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const toggleHistory = useStore((s) => s.toggleHistory)
  const refreshSessions = useStore((s) => s.refreshSessions)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  useEffect(() => {
    if (open) void refreshSessions()
  }, [open, refreshSessions])

  if (!open) return null

  const filtered = query.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()) || s.preview.toLowerCase().includes(query.toLowerCase()))
    : sessions

  return (
    <div className="history-panel">
      <div className="history-header">
        <span><Icon name="revert" size={12} /> Chat history</span>
        <div className="history-actions">
          <input
            className="history-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="icon-btn" onClick={toggleHistory} title="Close history">
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>
      <div className="history-list">
        {filtered.length === 0 && <div className="history-empty">No saved sessions yet.</div>}
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`history-item ${s.id === activeSessionId ? 'active' : ''}`}
            onClick={() => void loadSession(s.id)}
          >
            {renaming === s.id ? (
              <input
                autoFocus
                className="history-rename"
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void window.meencode.sessions.rename(s.id, renameText).then(() => refreshSessions())
                    setRenaming(null)
                  } else if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <div className="history-item-title">{s.title || 'Untitled chat'}</div>
            )}
            <div className="history-item-meta">
              <span className="history-time">{fmtAgo(s.updatedAt)}</span>
              <span className="history-count">{s.messageCount} msg</span>
            </div>
            {s.preview && <div className="history-preview">{s.preview.replace(/\n/g, ' ').slice(0, 90)}</div>}
            <div className="history-item-actions">
              <button
                className="icon-btn"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenaming(s.id)
                  setRenameText(s.title)
                }}
              >
                <Icon name="edit" size={11} />
              </button>
              <button
                className="icon-btn"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Delete "${s.title || 'Untitled chat'}"?`)) void deleteSession(s.id)
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}