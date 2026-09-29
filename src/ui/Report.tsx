import { AudioLines, ClipboardList, RotateCcw, X } from 'lucide-react'
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
const WORD = { picked: 'picked', short: 'short', damaged: 'QA hold', skipped: 'skipped', pending: 'not reached', active: 'in progress' } as const

export function Report({ s, data, error, onClose, onRestart }: { s: Snapshot; data: ReportData | null; error: string | null; onClose: () => void; onRestart: () => void }) {
  const m = metrics(s)
  const stats: [string, string][] = [
    ['Lines', `${m.done}/${m.total}`],
    ['Units', String(m.units)],
    ['Pace', m.lph ? `${m.lph}/h` : '—'],
    ['First-time right', `${m.accuracy}%`],
    ['Wrong slots caught', String(m.caught)],
  ]
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal report" onClick={(e) => e.stopPropagation()}>
        <div className="rep-h">
          <img src="/logo.svg" alt="" />
          <div>
            <h2>Shift report</h2>
            <span className="sub">
              Tote <span className="mono">T-1042</span> · Sam · {data?.session?.id ? <span className="mono">{data.session.id.slice(0, 13)}</span> : 'recording…'}
            </span>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="rep-stats">
          {stats.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <b>{v}</b>
            </div>
          ))}
        </div>
        <div className="grid2">
          <div className="rep-card">
            <div className="rep-t">
              <ClipboardList size={15} /> Supervisor notes
              <small>{!data ? '' : data.model === 'rules' ? 'built from the pick log' : `LLM Gateway · ${data.model}`}</small>
            </div>
            {data ? <Notes md={data.notes} /> : error ? <p className="err">{error}</p> : <div className="notes hint">Pulling the session recording and writing notes…</div>}
          </div>
          <div className="rep-card">
            <div className="rep-t">
              <AudioLines size={15} /> Headset recording <small>AssemblyAI Sessions API</small>
            </div>
            {data?.recording ? <audio controls src={data.recording} style={{ width: '100%' }} /> : <div className="notes hint">{data ? 'Recording not available yet.' : 'Waiting for session artifacts…'}</div>}
            <p className="hint" style={{ margin: '10px 2px 0' }}>
              Every pick is backed by the headset audio and the conversation timeline, so a disputed order can be traced to the exact words spoken at the slot.
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
                  <span className={`pill ${STATUS[l.status]}`}>{WORD[l.status]}</span>
                  {l.mismatches > 0 && (
                    <span className="pill brand" style={{ marginLeft: 4 }}>
                      {l.mismatches} wrong slot caught
                    </span>
                  )}
                </td>
                <td className="mono">
                  {l.order}
                  {l.rush ? ' ⚡' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={onRestart}>
            <RotateCcw size={15} /> New shift
          </button>
        </div>
      </div>
    </div>
  )
}
