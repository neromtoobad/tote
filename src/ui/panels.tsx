import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LANGS, metrics, type Line, type Snapshot } from '../sim/shift'
import { bayX, checkDigits, code, rackY, spoken, FLOOR, STAGE_X } from '../sim/warehouse'
import { POSE_CAPTION, poseFor, useNow } from './pose'
import type { AgentStatus, WireEvent } from '../voice/agent'

export type Caption = { id: string; who: 'agent' | 'user' | 'tool' | 'sys'; text: string; partial?: boolean; cut?: boolean }

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- KPI strip ---------------------------------------------------------------
export function Kpis({ s }: { s: Snapshot }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const m = metrics(s)
  const tiles: { lbl: string; val: ReactNode; sub: string; pill?: ReactNode }[] = [
    { lbl: 'Lines', val: <>{m.done}<small>/ {m.total}</small></>, sub: s.startedAt ? `active ${fmt(m.activeMs)}` : 'tote T-1042' },
    { lbl: 'Units picked', val: m.units, sub: `${s.lines.reduce((n, l) => n + l.qty, 0)} ordered` },
    {
      lbl: 'Pace',
      val: <>{m.lph || '—'}<small>lines/h</small></>,
      sub: 'vs 72 on paper lists',
      pill: m.lph > 72 ? <span className="pill ok">+{Math.round((m.lph / 72 - 1) * 100)}%</span> : undefined,
    },
    { lbl: 'First-time right', val: <>{m.accuracy}<small>%</small></>, sub: 'verified slot, full qty' },
    {
      lbl: 'Wrong slots caught',
      val: m.caught,
      sub: 'check digits + over-picks',
      pill: m.caught ? <span className="pill brand">prevented</span> : undefined,
    },
    { lbl: 'Voice latency', val: <>{m.p50 ?? '—'}<small>{m.p50 ? 'ms' : ''}</small></>, sub: 'end of speech → first audio, p50' },
  ]
  return (
    <div className="kpis">
      {tiles.map((t) => (
        <div className="card kpi" key={t.lbl}>
          <span className="lbl">{t.lbl}</span>
          <span className="val">{t.val}</span>
          <span className="sub">{t.sub}</span>
          {t.pill}
        </div>
      ))}
    </div>
  )
}

// --- the label + bin card a picker sees at the shelf ----------------------------
export function SlotCard({ s }: { s: Snapshot }) {
  const line: Line | undefined = s.lines[s.active]
  if (!line || (s.phase !== 'travel' && s.phase !== 'pick' && s.phase !== 'paused')) return null
  const x = bayX(line.loc.bay)
  const y = rackY(line.loc.aisle)
  const left = x < FLOOR.w * 0.56 ? `calc(${(x / FLOOR.w) * 100}% + 28px)` : `calc(${(x / FLOOR.w) * 100}% - 288px)`
  const topPct = (y / FLOOR.h) * 100
  const top = y > 330 ? `calc(${topPct}% - 200px)` : `calc(${topPct}% + 6px)`
  const slot = s.slots.get(code(line.loc))
  const arrived = Boolean(s.arrivedAt) || s.phase !== 'travel'
  const verified = s.phase === 'pick' || (s.phase === 'paused' && Boolean(line.verifiedAt))
  const boxes = slot ? Math.min(18, slot.onHand) : 0
  return (
    <div className="slotcard" style={{ left, top }}>
      <div className="cap">
        <span>At the shelf</span>
        {verified ? (
          <span className="pill ok">verified</span>
        ) : arrived ? (
          <span className="pill brand">read the label</span>
        ) : (
          <span className="pill mute">walking…</span>
        )}
      </div>
      <div className="label" key={line.mismatches}>
        <div className="l">
          <span className="loc">{code(line.loc)}</span>
          <span className="bars" />
        </div>
        <div className="check">
          <small>CHECK</small>
          <b>{arrived ? checkDigits(line.loc) : '··'}</b>
        </div>
      </div>
      <div className="bin" title={slot ? `${slot.onHand} on hand` : ''}>
        {Array.from({ length: boxes }, (_, i) => {
          const dmg = slot && i < slot.damaged
          return <span key={i} className={`box${dmg ? ' dmg' : ''}`} style={{ background: `hsl(${line.item.hue} 50% 66%)` }} />
        })}
        {!boxes && <span className="hint">bin is empty</span>}
      </div>
      {verified && (
        <div className="picktask">
          <span>{line.item.name}</span>
          <span className="qty">×{line.qty}</span>
        </div>
      )}
      {!verified && line.mismatches > 0 && <span className="err">Check digits rejected {line.mismatches}×. Wrong slot prevented.</span>}
    </div>
  )
}

