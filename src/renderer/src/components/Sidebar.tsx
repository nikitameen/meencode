import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { FileTree } from './FileTree'
import { Icon } from './ui'

export function Sidebar() {
  const filter = useStore((s) => s.treeFilter)
  const set = useStore((s) => s.set)
  const refreshTree = useStore((s) => s.refreshTree)
  const files = useStore((s) => s.files)
  const [creating, setCreating] = useState<null | 'file' | 'dir'>(null)
  const [newName, setNewName] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])

  const newFileHere = async () => {
    const name = prompt('New file name (e.g. utils.ts)')
    if (!name?.trim()) return
    try {
      await window.meencode.fs.create('', name.trim(), 'file')
      await refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }

  const newFolderHere = async () => {
    const name = prompt('New folder name')
    if (!name?.trim()) return
    try {
      await window.meencode.fs.create('', name.trim(), 'dir')
      await refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const doCreate = async () => {
    if (!newName.trim() || !creating) return
    try {
      await window.meencode.fs.create('', newName.trim(), creating)
      setNewName('')
      setCreating(null)
      await refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }

  const importFiles = async () => {
    const r = await window.meencode.workspaceImport.importFiles()
    if (r.ok) {
      await refreshTree()
    } else if (r.message !== 'cancelled') {
      alert(r.message)
    }
  }

  const importFolder = async () => {
    const r = await window.meencode.workspaceImport.importFolder()
    if (r.ok) {
      await refreshTree()
    } else if (r.message !== 'cancelled') {
      alert(r.message)
    }
  }

  const doRename = async () => {
    if (!renaming || !renameValue.trim()) return
    try {
      await window.meencode.fs.rename(renaming, renameValue.trim())
      setRenaming(null)
      await refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Rename failed')
    }
  }

  const doDelete = async (path: string) => {
    if (!confirm(`Delete "${path}"? This cannot be undone.`)) return
    try {
      await window.meencode.fs.remove(path)
      await refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Delete failed')
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <span>FILES</span>
          <span className="sidebar-count">{files.length > 0 ? `${files.length}` : ''}</span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" title="New file" onClick={() => { setCreating('file'); setNewName('') }}>
            <Icon name="plus" />
          </button>
          <button className="icon-btn" title="New folder" onClick={() => { setCreating('dir'); setNewName('') }}>
            <Icon name="plusFolder" />
          </button>
          <div className="more-wrap" ref={moreRef}>
            <button className="icon-btn" title="More actions — import, refresh" onClick={() => setMoreOpen(!moreOpen)}>
              <Icon name="dots" />
            </button>
            {moreOpen && (
              <div className="ctx-menu up">
                <button onClick={() => { setMoreOpen(false); void importFiles() }}>
                  <Icon name="import" size={12} /> Import Files…
                </button>
                <button onClick={() => { setMoreOpen(false); void importFolder() }}>
                  <Icon name="import" size={12} /> Import Folder…
                </button>
                <div className="ctx-sep" />
                <button onClick={() => { setMoreOpen(false); void newFileHere() }}>
                  <Icon name="plus" size={12} /> New File…
                </button>
                <button onClick={() => { setMoreOpen(false); void newFolderHere() }}>
                  <Icon name="plusFolder" size={12} /> New Folder…
                </button>
                <div className="ctx-sep" />
                <button onClick={() => { setMoreOpen(false); void refreshTree() }}>
                  <Icon name="refresh" size={12} /> Refresh Explorer
                </button>
              </div>
            )}
          </div>
          <button className="icon-btn" title="Refresh" onClick={() => void refreshTree()}>
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="sidebar-search">
        <Icon name="search" size={12} />
        <input
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => set('treeFilter', e.target.value)}
        />
      </div>
      {creating && (
        <div className="inline-create">
          {creating === 'dir' && <Icon name="folder" />}
          {creating === 'file' && <Icon name="file" />}
          <input
            autoFocus
            placeholder={creating === 'file' ? 'file name (e.g. utils.ts)' : 'folder name'}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doCreate()
              if (e.key === 'Escape') setCreating(null)
            }}
            onBlur={() => setCreating(null)}
          />
        </div>
      )}
      {renaming && (
        <div className="inline-create">
          <Icon name="file" />
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename()
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => setRenaming(null)}
          />
        </div>
      )}
      <FileTree />
      <div className="sidebar-footer">
        <span className="hint">Right-click files & folders for actions · ⋯ for import</span>
      </div>
    </div>
  )
}

export function FileTreeWithMenu() {
  // wraps FileTree with a context menu via event delegation
  return <FileTree />
}