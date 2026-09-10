import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { FileNode } from '../../../shared/types'
import { Icon } from './ui'

/** "0:" -> absolute path of roots[0] from settings */
function absOfRoot(rootScoped: string): string {
  const idx = Number(rootScoped.replace(/:$/, ''))
  const roots = useStore.getState().settings?.roots ?? []
  return roots[idx] ?? ''
}

type MenuTarget = { path: string; type: 'file' | 'dir'; name: string } | null

export function FileTree({ onRemoveRoot }: { onRemoveRoot?: (abs: string) => void }) {
  const tree = useStore((s) => s.tree)
  const filter = useStore((s) => s.treeFilter)
  const openFile = useStore((s) => s.openFile)
  const const_refreshTree = useStore((s) => s.refreshTree)
  const activeTab = useStore((s) => s.activeTab)
  const setCreating = useStore((s) => s.set)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const [clip, setClip] = useState<string | null>(null)

  useEffect(() => {
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const matches = (node: FileNode): boolean => {
    if (!filter) return true
    if (node.type === 'file') return node.path.toLowerCase().includes(filter.toLowerCase())
    return (node.children ?? []).some(matches)
  }

  const findNode = (nodes: FileNode[], path: string): FileNode | null => {
    for (const n of nodes) {
      if (n.path === path) return n
      if (n.children) {
        const f = findNode(n.children, path)
        if (f) return f
      }
    }
    return null
  }

  const doDelete = async (path: string) => {
    if (!confirm(`Delete "${path}"? This cannot be undone.`)) return
    try {
      await window.meencode.fs.remove(path)
      await const_refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Delete failed')
    }
  }

  const doRename = async (path: string, name: string) => {
    const newName = prompt('New name', name)
    if (!newName || newName === name) return
    try {
      await window.meencode.fs.rename(path, newName)
      await const_refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Rename failed')
    }
  }

  const doCopy = async (path: string) => {
    const dot = path.lastIndexOf('.')
    const copyName = dot > 0 ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`
    try {
      const content = await window.meencode.fs.read(path)
      await window.meencode.fs.write(copyName, content)
      await const_refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Copy failed')
    }
  }

  const doNewIn = async (dir: string, type: 'file' | 'dir') => {
    const name = prompt(type === 'file' ? 'New file name (e.g. utils.ts)' : 'New folder name')
    if (!name?.trim()) return
    try {
      await window.meencode.fs.create(dir, name.trim(), type)
      await const_refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }

  const doPaste = async (dir: string) => {
    if (!clip) return
    try {
      const content = await window.meencode.fs.read(clip)
      const name = clip.split('/').pop() ?? 'file'
      const dot = name.lastIndexOf('.')
      const copyName = dot > 0 ? `${name.slice(0, dot)}-copy${name.slice(dot)}` : `${name}-copy`
      await window.meencode.fs.write(`${dir ? dir + '/' : ''}${copyName}`, content)
      await const_refreshTree()
    } catch (e: any) {
      alert(e?.message ?? 'Paste failed')
    }
  }

  const onContextMenu = (e: React.MouseEvent, target: NonNullable<MenuTarget>) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 300), target })
  }

  const render = (nodes: FileNode[], depth: number = 0): React.ReactNode =>
    nodes
      .filter(matches)
      .map((node) => {
        // top-level nodes are workspace root sections ("0:", "1:" …)
        const isRootSection = /^[01-9]:$/.test(node.path)
        return (
        <div key={node.path} style={{ paddingLeft: depth * 14 + 8 }} className={isRootSection ? 'root-section' : undefined}>
          {node.type === 'dir' ? (
            <div
              className={`tree-row ${isRootSection ? 'root-row' : ''}`}
              onContextMenu={(e) => onContextMenu(e, { path: node.path, type: 'dir', name: node.name })}
              onClick={() => toggle(node.path)}
            >
              <span className="tree-chevron">{expanded.has(node.path) ? '▾' : '▸'}</span>
              <Icon name={expanded.has(node.path) ? 'folderOpen' : 'folder'} />
              <span className="tree-name">{node.name}</span>
              {isRootSection && (
                <button
                  className="root-remove"
                  title="Remove folder from workspace (keeps files on disk)"
                  onClick={(e) => { e.stopPropagation(); onRemoveRoot?.(absOfRoot(node.path)) }}
                >
                  <Icon name="x" size={10} />
                </button>
              )}
            </div>
          ) : (
            <div
              className={`tree-row file ${activeTab === node.path ? 'active' : ''}`}
              onContextMenu={(e) => onContextMenu(e, { path: node.path, type: 'file', name: node.name })}
              onClick={() => void openFile(node.path)}
            >
              <span className="tree-chevron" />
              <Icon name="file" />
              <span className="tree-name">{node.name}</span>
            </div>
          )}
          {node.type === 'dir' && expanded.has(node.path) && node.children ? render(node.children, depth + 1) : null}
        </div>
        )
      })

  return (
    <div className="file-tree">
      {tree.length > 0 ? render(tree) : <div className="tree-empty">No files — right-click to create</div>}
      {menu && menu.target && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.target.type === 'file' && (
            <>
              <button onClick={() => { void openFile(menu.target!.path); setMenu(null) }}>Open</button>
              <button onClick={() => { void doRename(menu.target!.path, menu.target!.name); setMenu(null) }}>Rename…</button>
              <button onClick={() => { setClip(menu.target!.path); setMenu(null) }}>Copy</button>
              <button onClick={() => { void doCopy(menu.target!.path); setMenu(null) }}>Duplicate</button>
              <button onClick={() => { void window.meencode.fs.reveal(menu.target!.path); setMenu(null) }}>Reveal in Explorer</button>
              <div className="ctx-sep" />
              <button className="danger" onClick={() => { void doDelete(menu.target!.path); setMenu(null) }}>Delete</button>
            </>
          )}
          {menu.target.type === 'dir' && (
            <>
              <button onClick={() => { void doNewIn(menu.target!.path, 'file'); setMenu(null) }}>New File…</button>
              <button onClick={() => { void doNewIn(menu.target!.path, 'dir'); setMenu(null) }}>New Folder…</button>
              <button onClick={() => { void doPaste(menu.target!.path); setMenu(null) }} disabled={!clip}>Paste{clip ? ` (${clip.split('/').pop()})` : ''}</button>
              <button onClick={() => { void window.meencode.fs.reveal(menu.target!.path); setMenu(null) }}>Reveal in Explorer</button>
              <div className="ctx-sep" />
              <button className="danger" onClick={() => { void doDelete(menu.target!.path); setMenu(null) }}>Delete</button>
            </>
          )}
        </div>
      )}
      {menu === null && clip && (
        <div className="clipboard-hint" onClick={() => setClip(null)}>
          copied: {clip.split('/').pop()} ×
        </div>
      )}
    </div>
  )
}