// --- headset --------------------------------------------------------------------
const TRY: Record<string, string[]> = {
  briefing: ['"Ready"'],
  travel: ['the two check digits', '"I can\'t find it"', '"How am I doing?"'],
  pick: ['"Got them"', '"Only three here"', '"This one\'s damaged"', '"I need a break"'],
  paused: ['"I\'m back"'],
  complete: ['"End shift"', '"What was my rate?"'],
}
const ALL_TOOLS = [
  'start_batch',
  'confirm_location',
  'skip_location',
  'confirm_pick',
  'report_exception',
  'shift_status',
  'pause_shift',
  'resume_shift',
  'call_supervisor',
  'end_shift',
]

export function Headset({
  s,
  status,
  detail,
  captions,
  orbRef,
}: {
  s: Snapshot
  status: AgentStatus
  detail?: string
  captions: Caption[]
  orbRef: React.RefObject<HTMLDivElement | null>
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [captions])
  const lang = LANGS[s.lang]
  const label: Record<AgentStatus, string> = {
    idle: 'Headset off',
    connecting: 'Connecting…',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Tote is speaking',
    ended: 'Session ended',
    error: 'Connection problem',
  }
  const tries = TRY[s.phase] ?? []
  return (
    <div className="card headset">
      <div className="hs-top">
        <div className={`orb ${status}`} ref={orbRef}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
            <rect x="2.5" y="13" width="4.5" height="7" rx="1.6" />
            <rect x="17" y="13" width="4.5" height="7" rx="1.6" />
            <path d="M19 20c0 1.5-2 2.3-5 2.3" />
          </svg>
        </div>
        <div className="hs-status">
          <b>{label[status]}</b>
          <span>
            {status === 'error' && detail ? detail : `Voice “${lang.voice}” · ${lang.flag} ${lang.label}${s.farField ? ' · far-field' : ''}`}
          </span>
        </div>
      </div>
      <div className="captions" ref={box}>
        {captions.length === 0 && <div className="empty">Live captions of the headset conversation appear here.</div>}
        {captions.map((c) => (
          <div key={c.id} className={`cap-line ${c.who}${c.partial ? ' partial' : ''}${c.cut ? ' cut' : ''}`}>
            <span className="who">{c.who === 'agent' ? 'Tote' : c.who === 'user' ? 'Sam' : c.who === 'tool' ? 'tool' : 'desk'}</span>
            <span>{c.text}</span>
          </div>
        ))}
      </div>
      {tries.length > 0 && status !== 'idle' && status !== 'ended' && (
        <div className="try">
          <span>Try saying</span>
          {tries.map((t) => (
            <span className="say" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="tools">
        <span>
          Tools the agent can call right now <b className="mono">({s.phase})</b>
        </span>
        {ALL_TOOLS.map((t) => (
          <span key={t} className={`tool${s.tools.includes(t) ? ' on' : ''}${t === 'call_supervisor' ? ' hold' : ''}`}>
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

// --- shift lead desk ---------------------------------------------------------------
export function Desk({
  s,
  live,
  onRush,
  onBroadcast,
  onAnswer,
}: {
  s: Snapshot
  live: boolean
  onRush: () => void
  onBroadcast: (text: string) => void
  onAnswer: (text: string) => void
}) {
  const [msg, setMsg] = useState('')
  const canRush = live && (s.phase === 'travel' || s.phase === 'pick') && !(s.rushAt && s.rushAt > 0)
  const tagClass = { replen: 'warn', qa: 'bad', audit: 'info', lead: 'mute' } as const
  return (
    <div className="card desk">
      <div className="card-h">
        Shift lead desk <small>· Dana</small>
      </div>
      {s.supervisor && (
        <div className="page">
          <span>
            <b>Sam paged you:</b> {s.supervisor.reason}
          </span>
          <span className="hint">The agent is on hold (execution_mode "hold") until you answer.</span>
          <div className="row">
            {['On my way, two minutes.', 'Skip that slot and carry on.', 'Take five, I will cover.'].map((a) => (
              <button key={a} className="btn sm dark" onClick={() => onAnswer(a)}>
                {a}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row">
        <button className="btn sm primary" disabled={!canRush} onClick={onRush}>
          ⚡ Drop rush order
        </button>
        <span className="hint" style={{ alignSelf: 'center' }}>
          {s.rushAt && s.rushAt > 0 ? 'Rush RUSH-7781 in the batch' : 'Tote re-routes Sam mid-walk'}
        </span>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!msg.trim()) return
          onBroadcast(msg.trim())
          setMsg('')
        }}
      >
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Message Sam (spoken in ${LANGS[s.lang].label})`} disabled={!live} />
        <button className="btn sm" disabled={!live || !msg.trim()}>
          Send
        </button>
      </form>
      <ul className="tasks">
        {s.tasks.length === 0 && <li className="none">No tasks yet. Shorts, damage and skips raise them here.</li>}
        {s.tasks.map((t) => (
          <li key={t.id}>
            <span className={`pill ${tagClass[t.kind]}`}>{t.id}</span>
            <span>{t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- activity + wire ------------------------------------------------------------------
const KIND_ICON: Record<string, string> = {
  start: '▶',
  verify: '✓',
  mismatch: '✗',
  pick: '●',
  short: '◐',
  damaged: '⚠',
  empty: '○',
  wrong_item: '?',
  skip: '↷',
  rush: '⚡',
  pause: '❚❚',
  resume: '▶',
  page: '☎',
  supervisor: '☎',
  broadcast: '✉',
  overpick: '✗',
  complete: '■',
  end: '■',
}

export function Activity({ s }: { s: Snapshot }) {
  return (
    <div className="card">
      <div className="card-h">
        Pick log <small>· the audit trail the shift report is built from</small>
      </div>
      <ul className="feed">
        {s.log.length === 0 && <li className="hint">Nothing yet.</li>}
        {[...s.log].reverse().map((e, i) => (
          <li key={i}>
            <span className="t">{fmt(e.t)}</span>
            <span style={{ width: 16, textAlign: 'center' }}>{KIND_ICON[e.kind] ?? '·'}</span>
            <span>{e.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Wire({ events }: { events: WireEvent[] }) {
  const t0 = events[0]?.at ?? 0
  return (
    <div className="card">
      <div className="card-h">
        Voice Agent API <small>· WebSocket frames (audio frames hidden)</small>
      </div>
      <ul className="feed wire">
        {events.length === 0 && <li className="hint">wss://agents.assemblyai.com/v1/ws</li>}
        {[...events].reverse().map((e, i) => (
          <li key={i}>
            <span className="t">{((e.at - t0) / 1000).toFixed(1)}s</span>
            <span className={e.dir}>{e.dir === 'up' ? '↑' : '↓'} {e.type}</span>
            {e.detail && <span className="d">{e.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function spokenLoc(line?: Line) {
  return line ? spoken(line.loc) : ''
}

// --- Sam, staged on the right of the floor card --------------------------------------
export function SamStage({ s }: { s: Snapshot }) {
  const now = useNow(400)
  const pose = poseFor(s, false, now)
  const line = s.lines[s.active]
  const idx = s.active + 1
  const recent = s.lastHeard
  return (
    <div className="stage" style={{ left: `${(STAGE_X / FLOOR.w) * 100}%`, width: `${((FLOOR.w - STAGE_X) / FLOOR.w) * 100}%` }}>
      <div className="stage-h">
        <b>Sam</b>
        <span>{POSE_CAPTION[pose]}</span>
      </div>
      {recent && s.phase !== 'offline' ? (
        <div className="bubble" key={recent}>
          “{recent}”
        </div>
      ) : (
        <div className="bubble muted">Hands full. Eyes on the shelf.</div>
      )}
      <img className={`sam pose-${pose}`} src={`/sam/${pose}.webp`} alt={`Sam, ${POSE_CAPTION[pose].toLowerCase()}`} key={pose} />
      <div className="stage-f mono">
        {line ? (
          <>
            <span>
              line {idx}/{s.lines.length}
            </span>
            <b>{code(line.loc)}</b>
          </>
        ) : (
          <span>{s.phase === 'complete' || s.phase === 'ended' ? 'tote complete' : 'tote T-1042'}</span>
        )}
      </div>
    </div>
  )
}
