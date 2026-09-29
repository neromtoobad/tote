import { AudioLines, ClipboardList, RotateCcw, ScanSearch, X } from 'lucide-react'
import { extractDigits } from '../sim/parse'
import { metrics, type Snapshot } from '../sim/shift'
import { code } from '../sim/warehouse'

export type Analysis = {
  status: string
  error?: string
  model?: string
  duration?: number
  talk?: { picker: number; agent: number }
  wpm?: { picker: number; agent: number }
  sentiment?: { at: number; sentiment: string; text: string }[]
  highlights?: string[]
  utterances?: { who: 'picker' | 'agent'; at: number; text: string }[]
}

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

// Every check read the live agent acted on, re-found in the independent
// post-shift transcript of the picker's channel.
function secondPass(s: Snapshot, a: Analysis) {
  const reads = s.log
    .filter((e) => e.kind === 'verify' || e.kind === 'mismatch')
    .map((e) => ({ kind: e.kind, loc: e.loc ?? '', digits: (e.detail.match(/check (\d\d)|"(\d\d)"/) ?? []).slice(1).find(Boolean) ?? '' }))
    .filter((r) => r.digits)
  const said = (a.utterances ?? []).filter((u) => u.who === 'picker').map((u) => extractDigits(u.text, s.lang, 8))
  return reads.map((r) => ({ ...r, heard: said.some((d) => d.includes(r.digits)) }))
}

function Analytics({ s, a }: { s: Snapshot; a: Analysis | null }) {
  if (!a) return null
  if (a.status !== 'completed')
    return (
      <div className="rep-card analytics">
        <div className="rep-t">
          <ScanSearch size={15} /> Voice analytics <small>Universal-3 Pro · pre-recorded, multichannel</small>
        </div>
        <div className="notes hint">{a.error ? `Analysis failed: ${a.error}` : 'Re-transcribing the stereo recording, one channel per speaker…'}</div>
      </div>
    )
  const talk = a.talk ?? { picker: 0, agent: 0 }
  const total = talk.picker + talk.agent || 1
  const reads = secondPass(s, a)
  const ok = reads.filter((r) => r.heard).length
  const dur = (a.duration ?? 1) * 1000
  const sent = a.sentiment ?? []
  const count = (k: string) => sent.filter((x) => x.sentiment === k).length
  return (
    <div className="rep-card analytics">
      <div className="rep-t">
        <ScanSearch size={15} /> Voice analytics <small>AssemblyAI {a.model ?? 'Universal-3 Pro'} · pre-recorded, multichannel</small>
      </div>
      <div className="an-grid">
        <div className="an-box">
          <span className="an-k">Second-pass verification</span>
          <b className={ok === reads.length ? 'good' : 'warnc'}>
            {ok}/{reads.length}
          </b>
          <span className="an-s">check reads re-heard in the picker's channel of the recording</span>
          <div className="an-reads">
            {reads.map((r, i) => (
              <span key={i} className={`an-read ${r.heard ? 'y' : 'n'} ${r.kind}`} title={r.kind === 'mismatch' ? 'rejected read' : 'verified read'}>
                {r.loc} · {r.digits}
              </span>
            ))}
          </div>
        </div>
        <div className="an-box">
          <span className="an-k">Who talked</span>
          <div className="talkbar">
            <span style={{ width: `${(talk.picker / total) * 100}%` }} className="p" />
            <span style={{ width: `${(talk.agent / total) * 100}%` }} className="a" />
          </div>
          <span className="an-s">
            Sam {Math.round(talk.picker)} s · Tote {Math.round(talk.agent)} s · Sam at {a.wpm?.picker ?? 0} wpm
          </span>
          <span className="an-k" style={{ marginTop: 8 }}>
            Sam's tone across the shift
          </span>
          <div className="sentline">
            {sent.map((x, i) => (
              <i key={i} className={x.sentiment.toLowerCase()} style={{ left: `${Math.min(99, (x.at / dur) * 100)}%` }} title={`${x.sentiment}: ${x.text}`} />
            ))}
          </div>
          <span className="an-s">
            {count('POSITIVE')} positive · {count('NEUTRAL')} neutral · {count('NEGATIVE')} negative
          </span>
        </div>
      </div>
      {a.highlights && a.highlights.length > 0 && (
        <div className="an-hl">
          <span className="an-k">Key phrases</span>
          {a.highlights.map((h) => (
            <span key={h} className="pill mute">
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function Report({
  s,
  data,
  error,
  analysis,
  onClose,
  onRestart,
}: {
  s: Snapshot
  data: ReportData | null
  error: string | null
  analysis: Analysis | null
  onClose: () => void
  onRestart: () => void
}) {
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
          <img src="/icon-180.png" alt="" />
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
        <Analytics s={s} a={analysis} />
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
