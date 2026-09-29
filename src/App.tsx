import { advanceTo, epoch, isVirtual, later, now as clockNow, onFrame } from './clock'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LANGS, Shift, metrics, type LangKey, type Tuning } from './sim/shift'
import { batcher, fromBase64, openAudio, toBase64, type AudioIO } from './voice/audio'
import { VoiceAgent, type AgentStatus, type WireEvent } from './voice/agent'
import { FloorMap } from './ui/FloorMap'
import { Activity, Desk, Headset, Kpis, PickList, SamStage, SlotCard, Wire, type Caption } from './ui/panels'
import { AudioLines, Globe, Hash, Mic, PackageCheck, Square, Zap } from 'lucide-react'
import { Report, type ReportData } from './ui/Report'

const PHASES = ['briefing', 'travel', 'pick', 'complete'] as const

type Tape = {
  tuning?: Tuning
  lang: LangKey
  events: { t: number; msg?: Record<string, unknown>; sam?: string; len?: number }[]
  report?: ReportData
  tail?: number
}
let replayStarted = false
// ?replay=<tape>&full=1 renders the full page layout instead of the video crop.
const FULL = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('full')
const PHASE_LABEL: Record<string, string> = { briefing: 'Briefing', travel: 'Go to slot', pick: 'Pick', complete: 'Done' }

function summarize(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result)
  const r = result as Record<string, unknown>
  if (typeof r.say === 'string') return r.say
  if (r.error) return `error: ${r.error}`
  return JSON.stringify(r).slice(0, 80)
}

