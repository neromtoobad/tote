import { every } from '../clock'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Ban,
  Check,
  CircleDashed,
  Flag,
  Gauge,
  Headphones,
  ListChecks,
  Lock,
  Megaphone,
  Package,
  PackageSearch,
  Radio,
  Send,
  ShieldAlert,
  ShieldCheck,
  Target,
  Timer,
  Truck,
  Zap,
} from 'lucide-react'
import { LANGS, metrics, toolCatalog, type Line, type Snapshot } from '../sim/shift'
import { bayX, checkDigits, code, rackY, spoken, FLOOR, STAGE_X } from '../sim/warehouse'
import { POSE_CAPTION, poseFor, useNow } from './pose'
import type { AgentStatus, WireEvent } from '../voice/agent'

export type Caption = { id: string; who: 'agent' | 'user' | 'tool' | 'sys'; text: string; partial?: boolean; cut?: boolean }

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- KPI strip ---------------------------------------------------------------
const SEG: Record<Line['status'], string> = { picked: 'var(--ok)', short: '#d98a00', damaged: 'var(--bad)', skipped: 'var(--faint)', active: 'var(--brand)', pending: 'var(--rack-2)' }

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="spark empty" />
  const v = values.slice(-16)
  const max = Math.max(...v, 2500)
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * 100},${28 - (x / max) * 24}`).join(' ')
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="var(--brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Kpis({ s }: { s: Snapshot }) {
  const [, tick] = useState(0)
  useEffect(() => {
    return every(() => tick((n) => n + 1), 1000)
  }, [])
  const m = metrics(s)
  const ordered = s.lines.reduce((n, l) => n + l.qty, 0)
  const tiles: { lbl: string; icon: ReactNode; tone: string; val: ReactNode; sub: ReactNode; extra?: ReactNode }[] = [
    {
      lbl: 'Lines',
      icon: <ListChecks size={16} />,
      tone: 'brand',
      val: (
        <>
          {m.done}
          <small>/ {m.total}</small>
        </>
      ),
      sub: s.startedAt ? `active ${fmt(m.activeMs)}` : 'tote T-1042',
      extra: (
        <div className="segbar">
          {s.lines.map((l) => (
            <span key={l.id} style={{ background: SEG[l.status] }} />
          ))}
        </div>
      ),
    },
    { lbl: 'Units picked', icon: <Package size={16} />, tone: 'info', val: m.units, sub: `of ${ordered} ordered` },
    { lbl: 'Pace', icon: <Gauge size={16} />, tone: 'info', val: <>{m.lph || '—'}<small>lines/h</small></>, sub: 'breaks excluded' },
    { lbl: 'First-time right', icon: <Target size={16} />, tone: 'ok', val: <>{m.accuracy}<small>%</small></>, sub: 'verified slot, full qty' },
    { lbl: 'Wrong slots caught', icon: <ShieldCheck size={16} />, tone: 'ok', val: m.caught, sub: 'before anything was picked' },
    {
      lbl: 'Voice latency',
      icon: <Timer size={16} />,
      tone: 'brand',
      val: m.p50 ? <>{(m.p50 / 1000).toFixed(2)}<small>s</small></> : '—',
      sub: 'speech end → voice, p50',
      extra: <Spark values={s.latencies} />,
    },
  ]
  return (
    <div className="kpis">
      {tiles.map((t) => (
        <div className="card kpi" key={t.lbl}>
          <span className="lbl">
            <span className={`ic ${t.tone}`}>{t.icon}</span>
            {t.lbl}
          </span>
          <span className="val">{t.val}</span>
          <span className="sub">{t.sub}</span>
          {t.extra}
        </div>
      ))}
    </div>
  )
}

// --- the tote's order lines ---------------------------------------------------------
const LINE_ICON: Record<Line['status'], ReactNode> = {
  picked: <Check size={14} strokeWidth={3} />,
  short: <AlertTriangle size={13} />,
  damaged: <ShieldAlert size={13} />,
  skipped: <Ban size={13} />,
  active: <Radio size={13} />,
  pending: <CircleDashed size={13} />,
}
const LINE_WORD: Record<Line['status'], string> = { picked: 'Picked', short: 'Short', damaged: 'QA hold', skipped: 'Skipped', active: 'Now', pending: 'Queued' }

export function PickList({ s }: { s: Snapshot }) {
  const ordered = s.lines.reduce((n, l) => n + l.qty, 0)
  const units = s.lines.reduce((n, l) => n + l.picked, 0)
  return (
    <div className="card picklist">
      <div className="card-h">
        <Package size={16} /> Tote <span className="mono">T-1042</span>
        <small>
          · {s.lines.length} lines · {units}/{ordered} units
        </small>
        <span className="legend">
          <i style={{ background: 'var(--brand)' }} /> now <i style={{ background: 'var(--ok)' }} /> picked <i style={{ background: '#d98a00' }} /> short{' '}
          <i style={{ background: 'var(--bad)' }} /> hold
        </span>
      </div>
      <div className="lines">
        {s.lines.map((l, i) => (
          <div key={l.id} className={`pline ${l.status}${i === s.active ? ' current' : ''}`}>
            <span className="st">{LINE_ICON[l.status]}</span>
            <div className="pl-main">
              <div className="pl-top">
                <span className="mono loc">{code(l.loc)}</span>
                {l.rush && (
                  <span className="rush">
                    <Zap size={11} /> rush
                  </span>
                )}
                <span className="pl-word">{LINE_WORD[l.status]}</span>
              </div>
              <span className="item">{l.item.name}</span>
            </div>
            <span className="mono qty">
              {l.status === 'pending' || l.status === 'active' ? `×${l.qty}` : `${l.picked}/${l.qty}`}
            </span>
          </div>
        ))}
      </div>
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
  const all = toolCatalog(true)
  const locked = all.filter((t) => !s.tools.includes(t))
  return (
    <div className="card headset">
      <div className="hs-top">
        <div className={`orb ${status}`} ref={orbRef}>
          <Headphones size={20} strokeWidth={2.2} />
        </div>
        <div className="hs-status">
          <b>{label[status]}</b>
          <span>{status === 'error' && detail ? detail : `Voice “${lang.voice}” · ${lang.flag} ${lang.label}${s.farField ? ' · far-field' : ''}`}</span>
        </div>
        <div className={`eq ${status}`} aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ animationDelay: `${i * 0.11}s` }} />
          ))}
        </div>
      </div>
      <div className="captions" ref={box}>
        {captions.length === 0 && (
          <div className="empty">
            <Headphones size={22} />
            <span>The headset conversation shows up here, live.</span>
          </div>
        )}
        {captions.map((c) =>
          c.who === 'tool' ? (
            <div key={c.id} className="msg tool">
              <span className="fn">ƒ</span>
              <code>{c.text}</code>
            </div>
          ) : c.who === 'sys' ? (
            <div key={c.id} className="msg sys">
              <Megaphone size={13} /> {c.text}
            </div>
          ) : (
            <div key={c.id} className={`msg ${c.who}${c.partial ? ' partial' : ''}${c.cut ? ' cut' : ''}`}>
              <span className="who">{c.who === 'agent' ? 'Tote' : 'Sam'}</span>
              <p>{c.text}</p>
            </div>
          ),
        )}
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
        <div className="tools-h">
          <span>
            Unlocked in <b>{s.phase}</b>
          </span>
          <span className="muted">
            <Lock size={11} /> {locked.length} locked until the next step
          </span>
        </div>
        <div className="tools-row">
          {s.tools.length === 0 && <span className="muted">none yet: the agent gets tools when the shift starts</span>}
          {s.tools.map((t) => (
            <span key={t} className={`tchip on${t === 'call_supervisor' ? ' hold' : ''}`}>
              {t}
            </span>
          ))}
          {locked.map((t) => (
            <span key={t} className="tchip locked" title="Not available in this step">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- shift lead desk ---------------------------------------------------------------
const TASK_ICON = { replen: <PackageSearch size={14} />, qa: <ShieldAlert size={14} />, audit: <Flag size={14} />, lead: <Flag size={14} /> } as const

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
        <span className="av">D</span> Shift lead desk <small>· Dana</small>
      </div>
      {s.supervisor && (
        <div className="page">
          <span>
            <b>Sam paged you:</b> {s.supervisor.reason}
          </span>
          <span className="hint">Tote is holding (execution_mode "hold") until you answer.</span>
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
          <Truck size={15} /> Drop rush order
        </button>
        <span className="hint" style={{ alignSelf: 'center' }}>
          {s.rushAt && s.rushAt > 0 ? 'RUSH-7781 is in the batch' : 'Tote re-routes Sam mid-walk'}
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
        <div className="send">
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Message Sam, spoken in ${LANGS[s.lang].label}`} disabled={!live} />
          <button className="icon-btn" disabled={!live || !msg.trim()} aria-label="Send">
            <Send size={15} />
          </button>
        </div>
      </form>
      <ul className="tasks">
        {s.tasks.length === 0 && <li className="none">No tasks yet. Shorts, damage and skips land here as they happen.</li>}
        {s.tasks.map((t) => (
          <li key={t.id}>
            <span className={`tk ${tagClass[t.kind]}`}>{TASK_ICON[t.kind]}</span>
            <span>
              <b className="mono">{t.id}</b> {t.text}
            </span>
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
export function SamStage({ s, speaking }: { s: Snapshot; speaking?: string }) {
  const now = useNow(400)
  const pose = poseFor(s, false, now)
  const line = s.lines[s.active]
  const idx = s.active + 1
  const recent = speaking ?? s.lastHeard
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
