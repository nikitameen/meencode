import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'
import type { GitFileStatus, GitState } from '../../../preload/index'

export function GitPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<GitState | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [remoteUrl, setRemoteUrl] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const settings = useStore((s) => s.settings)
  const refreshTree = useStore((s) => s.refreshTree)

  const refresh = async () => {
    const s = await window.meencode.git.state()
    setState(s)
    setLog(await window.meencode.git.log().catch(() => []))
  }

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [settings?.workspace])

  const act = async (fn: () => Promise<GitState>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return
    setBusy(true)
    setErr(null)
    try {
      const s = await fn()
      setState(s)
      setLog(await window.meencode.git.log().catch(() => []))
      await refreshTree()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  if (!state.repo) {
    return (
      <div className={`git-panel ${embedded ? "embedded" : ""}`}>
        <div className="git-empty">
          <Icon name="git" size={18} />
          <div>This workspace is not a git repository.</div>
          <button className="btn primary" onClick={() => void act(() => window.meencode.git.init())}>
            <Icon name="git" size={12} /> Initialize repository
          </button>
        </div>
      </div>
    )
  }

  const staged = state.files.filter((f) => f.staged)
  const unstaged = state.files.filter((f) => !f.staged)

  return (
    <div className={`git-panel ${embedded ? "embedded" : ""}`}>
      <div className="git-header">
        <span className="git-branch"><Icon name="git" size={12} /> {state.branch}</span>
        {(state.ahead > 0 || state.behind > 0) && (
          <span className="git-aheadbehind">
            {state.ahead > 0 && <span title="commits ahead">↑{state.ahead}</span>}
            {state.behind > 0 && <span title="commits behind">↓{state.behind}</span>}
          </span>
        )}
        <span className="git-counts">{staged.length} staged · {unstaged.length} changed</span>
        <div className="git-header-actions">
          <button className="btn" disabled={busy} onClick={() => void act(() => window.meencode.git.pull())} title="Pull (rebase)">
            Pull
          </button>
          <button className="btn" disabled={busy} onClick={() => void act(() => window.meencode.git.push())} title="Push to origin">
            Push
          </button>
        </div>
      </div>

      {err && <div className="git-error">{err}</div>}

      <div className="git-body">
        <div className="git-col">
          <div className="git-col-title">
            Changes
            <button className="mini-btn" title="Stage all" onClick={() => void act(() => window.meencode.git.stage('.'))}>
              <Icon name="plus" size={10} />
            </button>
          </div>
          {unstaged.length === 0 && <div className="git-none">No changes</div>}
          {unstaged.map((f) => (
            <GitFile key={f.path} f={f} actionLabel="Stage" onAction={() => void act(() => window.meencode.git.stage(f.path))} onDiscard={() => void act(() => window.meencode.git.discard(f.path), `Discard changes in ${f.path}?`)} />
          ))}
        </div>
        <div className="git-col">
          <div className="git-col-title">
            Staged
            <button className="mini-btn" title="Unstage all" onClick={() => void act(() => window.meencode.git.unstage('.'))}>
              <Icon name="revert" size={10} />
            </button>
          </div>
          {staged.length === 0 && <div className="git-none">Nothing staged</div>}
          {staged.map((f) => (
            <GitFile key={f.path} f={f} actionLabel="Unstage" onAction={() => void act(() => window.meencode.git.unstage(f.path))} />
          ))}
        </div>
        <div className="git-col">
          <div className="git-col-title">History</div>
          {log.length === 0 && <div className="git-none">No commits yet</div>}
          {log.map((l) => (
            <div key={l} className="git-log">{l}</div>
          ))}
        </div>
      </div>

      <div className="git-commit">
        <input
          placeholder={staged.length > 0 ? `Commit message (${staged.length} staged)` : 'Stage changes to commit'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && message.trim() && staged.length > 0) {
              void act(async () => {
                const s = await window.meencode.git.commit(message)
                setMessage('')
                return s
              })
            }
          }}
        />
        <button
          className="btn primary"
          disabled={busy || !message.trim() || staged.length === 0}
          onClick={() => void act(async () => {
            const s = await window.meencode.git.commit(message)
            setMessage('')
            return s
          })}
        >
          <Icon name="check" size={12} /> Commit
        </button>
        <button className="btn" title="Set / change remote origin" onClick={() => setShowRemote(!showRemote)}>
          Remote…
        </button>
      </div>
      {showRemote && (
        <div className="git-remote-row">
          <input
            placeholder="git@github.com:user/repo.git or https://github.com/user/repo.git"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!remoteUrl.trim()}
            onClick={async () => {
              await window.meencode.git.addRemote(remoteUrl.trim())
              setShowRemote(false)
              setErr(null)
            }}
          >
            Save remote
          </button>
        </div>
      )}
    </div>
  )
}

function GitFile({ f, actionLabel, onAction, onDiscard }: { f: GitFileStatus; actionLabel: string; onAction: () => void; onDiscard?: () => void }) {
  const openFile = useStore((s) => s.openFile)
  const letter = f.untracked ? 'U' : f.x !== ' ' ? f.x : f.y
  return (
    <div className="git-file">
      <span className={`git-letter ${f.staged ? 'staged' : ''}`}>{letter}</span>
      <button className="git-file-path" title={f.path} onClick={() => void openFile(f.path)}>
        {f.path}
      </button>
      <button className="mini-btn" title={actionLabel} onClick={onAction}>
        <Icon name={actionLabel === 'Stage' ? 'plus' : 'revert'} size={10} />
      </button>
      {onDiscard && (
        <button className="mini-btn danger" title="Discard changes" onClick={onDiscard}>
          <Icon name="x" size={10} />
        </button>
      )}
    </div>
  )
}