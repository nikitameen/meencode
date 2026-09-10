import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { FileTree } from './FileTree'
import { GitPanel } from './GitPanel'
import { Icon } from './ui'

export type ActivityView = 'workspace' | 'explorer' | 'search' | 'git' | 'agent'

export function ActivityBar() {
  const [view, setView] = useState<ActivityView>('explorer')
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const set = useStore((s) => s.set)
  const changes = useStore((s) => s.changes.filter((c) => c.status === 'pending').length)
  const [gitDirty, setGitDirty] = useState(0)

  // allow menus / shortcuts to switch views
  useEffect(() => {
    window.__meencodeActiveView = {
      set: (v: ActivityView) => {
        setView(v)
        useStore.getState().set('sidebarOpen', true)
      }
    }
    const onGoGit = () => window.__meencodeActiveView?.set('git')
    const onGoExplorer = () => window.__meencodeActiveView?.set('explorer')
    const onGoSearch = () => window.__meencodeActiveView?.set('search')
    document.addEventListener('meencode:view-git', onGoGit)
    document.addEventListener('meencode:view-explorer', onGoExplorer)
    document.addEventListener('meencode:view-search', onGoSearch)
    return () => {
      window.__meencodeActiveView = undefined
      document.removeEventListener('meencode:view-git', onGoGit)
      document.removeEventListener('meencode:view-explorer', onGoExplorer)
      document.removeEventListener('meencode:view-search', onGoSearch)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const g = await window.meencode.git.state()
        if (alive) setGitDirty(g.repo ? g.files.length : 0)
      } catch { /* no workspace */ }
    }
    void tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const items: { id: ActivityView; icon: 'file' | 'search' | 'git' | 'chat' | 'folder'; label: string; badge?: number }[] = [
    { id: 'workspace', icon: 'folder', label: 'Workspace (Ctrl+Shift+W) — manage folders' },
    { id: 'explorer', icon: 'file', label: 'Explorer (Ctrl+Shift+E)' },
    { id: 'search', icon: 'search', label: 'Search (Ctrl+Shift+F)' },
    { id: 'git', icon: 'git', label: 'Source Control (Ctrl+Shift+G)', badge: gitDirty || undefined },
    { id: 'agent', icon: 'chat', label: 'Agent & Review' }
  ]

  return (
    <div className="activitybar">
      <div className="activity-rail">
        {items.map((item) => (
          <button
            key={item.id}
            className={`activity-item ${sidebarOpen && view === item.id ? 'active' : ''}`}
            title={item.label}
            onClick={() => {
              if (view === item.id && sidebarOpen) {
                set('sidebarOpen', false) // toggle collapse
              } else {
                setView(item.id)
                set('sidebarOpen', true)
              }
            }}
          >
            <Icon name={item.icon} size={20} />
            {item.badge !== undefined && item.badge > 0 && <span className="activity-badge">{item.badge > 99 ? '99+' : item.badge}</span>}
          </button>
        ))}
        <div className="activity-bottom">
          {changes > 0 && (
            <button className="activity-item" title={`${changes} agent changes pending review`} onClick={() => set('reviewModalOpen', true)}>
              <Icon name="review" size={18} />
              <span className="activity-badge warn">{changes}</span>
            </button>
          )}
          <button className="activity-item" title="Settings" onClick={() => set('settingsModalOpen', true)}>
            <Icon name="settings" size={18} />
          </button>
        </div>
      </div>
      {sidebarOpen && <SideView view={view} />}
    </div>
  )
}

function SideView({ view }: { view: ActivityView }) {
  switch (view) {
    case 'workspace':
      return <WorkspaceView />
    case 'explorer':
      return <ExplorerView />
    case 'search':
      return <SearchSideView />
    case 'git':
      return <GitSideView />
    case 'agent':
      return <AgentSideView />
  }
}

function WorkspaceView() {
  const settings = useStore((s) => s.settings)
  const set = useStore((s) => s.set)
  const refreshTree = useStore((s) => s.refreshTree)
  const roots = settings?.roots ?? []

  const addFolders = async () => {
    const r = await window.meencode.workspace.addFolders()
    if (r.ok) {
      const s = await window.meencode.settings.get()
      set('settings', s)
      await refreshTree()
    }
  }

  const removeRoot = async (abs: string) => {
    if (!confirm(`Remove folder from the workspace?\n${abs}\n\n(The folder stays on disk.)`)) return
    await window.meencode.workspace.removeRoot(abs)
    const s = await window.meencode.settings.get()
    set('settings', s)
    await refreshTree()
  }

  const setPrimary = async (abs: string) => {
    const next = [abs, ...roots.filter((r) => r !== abs)]
    await window.meencode.settings.update({ roots: next })
    const s = await window.meencode.settings.get()
    set('settings', s)
    await refreshTree()
  }

  const reveal = (abs: string) => void window.meencode.fs.reveal('0:') /* placeholder */

  return (
    <div className="sideview">
      <div className="sideview-header">
        <span className="sideview-title">WORKSPACE</span>
        <button className="icon-btn" title="Add Folder to Workspace" onClick={() => void addFolders()}>
          <Icon name="plusFolder" />
        </button>
      </div>
      <div className="sideview-body">
        {roots.length === 0 && (
          <div className="ws-empty">
            <Icon name="folder" size={22} />
            <div className="ws-empty-title">No folders in workspace</div>
            <div className="ws-empty-sub">Add folders — the agent can work across all of them.</div>
            <button className="btn primary" onClick={() => void addFolders()}>
              <Icon name="plusFolder" size={13} /> Add Folder
            </button>
          </div>
        )}
        {roots.map((abs, i) => (
          <div key={abs} className="ws-root">
            <div className="ws-root-head" onClick={() => void setPrimary(abs)} title="Click to make primary (agent & terminal root)">
              <Icon name={i === 0 ? 'folderOpen' : 'folder'} size={13} />
              <span className="ws-root-name">{abs.split(/[\\/]/).pop()}</span>
              {i === 0 && <span className="ws-primary-badge">primary</span>}
            </div>
            <div className="ws-root-path" title={abs}>{abs}</div>
            <div className="ws-root-actions">
              <button className="mini-btn" title="Reveal in Explorer" onClick={() => void window.meencode.openExternal(abs)}>
                <Icon name="external" size={10} />
              </button>
              <button className="mini-btn danger" title="Remove from workspace" onClick={() => void removeRoot(abs)}>
                <Icon name="x" size={10} />
              </button>
            </div>
          </div>
        ))}
        {roots.length > 0 && (
          <button className="btn" onClick={() => void addFolders()}>
            <Icon name="plusFolder" size={12} /> Add Folder to Workspace
          </button>
        )}
      </div>
    </div>
  )
}

function ExplorerView() {
  const filter = useStore((s) => s.treeFilter)
  const set = useStore((s) => s.set)
  const refreshTree = useStore((s) => s.refreshTree)
  const files = useStore((s) => s.files)
  const settings = useStore((s) => s.settings)
  const [moreOpen, setMoreOpen] = useState(false)

  const addFolderToWorkspace = async () => {
    const r = await window.meencode.workspace.addFolders()
    if (r.ok) {
      const s = await window.meencode.settings.get()
      set('settings', s)
      await refreshTree()
    }
  }

  const removeRoot = async (abs: string) => {
    if (!confirm(`Remove folder from the workspace?\n${abs}\n\n(The folder stays on disk.)`)) return
    await window.meencode.workspace.removeRoot(abs)
    const s = await window.meencode.settings.get()
    set('settings', s)
    await refreshTree()
  }

  const newFileHere = async (dir?: string) => {
    const name = prompt('New file name (e.g. utils.ts)')
    if (!name?.trim()) return
    try {
      const scoped = await window.meencode.fs.create(dir ?? '0:', name.trim(), 'file')
      await refreshTree()
      await useStore.getState().openFile(scoped)
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }

  const newFolderHere = async (dir?: string) => {
    const name = prompt('New folder name')
    if (!name?.trim()) return
    try {
      await window.meencode.fs.create(dir ?? '0:', name.trim(), 'dir')
      await refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }

  const importFiles = async () => {
    const r = await window.meencode.workspaceImport.importFiles()
    if (r.ok) await refreshTree()
    else if (r.message !== 'cancelled') alert(r.message)
  }

  const importFolder = async () => {
    const r = await window.meencode.workspaceImport.importFolder()
    if (r.ok) await refreshTree()
    else if (r.message !== 'cancelled') alert(r.message)
  }

  const roots = settings?.roots ?? []

  return (
    <div className="sideview">
      <div className="sideview-header">
        <span className="sideview-title">EXPLORER{roots.length > 1 ? ` — ${roots.length} folders` : ''}</span>
        <div className="sidebar-actions">
          <button className="icon-btn" title="New File" onClick={() => void newFileHere()}><Icon name="plus" /></button>
          <button className="icon-btn" title="New Folder" onClick={() => void newFolderHere()}><Icon name="plusFolder" /></button>
          <button className="icon-btn" title="Add Folder to Workspace" onClick={() => void addFolderToWorkspace()}><Icon name="folderOpen" /></button>
          <div className="more-wrap">
            <button className="icon-btn" title="More actions" onClick={() => setMoreOpen(!moreOpen)}><Icon name="dots" /></button>
            {moreOpen && (
              <div className="ctx-menu up" onMouseLeave={() => setMoreOpen(false)}>
                <button onClick={() => { setMoreOpen(false); void addFolderToWorkspace() }}><Icon name="folderOpen" size={12} /> Add Folder to Workspace…</button>
                <button onClick={() => { setMoreOpen(false); void importFiles() }}><Icon name="import" size={12} /> Import Files…</button>
                <button onClick={() => { setMoreOpen(false); void importFolder() }}><Icon name="import" size={12} /> Import Folder…</button>
                <div className="ctx-sep" />
                <button onClick={() => { setMoreOpen(false); void refreshTree() }}><Icon name="refresh" size={12} /> Refresh</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {roots.length === 0 ? (
        <div className="sideview-body">
          <div className="ws-empty">
            <Icon name="folder" size={22} />
            <div className="ws-empty-title">No workspace folders</div>
            <div className="ws-empty-sub">Add one or more folders — they all appear here as sections.</div>
            <button className="btn primary" onClick={() => void addFolderToWorkspace()}>
              <Icon name="plusFolder" size={13} /> Add Folder to Workspace
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="sidebar-search">
            <Icon name="search" size={12} />
            <input placeholder="Filter files…" value={filter} onChange={(e) => set('treeFilter', e.target.value)} />
          </div>
          <FileTree onRemoveRoot={removeRoot} />
          <div className="ws-add-row" onClick={() => void addFolderToWorkspace()}>
            <Icon name="plusFolder" size={12} /> Add Folder to Workspace
          </div>
          <div className="sidebar-footer">
            <span className="hint">{files.length} files · right-click for actions</span>
          </div>
        </>
      )}
    </div>
  )
}

function SearchSideView() {
  const set = useStore((s) => s.set)
  const openFile = useStore((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ path: string; line: number; text: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [indexed, setIndexed] = useState<string | null>(null)

  const run = async () => {
    if (!query.trim()) { setHits([]); return }
    setBusy(true)
    const idx = await window.meencode.cursor.indexCodebase().catch(() => ({ ok: false }))
    if ((idx as any).ok) setIndexed(`${(idx as any).files} files`)
    const results = await window.meencode.cursor.searchCodebase(query, 50)
    setHits(results)
    setBusy(false)
  }

  return (
    <div className="sideview">
      <div className="sideview-header">
        <span className="sideview-title">SEARCH</span>
        {indexed && <span className="sideview-sub">{indexed}</span>}
      </div>
      <div className="sideview-body">
        <div className="search-box">
          <input
            autoFocus
            value={query}
            placeholder="Find in codebase…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run() }}
          />
          <button className="btn" disabled={busy || !query.trim()} onClick={() => void run()}>
            {busy ? '…' : 'Search'}
          </button>
        </div>
        {busy && <div className="git-none">Indexing workspace…</div>}
        {hits.length > 0 && (
          <div className="side-results">
            <div className="sideview-sub">{hits.length} results</div>
            {hits.map((h, i) => (
              <div key={`${h.path}:${h.line}:${i}`} className="side-hit" onClick={() => void openFile(h.path)}>
                <span className="side-hit-loc">{h.path}:{h.line}</span>
                <code className="side-hit-text">{h.text}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function GitSideView() {
  return (
    <div className="sideview">
      <div className="sideview-header">
        <span className="sideview-title">SOURCE CONTROL</span>
      </div>
      <div className="sideview-body">
        <GitPanel embedded />
      </div>
    </div>
  )
}

function AgentSideView() {
  const changes = useStore((s) => s.changes)
  const set = useStore((s) => s.set)
  const revertChange = useStore((s) => s.revertChange)
  const keepChange = useStore((s) => s.keepChange)
  const openFile = useStore((s) => s.openFile)
  const plan = useStore((s) => s.plan)

  return (
    <div className="sideview">
      <div className="sideview-header">
        <span className="sideview-title">AGENT</span>
      </div>
      <div className="sideview-body">
        {plan.length > 0 && (
          <div className="side-section">
            <div className="side-section-title">Plan — {plan.filter((p) => p.status === 'done').length}/{plan.length} done</div>
            {plan.map((p) => (
              <div key={p.id} className={`side-plan-step ${p.status}`}>
                <span className="plan-check {p.status}">{p.status === 'done' ? '✓' : p.id}</span>
                <span>{p.title}</span>
              </div>
            ))}
          </div>
        )}
        <div className="side-section">
          <div className="side-section-title">Changes ({changes.length})</div>
          {changes.length === 0 && <div className="git-none">No agent changes in this session.</div>}
          {changes.map((c) => (
            <div key={c.change.path} className="side-change" onClick={() => void openFile(c.change.path)}>
              <span className={`change-kind kind-${c.change.kind}`}>{c.change.kind}</span>
              <span className="side-change-path">{c.change.path}</span>
              {c.status === 'pending' && (
                <>
                  <button className="mini-btn" title="Keep" onClick={(e) => { e.stopPropagation(); keepChange(c.change.path) }}>✓</button>
                  <button className="mini-btn danger" title="Revert" onClick={(e) => { e.stopPropagation(); void revertChange(c.change.path) }}>↺</button>
                </>
              )}
            </div>
          ))}
        </div>
        <button className="btn" onClick={() => set('reviewModalOpen', true)}><Icon name="review" size={12} /> Review all in diff view</button>
      </div>
    </div>
  )
}