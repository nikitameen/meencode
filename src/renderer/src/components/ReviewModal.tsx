import { useState } from 'react'
import { useStore } from '../store'
import { DiffView } from './Editor'
import { Icon } from './ui'

export function ReviewModal() {
  const open = useStore((s) => s.reviewModalOpen)
  const set = useStore((s) => s.set)
  const changes = useStore((s) => s.changes)
  const revertChange = useStore((s) => s.revertChange)
  const keepChange = useStore((s) => s.keepChange)
  const [selected, setSelected] = useState<string | null>(null)

  if (!open) return null

  const active = changes.filter((c) => c.status !== 'reverted')
  const current = active.find((c) => c.change.path === selected) ?? active[0]
  const pendingCount = active.filter((c) => c.status === 'pending').length

  return (
    <div className="overlay" onClick={() => set('reviewModalOpen', false)}>
      <div className="modal review" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span><Icon name="review" size={14} /> Review changes — {active.length} file{active.length === 1 ? '' : 's'} ({pendingCount} unreviewed)</span>
          <div className="modal-header-actions">
            <button className="btn" onClick={() => { for (const c of active) keepChange(c.change.path) }}>
              <Icon name="check" size={11} /> Keep all
            </button>
            <button className="btn danger" onClick={() => void useStore.getState().revertAll()}>
              <Icon name="revert" size={11} /> Revert all
            </button>
            <button className="icon-btn" onClick={() => set('reviewModalOpen', false)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        </div>
        <div className="review-body">
          <div className="review-list">
            {active.length === 0 && <div className="review-empty">No pending changes from the agent.</div>}
            {active.map((c) => (
              <div
                key={c.change.path}
                className={`review-item ${current?.change.path === c.change.path ? 'sel' : ''} ${c.status}`}
                onClick={() => setSelected(c.change.path)}
              >
                <span className={`change-kind kind-${c.change.kind}`}>{c.change.kind}</span>
                <span className="review-path" title={c.change.path}>{c.change.path}</span>
                {c.status === 'kept' && <span className="kept-badge">kept</span>}
              </div>
            ))}
          </div>
          <div className="review-diff">
            {current ? (
              <>
                <div className="review-diff-header">
                  <span className="review-diff-path">{current.change.path}</span>
                  <span className="review-diff-actions">
                    <button className="btn" onClick={() => keepChange(current.change.path)}>
                      <Icon name="check" size={11} /> Keep
                    </button>
                    <button className="btn danger" onClick={() => void revertChange(current.change.path)}>
                      <Icon name="revert" size={11} /> Revert file
                    </button>
                  </span>
                </div>
                <DiffView path={current.change.path} before={current.change.before} after={current.change.after} />
              </>
            ) : (
              <div className="review-empty big">Select a file to see its diff</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}