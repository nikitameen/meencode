import { useEffect, useRef, useState } from 'react'
import { useStore, ensureModel, setActiveEditor } from '../store'
import { monaco } from '../monacoSetup'

let completionSeq = 0

export function Editor() {
  const activeTab = useStore((s) => s.activeTab)
  const tabs = useStore((s) => s.tabs)
  const markDirty = useStore((s) => s.markDirty)
  const saveActiveTab = useStore((s) => s.saveActiveTab)
  const inlineEdit = useStore((s) => s.inlineEdit)
  const autocompleteEnabled = useStore((s) => s.autocompleteEnabled)
  const autocompleteEnabledRef = useRef(autocompleteEnabled)
  autocompleteEnabledRef.current = autocompleteEnabled
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const ghostRef = useRef<{ ids: string[]; text: string; tier: 'local' | 'cloud' | null }>({ ids: [], text: '', tier: null })
  const completersRef = useRef<{ seq: number; abort: AbortController | null }>({ seq: 0, abort: null })

  // ---- create editor once ----
  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      theme: 'meencode-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      renderLineHighlight: 'none',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      tabSize: 2,
      inlineSuggest: { enabled: false }
    })
    editorRef.current = editor
    setActiveEditor(editor)
    ;(window as any).__meencodeActiveEditor = editor
    editor.onDidChangeModelContent(() => {
      const p = editor.getModel()?.uri.path.replace(/^\//, '')
      if (p) markDirty(decodeURIComponent(p))
    })

    // ---- Ctrl+K / Cmd+K: inline edit ----
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const selection = editor.getSelection()
      const model = editor.getModel()
      if (!selection || !model) return
      const selected = model.getValueInRange(selection)
      const path = decodeURIComponent(model.uri.path.replace(/^\//, ''))
      const store = useStore.getState()
      store.set('inlineEdit', {
        active: true,
        path,
        selection: selected,
        instruction: '',
        status: 'idle',
        original: selected,
        proposed: '',
        error: null
      })
    })

    // ---- Ctrl+Space: cloud AI autocomplete ----
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      ;(editorRef.current as any)?.__clearGhost?.()
      void requestCompletion(true)
    })

    // ---- Tab: accept ghost text if present ----
    editor.addCommand(monaco.KeyCode.Tab, () => {
      const g = ghostRef.current
      if (g.text) {
        acceptGhost()
      } else {
        editor.trigger('keyboard', 'type', { text: '  ' })
      }
    })

    // ---- two-tier ghost completion: local instant + cloud refinement ----
    let localTimer: ReturnType<typeof setTimeout> | null = null
    let cloudTimer: ReturnType<typeof setTimeout> | null = null
    editor.onDidChangeModelContent(() => {
      if (!autocompleteEnabledRef.current) return
      if (localTimer) clearTimeout(localTimer)
      if (cloudTimer) clearTimeout(cloudTimer)
      ;(editorRef.current as any)?.__clearGhost?.()
      // tier 1: local instant (~150ms, feels immediate)
      localTimer = setTimeout(() => void requestLocal(), 150)
      // tier 2: cloud refinement after a typing pause
      cloudTimer = setTimeout(() => void requestCompletion(false), 1500)
    })

    async function requestLocal() {
      const editor2 = editorRef.current
      const model = editor2?.getModel()
      const pos = editor2?.getPosition()
      if (!editor2 || !model || !pos) return
      if (ghostRef.current.text) return // cloud already answered
      const path = decodeURIComponent(model.uri.path.replace(/^\//, ''))
      const offset = model.getOffsetAt(pos)
      const value = model.getValue()
      const prefix = value.slice(0, offset)
      const lastLine = prefix.split('\n').at(-1) ?? ''
      if (lastLine.trim().length < 2) return
      const r = await window.meencode.cursor.completeLocal({ prefix: lastLine, language: model.getLanguageId() })
      if (ghostRef.current.text) return
      if (r.completion) showGhost(r.completion, pos, 'local')
    }

    async function requestCompletion(manual: boolean) {
      const editor2 = editorRef.current
      const model = editor2?.getModel()
      if (!editor2 || !model) return
      const pos = editor2.getPosition()
      if (!pos) return
      if (!manual && ghostRef.current.text) return
      const path = decodeURIComponent(model.uri.path.replace(/^\//, ''))
      const offset = model.getOffsetAt(pos)
      const value = model.getValue()
      const prefix = value.slice(0, offset)
      const suffix = value.slice(offset)
      // don't auto-fire mid-word or on blank cursor contexts
      const lastLine = prefix.split('\n').at(-1) ?? ''
      if (!manual && lastLine.trim().length < 2) { clearGhost(); return }
      const seq = ++completionSeq
      completersRef.current.seq = seq
      completersRef.current.abort?.abort()
      const abort = new AbortController()
      completersRef.current.abort = abort
      const r = await window.meencode.cursor.completeCode({ prefix, suffix, language: model.getLanguageId(), path })
      if (abort.signal.aborted || seq !== completionSeq) return
      if (!r.completion) return
      showGhost(r.completion, pos, 'cloud')
    }

    function showGhost(text: string, pos: monaco.Position, tier: 'local' | 'cloud') {
      const editor2 = editorRef.current
      if (!editor2) return
      // cloud always wins; local never replaces an existing cloud ghost
      if (ghostRef.current.tier === 'cloud' && tier === 'local') return
      clearGhost()
      const first = text.split('\n')[0]
      const decorations: monaco.editor.IModelDeltaDecoration[] = [{
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        options: {
          after: { content: first, inlineClassName: tier === 'cloud' ? 'ghost-text cloud' : 'ghost-text local' },
          isWholeLine: false,
          className: 'ghost-line'
        }
      }]
      const ids = (editor2 as any).createDecorationsCollection
        ? (editor2 as any).createDecorationsCollection(decorations).ids ?? []
        : []
      ghostRef.current = { ids: ids as string[], text, tier }
    }

    function clearGhost() {
      const editor2 = editorRef.current
      if (ghostRef.current.ids.length > 0) {
        editor2?.deltaDecorations?.(ghostRef.current.ids, [])
        ;(editor2 as any)?.removeDecorations?.(ghostRef.current.ids)
        ghostRef.current = { ids: [], text: '', tier: null }
      }
    }

    function acceptGhost() {
      const editor2 = editorRef.current
      const model = editor2?.getModel()
      const g = ghostRef.current
      if (!editor2 || !model || !g.text) return
      const pos = editor2.getPosition()
      if (!pos) return
      const sel = editor2.getSelection()
      model.pushEditOperations([], [{
        range: sel && !sel.isEmpty() ? sel : new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: g.text
      }], () => null)
      clearGhost()
      const last = g.text.split('\n').length
      editor2.setPosition({ lineNumber: pos.lineNumber + Math.max(0, last - 1), column: 1 + (last === 1 ? g.text.length : 0) })
    }

    ;(editor as any).__clearGhost = clearGhost

    return () => {
      editor.dispose()
      setActiveEditor(null)
      ;(window as any).__meencodeActiveEditor = null
    }
  }, [markDirty, autocompleteEnabled])

  // ---- swap model when the active tab changes ----
  useEffect(() => {
    const editor = editorRef.current
    const tab = tabs.find((t) => t.path === activeTab)
    if (!editor || !tab) return
    const uri = monaco.Uri.parse(`meencode://file/${encodeURI(tab.path)}`)
    let model = monaco.editor.getModel(uri)
    if (!model) model = ensureModel(tab.path, tab.content)
    if (model.getValue() !== tab.content && !tab.dirty) model.setValue(tab.content)
    editor.setModel(model)
  }, [activeTab, tabs])

  // ---- reload open non-dirty tabs when their version bumps ----
  useEffect(() => {
    const editor = editorRef.current
    const tab = tabs.find((t) => t.path === activeTab)
    if (!editor || !tab || tab.dirty) return
    const model = editor.getModel()
    if (model && model.getValue() !== tab.content) model.setValue(tab.content)
  }, [activeTab, tabs])

  // ---- Cmd+K review: show proposed code as a green diff decoration ----
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    ;(editor as any).__reviewDecs?.clear?.()
    if (inlineEdit.status === 'review' && inlineEdit.proposed) {
      const sel = editor.getSelection()
      const decs = (editor as any).createDecorationsCollection
        ? (editor as any).createDecorationsCollection([
            {
              range: sel && !sel.isEmpty() ? sel : model.getFullModelRange(),
              options: { className: 'inline-review-range' }
            }
          ])
        : null
      ;(editor as any).__reviewDecs = decs
    }
  }, [inlineEdit.status, inlineEdit.proposed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveActiveTab()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveActiveTab])

  return <div className="editor-container" ref={containerRef} />
}

export function DiffView({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [, force] = useStateSafe()

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: 'meencode-dark',
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontSize: 12,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      originalEditable: false
    })
    editorRef.current = editor
    force((n: number) => n + 1)
    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', py: 'python', json: 'json', md: 'markdown' }
    const language = langMap[path.split('.').pop() ?? ''] ?? 'plaintext'
    const original = monaco.editor.createModel(before ?? '', language)
    const modified = monaco.editor.createModel(after ?? '', language)
    editor.setModel({ original, modified })
    return () => {
      original.dispose()
      modified.dispose()
    }
  }, [path, before, after])

  return <div className="diff-container" ref={containerRef} />
}

function useStateSafe(): [number, (fn: (n: number) => number) => void] {
  const [n, setN] = useState(0)
  return [n, setN]
}