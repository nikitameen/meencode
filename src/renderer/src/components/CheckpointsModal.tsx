import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Icon } from './ui'

type Checkpoint = { run: string; files: string[]; ts: number }

export function CheckpointsModal() {
  const open = useStore((s) => s.checkpointsModalOpen)
  const set = useStore((s) => s.set)
  const reloadFile = useStore((s) => s.reloadFile)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  const refresh = async () => {
    const list = await window.meencode.cursor.listCheckpoints()
    setCheckpoints(list)
  }

  if (!open) return null

  const restore = async (run: string, file: string) => {
    setBusy(`${run}/${file}`)
    try {
      await window.meencode.cursor.restoreCheckpoint(run, file)
      await reloadFile(file)
    } catch (e: any) {
      alert(e?.message ?? 'Restore failed')
    } finally {
      setBusy(null)
    }
  }

  const restoreRun = async (cp: Checkpoint) => {
    for (const f of cp.files) await restore(cp.run, f)
  }

  return (
    <div className="overlay" onClick={() => set('checkpointsModalOpen', false)}>
      <div className="modal checkpoints" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span><Icon name="revert" size={14} /> Checkpoints — automatic backups taken before every agent edit</span>
          <button className="icon-btn" onClick={() => set('checkpointsModalOpen', false)}>
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="modal-body">
          {checkpoints.length === 0 && (
            <div className="review-empty">No checkpoints yet — they are created automatically when the agent edits files.</div>
          )}
          {checkpoints.map((cp) => (
            <div key={cp.run} className="cp-run">
              <div className="cp-run-header">
                <span className="cp-run-id">run {cp.run}</span>
                <span className="cp-run-ts">{new Date(cp.ts).toLocaleString()}</span>
                <button className="btn" onClick={() => void restoreRun(cp)}>
                  <Icon name="revert" size={11} /> Restore all {cp.files.length}
                </button>
              </div>
              {cp.files.map((f) => (
                <div key={f} className="cp-file">
                  <span className={`change-kind kind-${f.includes('deleted') ? 'deleted' : 'modified'}`}>saved</span>
                  <span className="cp-file-path" title={f}>{f}</span>
                  <button
                    className="btn small"
                    disabled={busy === `${cp.run}/${f}`}
                    onClick={() => void restore(cp.run, f)}
                  >
                    {busy === `${cp.run}/${f}` ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}