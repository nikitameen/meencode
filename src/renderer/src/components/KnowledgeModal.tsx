import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

type Kind = 'rule' | 'instruction' | 'skill' | 'snippet'
type Entry = {
  id: number
  kind: Kind
  title: string
  content: string
  workspace: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'rule', label: 'Rule', hint: 'Always-follow conventions, injected into every prompt' },
  { id: 'instruction', label: 'Instruction', hint: 'Persistent agent directives (like AGENTS.md)' },
  { id: 'skill', label: 'Skill', hint: 'Reusable step-by-step procedure the agent can follow' },
  { id: 'snippet', label: 'Snippet', hint: 'Code pattern to reuse verbatim' }
]

const EMPTY_FORM = { kind: 'rule' as Kind, title: '', content: '', scope: 'workspace' as 'global' | 'workspace' }

export function KnowledgeModal() {
  const open = useStore((s) => s.knowledgeModalOpen)
  const set = useStore((s) => s.set)
  const [entries, setEntries] = useState<Entry[]>([])
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM)
  const [editing, setEditing] = useState<number | null>(null)
  const [filter, setFilter] = useState<Kind | 'all'>('all')
  const [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  const refresh = async () => {
    try {
      setEntries(await window.meencode.knowledge.list())
    } catch { /* DB not ready */ }
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  if (!open) return null

  const submit = async () => {
    if (!form.title.trim() || !form.content.trim()) return
    if (editing != null) {
      await window.meencode.knowledge.update(editing, { kind: form.kind, title: form.title, content: form.content, scope: form.scope })
    } else {
      await window.meencode.knowledge.add({ kind: form.kind, title: form.title, content: form.content, scope: form.scope, enabled: true })
    }
    setForm(EMPTY_FORM)
    setEditing(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 600)
    await refresh()
  }

  const startEdit = (e: Entry) => {
    setEditing(e.id)
    setForm({ kind: e.kind, title: e.title, content: e.content, scope: e.workspace ? 'workspace' : 'global' })
    setExpanded(e.id)
  }

  const toggle = async (e: Entry) => {
    await window.meencode.knowledge.update(e.id, { enabled: !e.enabled })
    await refresh()
  }

  const del = async (e: Entry) => {
    if (!confirm(`Delete "${e.title}"?`)) return
    await window.meencode.knowledge.del(e.id)
    if (editing === e.id) { setEditing(null); setForm(EMPTY_FORM) }
    await refresh()
  }

  const visible = filter === 'all' ? entries : entries.filter((e) => e.kind === filter)

  return (
    <div className="overlay" onClick={() => set('knowledgeModalOpen', false)}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span><Icon name="settings" size={14} /> Knowledge Base</span>
          <button className="icon-btn" onClick={() => set('knowledgeModalOpen', false)}>
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="modal-body knowledge-body">
          <div className="knowledge-list-pane">
            <div className="knowledge-filters">
              <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All ({entries.length})</button>
              {KINDS.map((k) => (
                <button key={k.id} className={`chip ${filter === k.id ? 'on' : ''}`} onClick={() => setFilter(k.id)}>
                  {k.label} ({entries.filter((e) => e.kind === k.id).length})
                </button>
              ))}
            </div>
            <div className="knowledge-list">
              {visible.length === 0 && <div className="history-empty">No entries yet. Rules files (.meencoderules, .cursorrules, AGENTS.md, CLAUDE.md) are imported automatically on first run.</div>}
              {visible.map((e) => (
                <div key={e.id} className={`knowledge-item ${editing === e.id ? 'editing' : ''} ${!e.enabled ? 'disabled' : ''}`}>
                  <div className="knowledge-item-row" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <span className={`knowledge-kind kind-${e.kind}`}>{e.kind}</span>
                    <span className="knowledge-item-title">{e.title}</span>
                    <span className="knowledge-scope">{e.workspace ? 'workspace' : 'global'}</span>
                    <label className="toggle mini" onClick={(ev) => ev.stopPropagation()}>
                      <input type="checkbox" checked={e.enabled} onChange={() => void toggle(e)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <button className="icon-btn" title="Edit" onClick={(ev) => { ev.stopPropagation(); startEdit(e) }}>
                      <Icon name="edit" size={11} />
                    </button>
                    <button className="icon-btn" title="Delete" onClick={(ev) => { ev.stopPropagation(); void del(e) }}>
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                  {expanded === e.id && <pre className="knowledge-content">{e.content}</pre>}
                </div>
              ))}
            </div>
          </div>
          <div className="knowledge-form">
            <div className="field">
              <label>{editing != null ? 'Edit entry' : 'New entry'}</label>
              <div className="knowledge-kind-row">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    className={`chip ${form.kind === k.id ? 'on' : ''}`}
                    title={k.hint}
                    onClick={() => setForm({ ...form, kind: k.id })}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <div className="field-hint">{KINDS.find((k) => k.id === form.kind)?.hint}</div>
            </div>
            <div className="field">
              <label>Title</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Always use pnpm, never npm" />
            </div>
            <div className="field">
              <label>Content</label>
              <textarea
                className="knowledge-textarea"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="The full rule / instruction / skill / snippet text…"
                rows={8}
              />
            </div>
            <div className="field">
              <label>Scope</label>
              <div className="knowledge-kind-row">
                <button className={`chip ${form.scope === 'workspace' ? 'on' : ''}`} onClick={() => setForm({ ...form, scope: 'workspace' })}>This workspace</button>
                <button className={`chip ${form.scope === 'global' ? 'on' : ''}`} onClick={() => setForm({ ...form, scope: 'global' })}>Global (all workspaces)</button>
              </div>
            </div>
            <div className="knowledge-form-actions">
              {editing != null && (
                <button className="btn" onClick={() => { setEditing(null); setForm(EMPTY_FORM) }}>Cancel</button>
              )}
              <button className={`btn primary ${saved ? 'saved' : ''}`} onClick={() => void submit()} disabled={!form.title.trim() || !form.content.trim()}>
                {saved ? <><Icon name="check" size={12} /> Saved</> : editing != null ? 'Save changes' : 'Add entry'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}