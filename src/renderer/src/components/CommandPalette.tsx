import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

type Action = { id: string; label: string; hint?: string; run: () => void }

export function CommandPalette() {
  const mode = useStore((s) => s.paletteMode)
  const set = useStore((s) => s.set)
  const files = useStore((s) => s.files)
  const openFile = useStore((s) => s.openFile)
  const store = useStore.getState
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (mode) {
      setQuery(mode === 'commands' ? '>' : '')
      setSelected(0)
    }
  }, [mode])

  const actions: Action[] = useMemo(
    () => [
      { id: 'open', label: 'Open Folder', hint: 'workspace', run: () => void store().openFolder() },
      { id: 'settings', label: 'Settings', hint: 'API key, model', run: () => set('settingsModalOpen', true) },
      { id: 'review', label: 'Review Changes', hint: 'diffs', run: () => set('reviewModalOpen', true) },
      { id: 'revert', label: 'Revert All Agent Changes', run: () => void store().revertAll() },
      { id: 'newchat', label: 'Clear Conversation', run: () => store().clearChat() },
      { id: 'terminal', label: 'Toggle Terminal', hint: 'Ctrl+`', run: () => store().toggleTerminal() },
      { id: 'newshell', label: 'New Terminal (Interactive Shell)', hint: 'run Windows commands manually', run: () => { if (!useStore.getState().terminalOpen) store().toggleTerminal(); document.dispatchEvent(new CustomEvent('meencode:new-shell')) } },
      { id: 'git', label: 'Toggle Git Panel', hint: 'Ctrl+Shift+G', run: () => document.dispatchEvent(new CustomEvent('meencode:view-git')) },
      { id: 'browser', label: 'Toggle Built-in Browser', hint: 'Ctrl+Alt+B', run: () => document.dispatchEvent(new CustomEvent('meencode:toggle-browser')) },
      { id: 'search', label: 'Search Codebase (@codebase)', hint: 'Ctrl+Shift+F', run: () => set('searchOpen', !useStore.getState().searchOpen) },
      { id: 'checkpoints', label: 'Restore Checkpoint…', run: () => set('checkpointsModalOpen', true) },
      { id: 'autocomplete', label: 'Toggle AI Autocomplete (Tab)', run: () => set('autocompleteEnabled', !useStore.getState().autocompleteEnabled) },
      { id: 'importFiles', label: 'Import Files into Workspace', run: () => void window.meencode.workspaceImport.importFiles().then((r) => { if (r.ok) void store().refreshTree(); else if (r.message !== 'cancelled') alert(r.message) }) },
      { id: 'importFolder', label: 'Import Folder into Workspace', run: () => void window.meencode.workspaceImport.importFolder().then((r) => { if (r.ok) void store().refreshTree(); else if (r.message !== 'cancelled') alert(r.message) }) },
      { id: 'sidebar', label: 'Toggle Sidebar', hint: 'Ctrl+B', run: () => store().toggleSidebar() },
      { id: 'chat', label: 'Toggle Chat', hint: 'Ctrl+L', run: () => store().toggleChat() },
      { id: 'dev', label: 'Toggle Developer Tools', run: () => void window.meencode.dev.tools() }
    ],
    [set, store]
  )

  const isCmdMode = query.startsWith('>')
  const cmdQuery = isCmdMode ? query.slice(1).trim().toLowerCase() : ''
  const fileQuery = query.trim().toLowerCase()

  const commandResults = isCmdMode
    ? actions.filter((a) => a.label.toLowerCase().includes(cmdQuery)).slice(0, 12)
    : []
  const fileResults = !isCmdMode
    ? fuzzyFiles(files, fileQuery).slice(0, 14).map((f) => ({ id: f, label: f.split('/').pop() ?? f, hint: f, run: () => void openFile(f) }))
    : []
  const results = isCmdMode ? commandResults : fileResults

  useEffect(() => setSelected(0), [query])

  if (!mode) return null

  const close = () => set('paletteMode', null)
  const runSelected = (r: Action) => {
    close()
    r.run()
  }

  return (
    <div className="overlay" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder={isCmdMode ? 'Type a command…' : 'Search files by name… (> for commands)'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
            if (e.key === 'Enter' && results[selected]) { e.preventDefault(); runSelected(results[selected]) }
          }}
        />
        <div className="palette-list">
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((r, i) => (
            <div
              key={r.id}
              className={`palette-item ${i === selected ? 'sel' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runSelected(r)}
            >
              <span className="palette-label">{r.label}</span>
              {r.hint && <span className="palette-hint">{r.hint}</span>}
            </div>
          ))}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc dismiss</span>
          <span className="palette-mode">{isCmdMode ? <Icon name="sparkle" size={10} /> : null} {isCmdMode ? 'commands' : 'files'}</span>
        </div>
      </div>
    </div>
  )
}

function fuzzyFiles(files: string[], q: string): string[] {
  if (!q) return files.slice(0, 200)
  const scored: { f: string; score: number }[] = []
  for (const f of files.slice(0, 8000)) {
    const name = f.toLowerCase()
    let fi = 0
    let score = 0
    let streak = 0
    for (const c of q) {
      const idx = name.indexOf(c, fi)
      if (idx === -1) { score = -1; break }
      score += streak > 0 ? 3 : 1
      streak = idx === fi ? streak + 1 : 0
      fi = idx + 1
    }
    if (score > 0) scored.push({ f, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.f)
}