import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { monaco } from '../monacoSetup'
import { toggleTheme } from '../theme'
import { Icon } from './ui'

type Item =
  | { kind: 'item'; label: string; accel?: string; run: () => void; danger?: boolean; disabled?: boolean }
  | { kind: 'sep' }

type Menu = { name: string; items: Item[] }

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const store = useStore.getState
  const settings = useStore((s) => s.settings)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])

  const openFolder = () => void store().openFolder()
  const newFile = async () => {
    const name = prompt('New file name (e.g. utils.ts)')
    if (!name?.trim()) return
    try {
      await window.meencode.fs.create('', name.trim(), 'file')
      await store().refreshTree()
      await store().openFile(name.trim())
    } catch (e: any) {
      alert(e?.message ?? 'Create failed')
    }
  }

  const withEditor = (fn: (ed: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel) => void) => {
    const ed = (window as any).__meencodeActiveEditor as monaco.editor.IStandaloneCodeEditor | undefined
    const model = ed?.getModel()
    if (!ed || !model) return
    fn(ed, model)
  }

  const menus: Menu[] = [
    {
      name: 'File',
      items: [
        { kind: 'item', label: 'New File…', accel: 'Ctrl+N', run: () => void newFile() },
        { kind: 'item', label: 'Open Folder…', accel: 'Ctrl+O', run: openFolder },
        { kind: 'item', label: 'Save', accel: 'Ctrl+S', run: () => void store().saveActiveTab() },
        { kind: 'sep' },
        { kind: 'item', label: 'Import Files into Workspace…', run: () => void window.meencode.workspaceImport.importFiles().then((r) => { if (r.ok) void store().refreshTree(); else if (r.message !== 'cancelled') alert(r.message) }) },
        { kind: 'item', label: 'Import Folder into Workspace…', run: () => void window.meencode.workspaceImport.importFolder().then((r) => { if (r.ok) void store().refreshTree(); else if (r.message !== 'cancelled') alert(r.message) }) },
        { kind: 'sep' },
        { kind: 'item', label: 'Close Tab', run: () => { const t = store().activeTab; if (t) store().closeTab(t) } },
        { kind: 'item', label: 'Settings…', run: () => store().set('settingsModalOpen', true) },
        { kind: 'item', label: 'Exit', run: () => void window.meencode.win.close() }
      ]
    },
    {
      name: 'Edit',
      items: [
        { kind: 'item', label: 'Undo', accel: 'Ctrl+Z', run: () => { withEditor((ed) => ed.trigger('menu', 'undo', null)); document.execCommand('undo') } },
        { kind: 'item', label: 'Redo', accel: 'Ctrl+Y', run: () => { withEditor((ed) => ed.trigger('menu', 'redo', null)) } },
        { kind: 'sep' },
        { kind: 'item', label: 'Cut', accel: 'Ctrl+X', run: () => document.execCommand('cut') },
        { kind: 'item', label: 'Copy', accel: 'Ctrl+C', run: () => document.execCommand('copy') },
        { kind: 'item', label: 'Paste', accel: 'Ctrl+V', run: () => document.execCommand('paste') },
        { kind: 'sep' },
        { kind: 'item', label: 'Find in File', accel: 'Ctrl+F', run: () => withEditor((ed) => ed.getAction('actions.find')?.run()) },
        { kind: 'item', label: 'Replace in File', accel: 'Ctrl+H', run: () => withEditor((ed) => ed.getAction('editor.action.startFindReplaceAction')?.run()) }
      ]
    },
    {
      name: 'Selection',
      items: [
        { kind: 'item', label: 'Select All', accel: 'Ctrl+A', run: () => withEditor((ed, model) => ed.setSelection(model.getFullModelRange())) },
        { kind: 'sep' },
        { kind: 'item', label: 'Copy Line Up', run: () => withEditor((ed) => ed.getAction('editor.action.copyLinesUpAction')?.run()) },
        { kind: 'item', label: 'Copy Line Down', run: () => withEditor((ed) => ed.getAction('editor.action.copyLinesDownAction')?.run()) },
        { kind: 'item', label: 'Move Line Up', accel: 'Alt+↑', run: () => withEditor((ed) => ed.getAction('editor.action.moveLinesUpAction')?.run()) },
        { kind: 'item', label: 'Move Line Down', accel: 'Alt+↓', run: () => withEditor((ed) => ed.getAction('editor.action.moveLinesDownAction')?.run()) },
        { kind: 'sep' },
        { kind: 'item', label: 'Add Cursor Below', accel: 'Ctrl+Alt+↓', run: () => withEditor((ed) => ed.getAction('editor.action.insertCursorBelow')?.run()) },
        { kind: 'item', label: 'Add Cursor Above', accel: 'Ctrl+Alt+↑', run: () => withEditor((ed) => ed.getAction('editor.action.insertCursorAbove')?.run()) },
        { kind: 'item', label: 'Select All Occurrences', accel: 'Ctrl+Shift+L', run: () => withEditor((ed) => ed.getAction('editor.action.selectHighlights')?.run()) }
      ]
    },
    {
      name: 'View',
      items: [
        { kind: 'item', label: 'Command Palette…', accel: 'Ctrl+Shift+P', run: () => store().set('paletteMode', 'commands') },
        { kind: 'item', label: 'Search Codebase…', accel: 'Ctrl+Shift+F', run: () => store().set('searchOpen', !store().searchOpen) },
        { kind: 'sep' },
        { kind: 'item', label: 'Toggle Sidebar', accel: 'Ctrl+B', run: () => store().toggleSidebar() },
        { kind: 'item', label: 'Toggle Terminal', accel: 'Ctrl+`', run: () => store().toggleTerminal() },
        { kind: 'item', label: 'Toggle Chat (Agent)', accel: 'Ctrl+L', run: () => store().toggleChat() },
        { kind: 'item', label: 'Toggle Git Panel', accel: 'Ctrl+Shift+G', run: () => document.dispatchEvent(new CustomEvent('meencode:view-git')) },
        { kind: 'item', label: 'Toggle Browser', accel: 'Ctrl+Alt+B', run: () => document.dispatchEvent(new CustomEvent('meencode:toggle-browser')) },
        { kind: 'sep' },
        { kind: 'item', label: 'Zoom In', accel: 'Ctrl+=', run: () => void window.meencode.win.zoom('in') },
        { kind: 'item', label: 'Zoom Out', accel: 'Ctrl+-', run: () => void window.meencode.win.zoom('out') },
        { kind: 'item', label: 'Reset Zoom', accel: 'Ctrl+0', run: () => void window.meencode.win.zoom('reset') },
        { kind: 'sep' },
        { kind: 'item', label: 'Toggle Light/Dark Theme', accel: 'Ctrl+Shift+T', run: () => toggleTheme() },
        { kind: 'item', label: 'Toggle AI Autocomplete', run: () => store().set('autocompleteEnabled', !store().autocompleteEnabled) },
        { kind: 'item', label: 'Toggle Developer Tools', run: () => void window.meencode.dev.tools() }
      ]
    },
    {
      name: 'Go',
      items: [
        { kind: 'item', label: 'Go to File…', accel: 'Ctrl+P', run: () => store().set('paletteMode', 'files') },
        { kind: 'item', label: 'Go to Line…', accel: 'Ctrl+G', run: () => withEditor((ed) => ed.getAction('editor.action.gotoLine')?.run()) },
        { kind: 'item', label: 'Go to Symbol…', accel: 'Ctrl+Shift+O', run: () => withEditor((ed) => ed.getAction('editor.action.quickOutline')?.run()) },
        { kind: 'sep' },
        { kind: 'item', label: 'Next Tab', accel: 'Ctrl+Tab', run: () => nextTab(1) },
        { kind: 'item', label: 'Previous Tab', accel: 'Ctrl+Shift+Tab', run: () => nextTab(-1) }
      ]
    },
    {
      name: 'Run',
      items: [
        { kind: 'item', label: 'Ask Agent about Selection', run: () => askAgentAboutSelection() },
        { kind: 'item', label: 'AI Edit Selection (Cmd+K)', accel: 'Ctrl+K', run: () => withEditor((ed) => ed.focus()) },
        { kind: 'sep' },
        { kind: 'item', label: 'Review Agent Changes', accel: 'Ctrl+Shift+R', run: () => store().set('reviewModalOpen', true) },
        { kind: 'item', label: 'Restore Checkpoint…', run: () => store().set('checkpointsModalOpen', true) }
      ]
    },
    {
      name: 'Terminal',
      items: [
        { kind: 'item', label: 'New Shell', run: () => { store().set('terminalOpen', true); document.dispatchEvent(new CustomEvent('meencode:new-shell')) } },
        { kind: 'item', label: 'Show Agent Terminal', accel: 'Ctrl+J', run: () => store().toggleTerminal() },
        { kind: 'sep' },
        { kind: 'item', label: 'Suggest Command (AI)', run: () => document.dispatchEvent(new CustomEvent('meencode:suggest-command')) },
        { kind: 'item', label: 'Git: Commit…', run: () => document.dispatchEvent(new CustomEvent('meencode:view-git')) }
      ]
    },
    {
      name: 'Help',
      items: [
        { kind: 'item', label: 'About Meencode', run: () => void showAbout() },
        { kind: 'item', label: 'Keyboard Shortcuts', accel: 'F1', run: () => store().set('paletteMode', 'commands') },
        { kind: 'sep' },
        { kind: 'item', label: 'Ollama Cloud (get API key)', run: () => void window.meencode.openExternal('https://ollama.com/sign-in') },
        { kind: 'item', label: 'Documentation', run: () => void window.meencode.openExternal('https://github.com/') }
      ]
    }
  ]

  const nextTab = (dir: 1 | -1) => {
    const s = store()
    const idx = s.tabs.findIndex((t) => t.path === s.activeTab)
    if (idx === -1 || s.tabs.length < 2) return
    const next = s.tabs[(idx + dir + s.tabs.length) % s.tabs.length]
    s.setActiveTab(next.path)
  }

  const askAgentAboutSelection = () => {
    const ed = (window as any).__meencodeActiveEditor as monaco.editor.IStandaloneCodeEditor | undefined
    const model = ed?.getModel()
    const sel = ed?.getSelection()
    if (!ed || !model || !sel || sel.isEmpty()) {
      alert('Select some code in the editor first.')
      return
    }
    const code = model.getValueInRange(sel)
    const path = decodeURIComponent(model.uri.path.replace(/^\//, ''))
    store().toggleChat()
    document.dispatchEvent(new CustomEvent('meencode:prefill-chat', { detail: `Explain this code from @${path}:\n\n${code.slice(0, 1500)}` }))
  }

  const showAbout = async () => {
    const a = await window.meencode.about()
    alert(
      `${a.app} v${a.version}\n\n` +
      `Model: ${a.model}\n` +
      `Workspace: ${a.workspace ?? '(none)'}\n` +
      `Electron: ${a.electron}\n` +
      `Node: ${a.node}\n\n` +
      `An autonomous code agent with sub-agents, powered by Ollama Cloud.`
    )
  }

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((m) => (
        <div key={m.name} className={`menubar-item ${open === m.name ? 'open' : ''}`}>
          <button
            onMouseDown={(e) => { e.preventDefault(); setOpen(open === m.name ? null : m.name) }}
            onMouseEnter={() => { if (open && open !== m.name) setOpen(m.name) }}
          >
            {m.name}
          </button>
          {open === m.name && (
            <div className="ctx-menu down">
              {m.items.map((item, i) =>
                item.kind === 'sep' ? (
                  <div key={i} className="ctx-sep" />
                ) : (
                  <button
                    key={i}
                    disabled={item.disabled}
                    className={item.danger ? 'danger' : ''}
                    onClick={() => { setOpen(null); item.run() }}
                  >
                    <span className="menu-label">{item.label}</span>
                    {item.accel && <span className="menu-accel">{item.accel}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
      <div className="menubar-right">
        <span className="menubar-model" title="Active model" onClick={() => store().set('settingsModalOpen', true)}>
          {settings?.model ? settings.model : 'no model'}
        </span>
      </div>
    </div>
  )
}