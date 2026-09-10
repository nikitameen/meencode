import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

type Hit = { path: string; line: number; text: string; score: number }

export function SearchPanel() {
  const open = useStore((s) => s.searchOpen)
  const set = useStore((s) => s.set)
  const openFile = useStore((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
    }
  }, [open])

  const run = async () => {
    if (!query.trim()) { setHits([]); return }
    setBusy(true)
    await window.meencode.cursor.indexCodebase().catch(() => {})
    const results = await window.meencode.cursor.searchCodebase(query, 50)
    setHits(results)
    setBusy(false)
  }

  if (!open) return null

  return (
    <div className="search-panel">
      <div className="search-toolbar">
        <Icon name="search" size={13} />
        <input
          autoFocus
          value={query}
          placeholder="Search codebase (words, identifiers, strings)…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); if (e.key === 'Escape') set('searchOpen', false) }}
        />
        <button className="btn" onClick={() => void run()} disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        <button className="icon-btn" title="Close (Ctrl+Shift+F)" onClick={() => set('searchOpen', false)}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {hits.length > 0 && (
        <div className="search-results">
          {hits.map((h, i) => (
            <div key={`${h.path}:${h.line}:${i}`} className="search-hit" onClick={() => void openFile(h.path)}>
              <span className="search-hit-loc">{h.path}:{h.line}</span>
              <code className="search-hit-text">{h.text}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}