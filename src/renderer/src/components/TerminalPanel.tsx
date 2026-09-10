import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { Icon, AGENT_COLORS } from './ui'
import { xtermTheme } from '../theme'

type ShellTab = { id: string; title: string; profile: string }
type Profile = { id: string; label: string; available: boolean }

export function TerminalPanel() {
  const terminal = useStore((s) => s.terminal)
  const toggleTerminal = useStore((s) => s.toggleTerminal)
  const settings = useStore((s) => s.settings)
  const [input, setInput] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [suggestion, setSuggestion] = useState('')
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [shells, setShells] = useState<ShellTab[]>([])
  const [activeShell, setActiveShell] = useState<string | null>(null)
  const [agentTab, setAgentTab] = useState(true)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [splitMode, setSplitMode] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const xtermHostRef = useRef<HTMLDivElement>(null)
  const xtermSplitRef = useRef<HTMLDivElement>(null)
  const xtermsRef = useRef<Map<string, { term: Terminal; fit: FitAddon }>>(new Map())
  const newMenuRef = useRef<HTMLDivElement>(null)

  // load available shell profiles
  useEffect(() => {
    void window.meencode.pty.profiles().then(setProfiles).catch(() => setProfiles([]))
  }, [])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])

  useEffect(() => {
    const onNewShell = () => void newShell()
    const onSuggest = () => void getSuggestion()
    const onEnsureShell = () => {
      // terminal opened with no shell tabs -> start an interactive one
      if (useStore.getState().terminalOpen && shells.length === 0) void newShell()
    }
    document.addEventListener('meencode:new-shell', onNewShell)
    document.addEventListener('meencode:suggest-command', onSuggest)
    document.addEventListener('meencode:ensure-shell', onEnsureShell)
    return () => {
      document.removeEventListener('meencode:new-shell', onNewShell)
      document.removeEventListener('meencode:suggest-command', onSuggest)
      document.removeEventListener('meencode:ensure-shell', onEnsureShell)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shells.length])

  useEffect(() => {
    const off = window.meencode.pty.onData(({ id, data }) => {
      xtermsRef.current.get(id)?.term.write(data)
    })
    window.meencode.pty.onExit(({ id }) => {
      xtermsRef.current.get(id)?.term.write('\r\n\x1b[90m[process exited — shell closed]\x1b[0m\r\n')
    })
    return () => off?.()
  }, [])

  const newShell = async (profile?: string) => {
    const ws = useStore.getState().settings?.roots?.[0] ?? (useStore.getState().settings?.workspace ?? undefined)
    const r = await window.meencode.pty.create(80, 24, ws, profile)
    if (!r.interactive) {
      alert(`Could not start shell: ${r.error ?? 'unavailable'}`)
      return
    }
    const label = profiles.find((p) => p.id === profile)?.label ?? 'shell'
    const sameCount = shells.filter((s) => s.profile === (profile ?? 'default')).length
    const tab: ShellTab = { id: r.id, profile: profile ?? 'default', title: sameCount > 0 ? `${label} ${sameCount + 1}` : label }
    setShells((prev) => [...prev, tab])
    setActiveShell(r.id)
    setAgentTab(false)
    setNewMenuOpen(false)
  }

  const closeShell = async (id: string) => {
    await window.meencode.pty.kill(id)
    xtermsRef.current.get(id)?.term.dispose()
    xtermsRef.current.delete(id)
    setShells((prev) => {
      const next = prev.filter((s) => s.id !== id)
      if (activeShell === id) {
        if (next.length > 0) setActiveShell(next[next.length - 1].id)
        else setAgentTab(true)
      }
      return next
    })
  }

  const killAll = async () => {
    for (const s of shells) await closeShell(s.id)
    setShells([])
    setAgentTab(true)
  }

  const clearActive = () => {
    if (!activeShell) return
    xtermsRef.current.get(activeShell)?.term.clear()
  }

  const startRename = (tab: ShellTab) => {
    setRenaming(tab.id)
    setRenameValue(tab.title)
  }

  const commitRename = () => {
    if (renaming && renameValue.trim()) {
      setShells((prev) => prev.map((s) => (s.id === renaming ? { ...s, title: renameValue.trim() } : s)))
    }
    setRenaming(null)
  }

  const attachShell = (shellId: string, host: HTMLDivElement | null, forceNew: boolean) => {
    if (!host) return
    let entry = xtermsRef.current.get(shellId)
    if (!entry || forceNew) {
      if (!entry) {
        const term = new Terminal({
          fontSize: 12.5,
          fontFamily: "'Cascadia Code', Consolas, monospace",
          theme: xtermTheme(),
          cursorBlink: true,
          allowProposedApi: true
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.loadAddon(new WebLinksAddon())
        term.open(host)
        term.onData((data) => void window.meencode.pty.write(shellId, data))
        term.onResize(({ cols, rows }) => void window.meencode.pty.resize(shellId, cols, rows))
        entry = { term, fit }
        xtermsRef.current.set(shellId, entry)
      } else if (entry.term.element) {
        host.appendChild(entry.term.element)
      }
      entry.fit.fit()
      entry.term.focus()
    }
  }

  // attach active shell to the main host (or split hosts)
  useEffect(() => {
    if (agentTab || !activeShell) return
    attachShell(activeShell, xtermHostRef.current, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShell, agentTab, splitMode, shells.length])

  // split: show the second-most-recent shell beside the active one
  const splitShell = shells.length >= 2 ? shells[shells.length - 2] : null
  useEffect(() => {
    if (!splitMode || !splitShell || agentTab) return
    attachShell(splitShell.id, xtermSplitRef.current, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitMode, splitShell?.id, agentTab])

  // refit + re-theme
  useEffect(() => {
    const onResize = () => {
      xtermsRef.current.get(activeShell ?? '')?.fit.fit()
      if (splitMode && splitShell) xtermsRef.current.get(splitShell.id)?.fit.fit()
    }
    const onTheme = () => {
      const t = xtermTheme()
      for (const entry of xtermsRef.current.values()) entry.term.options.theme = t
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('meencode:theme-changed', onTheme)
    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('meencode:theme-changed', onTheme)
    }
  }, [activeShell, splitMode, splitShell])

  useEffect(() => {
    if (autoScroll && bodyRef.current && agentTab) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [terminal, autoScroll, agentTab])

  const run = async () => {
    if (!input.trim()) return
    const cmd = input
    setInput('')
    setSuggestion('')
    setAutoScroll(true)
    await window.meencode.exec.run(cmd)
  }

  const getSuggestion = async () => {
    if (suggestBusy || !settings?.apiKey) return
    setSuggestBusy(true)
    const history = terminal.map((t) => t.command)
    const r = await window.meencode.cursor.suggestCommand({
      context: `workspace: ${(settings.roots ?? []).join(', ') || (settings.workspace ?? '')} — terminal activity`,
      history
    })
    setSuggestion(r.command)
    setSuggestBusy(false)
  }

  const applySuggestion = () => {
    if (!suggestion) return
    setInput(suggestion)
    setSuggestion('')
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-tabstrip">
          <button
            className={`terminal-tabbtn ${agentTab ? 'active' : ''}`}
            onClick={() => { setAgentTab(true); setActiveShell(null) }}
          >
            <Icon name="sparkle" size={11} /> Agent
          </button>
          {shells.map((s) => (
            <span key={s.id} className={`terminal-tabbtn shell ${activeShell === s.id && !agentTab ? 'active' : ''}`}>
              {renaming === s.id ? (
                <input
                  className="shell-rename"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
                />
              ) : (
                <button onClick={() => { setActiveShell(s.id); setAgentTab(false) }} onDoubleClick={() => startRename(s)} title="Double-click to rename">
                  {s.title}
                </button>
              )}
              <button className="shell-close" title="Close shell" onClick={() => void closeShell(s.id)}>
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
          <div className="more-wrap" ref={newMenuRef}>
            <button className="terminal-tabbtn new" title="New shell — choose a profile" onClick={() => setNewMenuOpen(!newMenuOpen)}>
              <Icon name="plus" size={11} />
            </button>
            {newMenuOpen && (
              <div className="ctx-menu up">
                {profiles.filter((p) => p.available).map((p) => (
                  <button key={p.id} onClick={() => void newShell(p.id)}>
                    <span className="menu-label">New {p.label}</span>
                  </button>
                ))}
                <div className="ctx-sep" />
                <button onClick={() => { setNewMenuOpen(false); void newShell() }}>Default</button>
              </div>
            )}
          </div>
        </div>
        <div className="terminal-toolbar">
          {shells.length >= 2 && (
            <button className="icon-btn" title={splitMode ? 'Unsplit' : 'Split terminal'} onClick={() => setSplitMode(!splitMode)}>
              <Icon name={splitMode ? 'x' : 'review'} size={12} />
            </button>
          )}
          {!agentTab && (
            <button className="icon-btn" title="Clear terminal" onClick={clearActive}>
              <Icon name="refresh" size={12} />
            </button>
          )}
          {shells.length > 0 && (
            <button className="icon-btn" title="Kill all shells" onClick={() => void killAll()}>
              <Icon name="stop" size={12} />
            </button>
          )}
          <button className="icon-btn" title="Hide terminal (Ctrl+`)" onClick={toggleTerminal}>
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      </div>
      {agentTab ? (
        <>
          <div
            className="terminal-body"
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget
              setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            }}
          >
            {terminal.length === 0 && (
              <div className="terminal-empty">
                Run any Windows command below (one-shot), or press <b>+</b> for a full interactive shell
                (CMD / PowerShell / Git Bash).
              </div>
            )}
            {terminal.map((t) => (
              <div key={t.id} className="terminal-entry">
                <div className="terminal-entry-header">
                  <span className="terminal-entry-agent" style={{ color: AGENT_COLORS[t.agent] ?? 'var(--dim)' }}>
                    {t.agent}
                  </span>
                  <code className="terminal-entry-cmd">{t.command}</code>
                  {t.running ? (
                    <span className="tool-spinner"><Icon name="spinner" size={10} /></span>
                  ) : (
                    <span className={`terminal-exit ${t.exit === 0 || t.exit === null ? 'ok' : 'fail'}`}>
                      {t.exit === null ? '' : `exit ${t.exit}`}
                    </span>
                  )}
                </div>
                {t.output && <pre className="terminal-output">{t.output}</pre>}
              </div>
            ))}
          </div>
          <div className="terminal-input-row">
            <span className="terminal-prompt">$</span>
            <input
              placeholder="Run any Windows command here (dir, npm test, git status…)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
                if (e.key === 'Tab' && suggestion) { e.preventDefault(); applySuggestion() }
              }}
            />
            <button className="terminal-newshell-btn" title="Open a full interactive shell" onClick={() => void newShell()}>
              <Icon name="terminal" size={11} /> Shell
            </button>
            <button className="icon-btn" title="AI: suggest a command" onClick={() => void getSuggestion()}>
              {suggestBusy ? <span className="tool-spinner"><Icon name="spinner" size={11} /></span> : <Icon name="sparkle" size={12} />}
            </button>
          </div>
          {suggestion && (
            <div className="terminal-suggestion" onClick={applySuggestion}>
              <Icon name="sparkle" size={11} />
              <code>{suggestion}</code>
              <span className="terminal-suggestion-hint">press Tab or click to use</span>
            </div>
          )}
        </>
      ) : (
        <div className={`xterm-split-host ${splitMode ? 'split' : ''}`}>
          <div className="xterm-host" ref={xtermHostRef} />
          {splitMode && splitShell && <div className="xterm-host split-right" ref={xtermSplitRef} />}
        </div>
      )}
    </div>
  )
}