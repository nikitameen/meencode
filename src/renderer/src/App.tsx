import { useEffect, useState } from 'react'
import { useStore } from './store'
import { initBridge } from './ipc'
import { ActivityBar, type ActivityView } from './components/ActivityBar'
import { MenuBar } from './components/MenuBar'
import { Tabs } from './components/Tabs'
import { Editor } from './components/Editor'
import { ChatPanel } from './components/ChatPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { BrowserPanel } from './components/BrowserPanel'
import { CommandPalette } from './components/CommandPalette'
import { SettingsModal } from './components/SettingsModal'
import { ReviewModal } from './components/ReviewModal'
import { CheckpointsModal } from './components/CheckpointsModal'
import { KnowledgeModal } from './components/KnowledgeModal'
import { SearchPanel } from './components/SearchPanel'
import { InlineEditBar } from './components/InlineEdit'
import { StatusBar } from './components/StatusBar'
import { Icon } from './components/ui'
import { toggleTheme } from './theme'

declare global {
  interface Window {
    __meencodeActiveView?: { set: (v: ActivityView) => void }
  }
}

export function App() {
  const init = useStore((s) => s.init)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const chatOpen = useStore((s) => s.chatOpen)
  const terminalOpen = useStore((s) => s.terminalOpen)
  const workspace = useStore((s) => s.settings?.workspace)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const toggleChat = useStore((s) => s.toggleChat)
  const toggleTerminal = useStore((s) => s.toggleTerminal)
  const saveActiveTab = useStore((s) => s.saveActiveTab)
  const openFolder = useStore((s) => s.openFolder)
  const set = useStore((s) => s.set)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)

  useEffect(() => {
    initBridge()
    void init()
  }, [init])

  useEffect(() => {
    const toggleGit = () => setGitOpen((v) => !v)
    const toggleBrowser = () => setBrowserOpen((v) => !v)
    document.addEventListener('meencode:view-git', toggleGit)
    document.addEventListener('meencode:toggle-browser', toggleBrowser)
    return () => {
      document.removeEventListener('meencode:view-git', toggleGit)
      document.removeEventListener('meencode:toggle-browser', toggleBrowser)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        set('paletteMode', 'commands')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        set('paletteMode', 'files')
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveActiveTab()
      } else if (mod && e.key.toLowerCase() === 'b' && !e.altKey) {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setBrowserOpen((v) => !v)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        setGitOpen((v) => !v)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const s = useStore.getState()
        s.set('searchOpen', !s.searchOpen)
      } else if (mod && e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        useStore.getState().toggleHistory()
      } else if (mod && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        toggleTerminal()
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        toggleChat()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        toggleTheme()
      } else if (e.key === 'Escape') {
        set('paletteMode', null)
        set('settingsModalOpen', false)
        set('reviewModalOpen', false)
        set('knowledgeModalOpen', false)
      }
    }
    const onMenuKeys = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const s = useStore.getState()
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        const name = prompt('New file name (e.g. utils.ts)')
        if (name?.trim()) {
          void window.meencode.fs.create('', name.trim(), 'file')
            .then(() => s.refreshTree())
            .then(() => s.openFile(name.trim()))
            .catch((err: any) => alert(err?.message ?? 'Create failed'))
        }
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void s.openFolder()
      } else if (mod && e.key === '=') {
        e.preventDefault()
        void window.meencode.win.zoom('in')
      } else if (mod && e.key === '-') {
        e.preventDefault()
        void window.meencode.win.zoom('out')
      } else if (mod && e.key === '0') {
        e.preventDefault()
        void window.meencode.win.zoom('reset')
      } else if (e.key === 'F1') {
        e.preventDefault()
        s.set('paletteMode', 'commands')
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onMenuKeys)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onMenuKeys)
    }
  }, [set, saveActiveTab, toggleSidebar, toggleTerminal, toggleChat])

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-left">
          <span className="logo"><Icon name="sparkle" size={14} /></span>
          <span className="app-name">Meencode</span>
        </div>
        <div className="titlebar-center">
          <button className="ws-btn" onClick={() => void openFolder()} title="Open workspace folder">
            <Icon name="folder" size={12} />
            {workspace ? workspace.split(/[\\/]/).join(' › ') : 'Open a folder'}
          </button>
        </div>
        <div className="titlebar-right">
          <button className={`win-btn tool ${browserOpen ? 'on' : ''}`} onClick={() => setBrowserOpen(!browserOpen)} title="Built-in browser (Ctrl+Alt+B)">
            <Icon name="browser" size={13} />
          </button>
          <span className="titlebar-divider" />
          <button className="win-btn" onClick={() => void window.meencode.win.minimize()} title="Minimize">
            <Icon name="min" size={12} />
          </button>
          <button className="win-btn" onClick={() => void window.meencode.win.maximize()} title="Maximize">
            <Icon name="max" size={11} />
          </button>
          <button className="win-btn close" onClick={() => void window.meencode.win.close()} title="Close">
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>
      <MenuBar />
      <div className="body">
        <ActivityBar />
        <div className="center">
          {browserOpen && (
            <div className="browser-dock">
              <BrowserPanel onClose={() => setBrowserOpen(false)} />
            </div>
          )}
          <div className="editor-area">
            {workspace ? (
              <>
                <Tabs />
                <InlineEditBar />
                <Editor />
              </>
            ) : (
              <div className="empty-state">
                <div className="empty-logo"><Icon name="sparkle" size={28} /></div>
                <div className="empty-title">Meencode</div>
                <div className="empty-sub">The sub-agent powered code editor, on Ollama Cloud.</div>
                <button className="btn primary big" onClick={() => void openFolder()}>
                  <Icon name="folder" size={14} /> Open a folder to begin
                </button>
                <div className="empty-hints">
                  <span>⌃⇧P commands</span>
                  <span>⌃P find files</span>
                  <span>⌃` terminal</span>
                  <span>⌃⇧G source control</span>
                  <span>⌃⌥B browser</span>
                  <span>⌃L chat</span>
                </div>
              </div>
            )}
          </div>
          {terminalOpen && <TerminalPanel />}
        </div>
        {chatOpen && <ChatPanel />}
      </div>
      <StatusBar />
      <SearchPanel />
      <CommandPalette />
      <SettingsModal />
      <ReviewModal />
      <CheckpointsModal />
      <KnowledgeModal />
    </div>
  )
}