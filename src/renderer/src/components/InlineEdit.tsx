import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

export type InlineEditState = {
  active: boolean
  path: string | null
  selection: string
  instruction: string
  status: 'idle' | 'loading' | 'review' | 'error'
  original: string
  proposed: string
  error: string | null
}

export const EMPTY_INLINE: InlineEditState = {
  active: false,
  path: null,
  selection: '',
  instruction: '',
  status: 'idle',
  original: '',
  proposed: '',
  error: null
}

export function InlineEditBar() {
  const edit = useStore((s) => s.inlineEdit)
  const set = useStore((s) => s.set)
  const [instruction, setInstruction] = useState('')

  useEffect(() => {
    setInstruction(edit.instruction)
  }, [edit.instruction, edit.active])

  if (!edit.active || !edit.path) return null

  const run = async () => {
    const path = edit.path
    if (!instruction.trim() || edit.status === 'loading' || !path) return
    set('inlineEdit', { ...edit, instruction, status: 'loading', error: null })
    try {
      const r = await window.meencode.cursor.applyEdit({
        path,
        code: edit.selection,
        instruction,
        language: languageOf(path)
      })
      set('inlineEdit', { ...edit, instruction, status: 'review', proposed: r.code, error: null })
    } catch (e: any) {
      set('inlineEdit', { ...edit, status: 'error', error: String(e?.message ?? e) })
    }
  }

  return (
    <div className="inline-edit" onClick={(e) => e.stopPropagation()}>
      <div className="inline-edit-row">
        <span className="inline-edit-kbd" title="Cmd+K">⌘K</span>
        <input
          autoFocus
          className="inline-edit-input"
          placeholder="Edit instruction… e.g. add error handling, rename to fetchUser, use async/await"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void run() }
            if (e.key === 'Escape') { e.preventDefault(); set('inlineEdit', EMPTY_INLINE) }
          }}
          disabled={edit.status === 'loading' || edit.status === 'review'}
        />
        {edit.status === 'loading' ? (
          <span className="tool-spinner"><Icon name="spinner" size={13} /></span>
        ) : edit.status === 'review' ? (
          <>
            <button className="btn primary" onClick={() => void accept()}>
              <Icon name="check" size={12} /> Accept
            </button>
            <button className="btn danger" onClick={() => set('inlineEdit', EMPTY_INLINE)}>
              <Icon name="x" size={12} /> Reject
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={() => void run()} disabled={!instruction.trim()}>
              <Icon name="sparkle" size={12} /> Edit
            </button>
            <button className="icon-btn" title="Cancel (Esc)" onClick={() => set('inlineEdit', EMPTY_INLINE)}>
              <Icon name="x" size={12} />
            </button>
          </>
        )}
      </div>
      {edit.status === 'error' && <div className="inline-edit-error">{edit.error}</div>}
      {edit.status === 'review' && (
        <div className="inline-edit-hint">
          Review the diff below in the editor — Accept applies it, Reject keeps your code.
        </div>
      )}
    </div>
  )

  async function accept() {
    const s = useStore.getState()
    const path = edit.path
    if (!path || !edit.proposed) {
      s.set('inlineEdit', EMPTY_INLINE)
      return
    }
    const model = getModel(path)
    const editor = getActiveEditor()
    let updated = ''
    const selection = editor?.getSelection?.()
    if (model && selection && !selection.isEmpty()) {
      model.pushEditOperations([], [{ range: selection, text: edit.proposed }], () => null)
      updated = model.getValue()
    } else if (model) {
      updated = model.getValue().replace(edit.selection, edit.proposed)
    } else {
      const tab = s.tabs.find((t) => t.path === path)
      updated = (tab?.content ?? '').replace(edit.selection, edit.proposed)
    }
    await window.meencode.fs.write(path, updated)
    s.set('inlineEdit', EMPTY_INLINE)
    s.set('tabs', s.tabs.map((t) => (t.path === path ? { ...t, content: updated, dirty: false, version: t.version + 1 } : t)))
  }
}

function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', py: 'python', md: 'markdown', json: 'json' }
  return map[ext] ?? 'plaintext'
}

import { getModel, getActiveEditor } from '../store'