import { metrics, type Snapshot } from '../sim/shift'
import { code } from '../sim/warehouse'

export type ReportData = {
  notes: string
  model: string
  session: { id: string; status: string; duration?: number } | null
  recording: string | null
  timeline: unknown
}

// Just enough markdown for the gateway's notes: **bold** lines and "- " bullets.
function Notes({ md }: { md: string }) {
  const blocks: React.ReactNode[] = []
  let bullets: string[] = []
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>)
    bullets = []
  }
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^[-*•] /.test(line)) bullets.push(line.slice(2))
    else {
      flush()
      blocks.push(<p key={blocks.length}>{inline(line)}</p>)
    }
  }
  flush()
  return <div className="notes">{blocks}</div>
}

function inline(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part))
}

const STATUS = { picked: 'ok', short: 'warn', damaged: 'bad', skipped: 'mute', pending: 'mute', active: 'brand' } as const

export function Report({ s, data, error, onClose, onRestart }: { s: Snapshot; data: ReportData | null; error: string | null; onClose: () => void; onRestart: () => void }) {
  const m = metrics(s)
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Shift report · tote T-1042</h2>
        <p className="sub">
          {m.done}/{m.total} lines · {m.units} units · {m.lph || '—'} lines/h · {m.accuracy}% first-time right · {m.caught} wrong-slot attempts caught
        </p>
        <div className="grid2">
          <div>
            <div className="card-h" style={{ padding: '0 0 6px' }}>
              Supervisor notes <small>· LLM Gateway ({data?.model ?? '…'})</small>
            </div>
            {data ? <Notes md={data.notes} /> : error ? <p className="err">{error}</p> : <div className="notes hint">Pulling the session recording and writing notes…</div>}
          </div>
          <div>
            <div className="card-h" style={{ padding: '0 0 6px' }}>
              Recording <small>· AssemblyAI session {data?.session?.id?.slice(0, 13) ?? ''}</small>
            </div>
            {data?.recording ? (
              <audio controls src={data.recording} style={{ width: '100%' }} />
            ) : (
              <div className="notes hint">{data ? 'Recording not available yet.' : 'Waiting for session artifacts…'}</div>
            )}
            <p className="hint">
              Every pick is backed by the headset audio and the conversation timeline, so a disputed order can be traced to the exact words spoken at the
              slot.
            </p>
          </div>
        </div>
        <table className="audit">
          <thead>
            <tr>
              <th>#</th>
              <th>Slot</th>
              <th>Item</th>
              <th>Ordered</th>
              <th>Picked</th>
              <th>Status</th>
              <th>Order</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l, i) => (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td className="mono">{code(l.loc)}</td>
                <td>{l.item.name}</td>
                <td>{l.qty}</td>
                <td>{l.picked}</td>
                <td>
                  <span className={`pill ${STATUS[l.status]}`}>{l.status}</span>
                  {l.mismatches > 0 && <span className="pill brand" style={{ marginLeft: 4 }}>{l.mismatches} caught</span>}
                </td>
                <td className="mono">{l.order}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={onRestart}>
            New shift
          </button>
        </div>
      </div>
    </div>
  )
}