export default function App() {
  const [lang, setLang] = useState<LangKey>('en')
  const [farField, setFarField] = useState(false)
  const [shift, setShift] = useState(() => new Shift('en'))
  const s = useSyncExternalStore(shift.subscribe, shift.getSnapshot)
  if (import.meta.env.DEV) (window as unknown as { __shift: Shift }).__shift = shift
  const [agentStatus, setStatus] = useState<AgentStatus>('idle')
  // The server finishes a reply before the speaker does; keep showing
  // "speaking" until the playback buffer has actually drained.
  const [speakerBusy, setSpeakerBusy] = useState(false)
  const status: AgentStatus = agentStatus === 'listening' && speakerBusy ? 'speaking' : agentStatus
  const [detail, setDetail] = useState<string>()
  const [captions, setCaptions] = useState<Caption[]>([])
  const [wire, setWire] = useState<WireEvent[]>([])
  const [report, setReport] = useState<{ open: boolean; data: ReportData | null; error: string | null }>({ open: false, data: null, error: null })
  // Replay only: what Sam is saying right now (the audio leads the transcript).
  const [samSays, setSamSays] = useState<{ text: string; at: number; ms: number } | null>(null)
  const agentRef = useRef<VoiceAgent | null>(null)
  const audioRef = useRef<AudioIO | null>(null)
  const orbRef = useRef<HTMLDivElement>(null)
  const speakerLevel = useRef(0)
  const statusRef = useRef<AgentStatus>('idle')
  statusRef.current = status
  const live = status === 'listening' || status === 'thinking' || status === 'speaking'
  const busy = status === 'connecting' || live

  useEffect(() => {
    if (s.phase === 'offline') shift.setLang(lang)
  }, [lang, shift, s.phase])
  useEffect(() => {
    if (s.phase === 'offline') shift.setFarField(farField)
  }, [farField, shift, s.phase])

  // Drive the headset orb's ring from mic or speaker level without re-rendering.
  useEffect(() => {
    const loop = () => {
      const st = statusRef.current
      const a = audioRef.current
      let lvl = 0
      if (a && st === 'speaking') lvl = Math.min(1, speakerLevel.current * 6)
      else if (a && (st === 'listening' || st === 'thinking')) lvl = Math.min(1, a.micLevel() * 9)
      orbRef.current?.style.setProperty('--lvl', lvl.toFixed(3))
    }
    return onFrame(loop)
  }, [])

  const upsert = useCallback((id: string, patch: Partial<Caption> & { who: Caption['who'] }, append = false) => {
    setCaptions((cs) => {
      const i = cs.findIndex((c) => c.id === id)
      if (i === -1) return [...cs, { id, text: '', ...patch }].slice(-80)
      const cur = cs[i]
      // A word revealed after the final transcript landed must not append to it.
      if (append && cur.partial === false) return cs
      const next = cs.slice()
      next[i] = { ...cur, ...patch, text: append ? `${cur.text}${patch.text ?? ''}` : (patch.text ?? cur.text) }
      return next
    })
  }, [])

  const teardown = useCallback(async () => {
    const a = audioRef.current
    audioRef.current = null
    await a?.close()
  }, [])

  const finish = useCallback(
    async (sh: Shift, sessionId: string | null, recorded?: ReportData) => {
      await teardown()
      sh.endSession()
      setReport({ open: true, data: recorded ?? null, error: null })
      if (recorded) return
      try {
        const snap = sh.getSnapshot()
        const res = await fetch('/api/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            log: {
              tote: 'T-1042',
              language: LANGS[snap.lang].label,
              lines: snap.lines.map((l) => ({ order: l.order, slot: `${l.loc.aisle}-${l.loc.bay}-${l.loc.level}`, item: l.item.name, qty: l.qty, picked: l.picked, status: l.status, check_digit_rejections: l.mismatches, rush: Boolean(l.rush) })),
              tasks: snap.tasks,
              events: snap.log,
              metrics: (() => {
                const m = metrics(snap)
                return { lph: m.lph, accuracy: m.accuracy, minutes: m.activeMs / 60000 }
              })(),
            },
          }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? res.statusText)
        setReport({ open: true, data: body, error: null })
      } catch (e) {
        setReport({ open: true, data: null, error: `Could not build the report: ${(e as Error).message}` })
      }
    },
    [teardown],
  )

  // Wire a shift to a fresh agent: the same path for a live mic and a replayed tape.
  const bind = useCallback(
    (sh: Shift, recorded?: ReportData) => {
      const agent = new VoiceAgent(sh.handleTool, fromBase64)
      agentRef.current = agent
      sh.port = {
        update: (c, d) => agent.update(c, d),
        say: (i, c) => agent.say(i, c),
        resolveHold: (id, n, o) => agent.resolveHold(id, n, o),
        end: () => agent.end(),
      }
      let ended = false
      agent.on('status', (st, d) => {
        setStatus(st)
        if (d) setDetail(d)
        if ((st === 'ended' || st === 'error') && !ended) {
          ended = true
          if (sh.getSnapshot().startedAt) void finish(sh, agent.sessionId, recorded)
          else
            void teardown().then(() => {
              // Never got going: back to the intro, keeping the error visible.
              sh.dispose()
              setShift(new Shift(sh.getSnapshot().lang))
            })
        }
      })
      agent.on('wire', (e) => setWire((w) => [...w, e].slice(-250)))
      agent.on('audio', (pcm) => audioRef.current?.play(pcm))
      agent.on('bargeIn', () => audioRef.current?.flush())
      agent.on('userSpeaking', (on) => {
        if (!on) audioRef.current?.tick()
      })
      agent.on('latency', (ms) => sh.latency(ms))
      agent.on('untooled', (text) => sh.guard(text))
      agent.on('userDelta', (id, text) => upsert(`u-${id}`, { who: 'user', text, partial: true }))
      agent.on('user', (id, text) => {
        sh.heard(text)
        upsert(`u-${id}`, { who: 'user', text, partial: false })
      })
      // Deltas arrive in a burst; reveal each word when it is actually spoken.
      agent.on('agentDelta', (id, word, at) =>
        later(() => upsert(`a-${id}`, { who: 'agent', text: /^[\s.,!?;:]/.test(word) ? word : ` ${word}`, partial: true }, true), Math.max(0, at - clockNow())),
      )
      agent.on('agent', (id, text, cut) => upsert(`a-${id}`, { who: 'agent', text, partial: false, cut }))
      agent.on('toolCall', (name, args, id) => upsert(`t-${id}`, { who: 'tool', text: `${name}(${Object.values(args).map((v) => JSON.stringify(v)).join(', ')})` }))
      agent.on('toolResult', (name, result, isErr) =>
        setCaptions((cs) => {
          const i = cs.findLastIndex((c) => c.who === 'tool' && c.text.startsWith(`${name}(`) && !c.text.includes(' → '))
          if (i === -1) return cs
          const next = cs.slice()
          next[i] = { ...next[i], text: `${next[i].text} → ${isErr ? '⚠ ' : ''}${summarize(result)}` }
          return next
        }),
      )
      return agent
    },
    [finish, teardown, upsert],
  )

  const start = useCallback(async () => {
    setCaptions([])
    setWire([])
    setDetail(undefined)
    setReport({ open: false, data: null, error: null })
    shift.dispose()
    const sh = new Shift(lang)
    sh.setFarField(farField)
    setShift(sh)
    setStatus('connecting')
    try {
      // Audio first, while the click still counts as a user gesture.
      const audio = await openAudio()
      audioRef.current = audio
      const res = await fetch('/api/token')
      const tok = await res.json()
      if (!res.ok) throw new Error(tok.error ?? 'could not get a session token')

      const agent = bind(sh)
      audio.onSpeaker(({ level, idle }) => {
        speakerLevel.current = level
        setSpeakerBusy(!idle)
      })
      audio.onChunk(batcher(1200, (pcm) => agent.sendAudio(toBase64(pcm))))
      agent.connect(tok.token, sh.initialConfig())
    } catch (e) {
      const msg = (e as Error).message
      setStatus('error')
      setDetail(/Permission|NotAllowed/i.test(msg) ? 'Microphone permission was blocked.' : msg)
      await teardown()
      sh.dispose()
      setShift(new Shift(lang))
    }
  }, [bind, farField, lang, shift, teardown])

  // Demo-video mode: re-run a recorded shift through the real agent client and
  // state machine on a virtual clock; the renderer calls renderFrame(n).
  useEffect(() => {
    if (!isVirtual || replayStarted) return
    replayStarted = true
    const q = new URLSearchParams(window.location.search)
    void (async () => {
      const tape = (await fetch(`/replay/${q.get('replay') || 'demo'}/tape.json`).then((r) => r.json())) as Tape
      const fps = Number(q.get('fps') ?? 30)
      const sh = new Shift(tape.lang)
      if (tape.tuning) sh.tuning = tape.tuning
      setShift(sh)
      const agent = bind(sh, tape.report)
      for (const ev of tape.events) {
        later(() => {
          if (ev.msg) agent.inject(ev.msg)
          else if (ev.sam) setSamSays({ text: ev.sam, at: clockNow(), ms: ((ev.len ?? 0) / 2 / 24_000) * 1000 })
        }, ev.t)
      }
      agent.attachReplay(sh.initialConfig())
      const t0 = epoch()
      const last = tape.events[tape.events.length - 1]?.t ?? 0
      const w = window as unknown as Record<string, unknown>
      w.FPS = fps
      w.TOTAL_FRAMES = Math.ceil(((last + (tape.tail ?? 9000)) / 1000) * fps)
      w.renderFrame = async (n: number) => {
        const t = (n * 1000) / fps
        advanceTo(t0 + t)
        await new Promise((r) => setTimeout(r, 0))
        await new Promise((r) => setTimeout(r, 0))
        // Frame callbacks read refs React just updated; run them once more.
        advanceTo(t0 + t)
        for (const a of document.getAnimations()) {
          a.pause()
          a.currentTime = t
        }
        document.querySelectorAll('svg').forEach((svg) => {
          svg.pauseAnimations()
          svg.setCurrentTime(t / 1000)
        })
      }
      w.READY = true
    })()
  }, [bind])

  const stop = () => agentRef.current?.end()

  const newShift = () => {
    shift.dispose()
    setReport({ open: false, data: null, error: null })
    setCaptions([])
    setWire([])
    setStatus('idle')
    setShift(new Shift(lang))
  }

  const phaseIdx = PHASES.indexOf(s.phase as (typeof PHASES)[number])
  const elapsed = s.startedAt ? Math.floor(((s.endedAt ?? clockNow()) - s.startedAt) / 1000) : 0

  return (
    <div className={`app${isVirtual && !FULL ? ' video' : ''}`}>
      <header className="top">
        <a className="brand" href="/" aria-label="Tote">
          <img src="/logo.svg" alt="" />
          <b>tote</b>
          <span className="brand-sub">Voice picking copilot</span>
        </a>
        <div className="whoami">
          <span className="avatar" aria-hidden />
          <div>
            <b>Sam</b>
            <span>Picker · zone A–F</span>
          </div>
          <span className="vsep" />
          <div>
            <b className="mono">T-1042</b>
            <span>
              {s.lines.length} lines · {s.lines.reduce((n, l) => n + l.qty, 0)} units
            </span>
          </div>
        </div>
        <div className="spacer" />
        <span className="built">
          <AudioLines size={15} /> Built on <b>AssemblyAI Voice Agent API</b>
        </span>
        <label className="field" title="Headset language">
          <Globe size={15} />
          <select value={lang} disabled={busy} onChange={(e) => setLang(e.target.value as LangKey)} aria-label="Picker language">
            {Object.entries(LANGS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.flag} {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="switch" title="Server-side voice isolation tuned for a noisy floor (voice_focus: far-field)">
          <input type="checkbox" checked={farField} disabled={busy} onChange={(e) => setFarField(e.target.checked)} />
          <span className="track">
            <span className="thumb" />
          </span>
          Noisy floor
        </label>
        {live ? (
          <>
            <span className="livepill">
              <span className="dot" /> LIVE {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
            <button className="btn dark" onClick={stop}>
              <Square size={13} fill="currentColor" /> End shift
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={start} disabled={status === 'connecting'}>
            <Mic size={16} /> {status === 'connecting' ? 'Connecting…' : 'Start shift'}
          </button>
        )}
      </header>

      <Kpis s={s} />

      <div className="main">
        <div className="left">
        <div className="card floor">
          <FloorMap s={s} agent={status} />
          <div className="floor-h">
            <div className="stepper">
              {PHASES.map((p, i) => (
                <span key={p} className={p === s.phase ? 'on' : phaseIdx > i ? 'done' : ''}>
                  {PHASE_LABEL[p]}
                </span>
              ))}
              {s.phase === 'paused' && <span className="on">Paused</span>}
            </div>
            {s.rushAt && s.rushAt > 0 ? (
              <span className="pill brand">
                <Zap size={13} /> RUSH-7781 · courier 14:30
              </span>
            ) : null}
          </div>
          <SamStage s={s} speaking={samSays && clockNow() - samSays.at < samSays.ms + 1200 ? samSays.text : undefined} />
          <SlotCard s={s} />
          {s.phase === 'offline' && !busy && <Intro onStart={start} error={status === 'error' ? detail : undefined} />}
          {s.phase === 'ended' && !report.open && (
            <div className="floor-end">
              <button className="btn" onClick={() => setReport((r) => ({ ...r, open: true }))}>
                Shift report
              </button>
              <button className="btn primary" onClick={newShift}>
                New shift
              </button>
            </div>
          )}
        </div>
        <PickList s={s} />
        </div>
        <div className="side">
          <Headset s={s} status={status} detail={detail} captions={captions} orbRef={orbRef} />
          <Desk
            s={s}
            live={live}
            onRush={() => shift.injectRush()}
            onBroadcast={(t) => {
              upsert(`d-${clockNow()}`, { who: 'sys', text: `Dana → Sam: “${t}”` })
              shift.broadcast(t)
            }}
            onAnswer={(t) => {
              upsert(`d-${clockNow()}`, { who: 'sys', text: `Dana: “${t}”` })
              shift.answerSupervisor(t)
            }}
          />
        </div>
      </div>

      <div className="bottom">
        <Activity s={s} />
        <Wire events={wire} />
      </div>

      {isVirtual && <VideoCaption captions={captions} sam={samSays} status={status} />}
      {isVirtual && <VideoChapter s={s} />}

      {report.open && <Report s={s} data={report.data} error={report.error} onClose={() => setReport((r) => ({ ...r, open: false }))} onRestart={newShift} />}
    </div>
  )
}

function Intro({ onStart, error }: { onStart: () => void; error?: string }) {
  return (
    <div className="intro">
      <div className="intro-card">
        <div className="intro-art">
          <img src="/sam/done.webp" alt="Sam, a warehouse picker, holding a tote" />
        </div>
        <div className="intro-body">
          <span className="kicker">Demo shift · tote T-1042</span>
          <h2>Put on the headset, Sam.</h2>
          <p className="sub">Tote talks you through the picks, hands-free. Just talk to it like a person.</p>
          <ol className="steps">
            <li>
              <span className="si">
                <Mic size={16} />
              </span>
              <span>
                Allow the microphone and say <b>“ready”</b>.
              </span>
            </li>
            <li>
              <span className="si">
                <Hash size={16} />
              </span>
              <span>
                At the shelf, read the <b>check digits</b> off the label card.
              </span>
            </li>
            <li>
              <span className="si">
                <PackageCheck size={16} />
              </span>
              <span>
                Say what you picked. If the bin is short or a box is crushed, <b>say so</b>.
              </span>
            </li>
          </ol>
          {error && <p className="err">{error}</p>}
          <div className="intro-cta">
            <button className="btn primary lg" onClick={onStart}>
              <Mic size={18} /> Start shift
            </button>
            <span className="hint">Chrome or Edge · headphones optional</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function VideoCaption({ captions, sam, status }: { captions: Caption[]; sam: { text: string; at: number; ms: number } | null; status: AgentStatus }) {
  const t = clockNow()
  if (sam && t - sam.at < sam.ms + 600) {
    return (
      <div className="vcap">
        <b className="u">Sam</b>
        <span>{sam.text}</span>
      </div>
    )
  }
  const agent = [...captions].reverse().find((c) => c.who === 'agent')
  if (agent && (status === 'speaking' || agent.partial)) {
    return (
      <div className="vcap">
        <b className="a">Tote</b>
        <span>{agent.text.trim()}</span>
      </div>
    )
  }
  return null
}

// Replay only: name what just happened and the API feature doing it.
const CHAPTERS: Record<string, [string, string]> = {
  start: ['Shift starts on "ready"', 'client tool · start_batch'],
  verify: ['Slot verified by check digits', 'digits read from the transcript, not the model'],
  mismatch: ['Wrong slot caught', 'check digits rejected before anything leaves the shelf'],
  short: ['Short pick → replenishment task', 'confirm_pick · count parsed from speech'],
  rush: ['Rush order: Tote re-routes Sam unprompted', 'reply.create + conversation.message'],
  damaged: ['Damaged stock → QA hold', 'report_damaged · progressive tool reveal'],
  pause: ['Break: Tote goes quiet', 'pause_shift · phase tools swap to resume_shift'],
  resume: ['Back to work', 'resume_shift'],
  complete: ['Tote complete', 'shift report from the session recording'],
  guard: ['Guardrail: the model answered without checking', 'the state machine ran the check and corrected it'],
}

function VideoChapter({ s }: { s: ReturnType<Shift['getSnapshot']> }) {
  const now = clockNow()
  const e = [...s.log].reverse().find((x) => x.kind in CHAPTERS)
  if (!e || !s.startedAt) return null
  const age = now - (s.startedAt + e.t)
  if (age > 5200) return null
  const [title, sub] = CHAPTERS[e.kind]
  return (
    <div className="vchap" key={`${e.kind}-${e.t}`}>
      <b>{title}</b>
      <span>{sub}</span>
    </div>
  )
}
