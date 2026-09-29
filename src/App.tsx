import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LANGS, Shift, type LangKey } from './sim/shift'
import { batcher, fromBase64, openAudio, toBase64, type AudioIO } from './voice/audio'
import { VoiceAgent, type AgentStatus, type WireEvent } from './voice/agent'
import { FloorMap } from './ui/FloorMap'
import { Activity, Desk, Headset, Kpis, SlotCard, Wire, type Caption } from './ui/panels'
import { Report, type ReportData } from './ui/Report'

const PHASES = ['briefing', 'travel', 'pick', 'complete'] as const
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
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [detail, setDetail] = useState<string>()
  const [captions, setCaptions] = useState<Caption[]>([])
  const [wire, setWire] = useState<WireEvent[]>([])
  const [report, setReport] = useState<{ open: boolean; data: ReportData | null; error: string | null }>({ open: false, data: null, error: null })
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
    let raf = 0
    const loop = () => {
      const st = statusRef.current
      const a = audioRef.current
      let lvl = 0
      if (a && st === 'speaking') lvl = Math.min(1, speakerLevel.current * 6)
      else if (a && (st === 'listening' || st === 'thinking')) lvl = Math.min(1, a.micLevel() * 9)
      orbRef.current?.style.setProperty('--lvl', lvl.toFixed(3))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const upsert = useCallback((id: string, patch: Partial<Caption> & { who: Caption['who'] }, append = false) => {
    setCaptions((cs) => {
      const i = cs.findIndex((c) => c.id === id)
      if (i === -1) return [...cs, { id, text: '', ...patch }].slice(-80)
      const next = cs.slice()
      const cur = next[i]
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
    async (sh: Shift, sessionId: string | null) => {
      await teardown()
      sh.endSession()
      setReport({ open: true, data: null, error: null })
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
          if (sh.getSnapshot().startedAt) void finish(sh, agent.sessionId)
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
      agent.on('latency', (ms) => sh.latency(ms))
      agent.on('userDelta', (id, text) => upsert(`u-${id}`, { who: 'user', text, partial: true }))
      agent.on('user', (id, text) => {
        sh.heard(text)
        upsert(`u-${id}`, { who: 'user', text, partial: false })
      })
      agent.on('agentDelta', (id, word) => upsert(`a-${id}`, { who: 'agent', text: /^[\s.,!?;:]/.test(word) ? word : ` ${word}`, partial: true }, true))
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
      audio.onSpeaker(({ level }) => (speakerLevel.current = level))
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
  }, [farField, finish, lang, shift, teardown, upsert])

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
  const elapsed = s.startedAt ? Math.floor(((s.endedAt ?? Date.now()) - s.startedAt) / 1000) : 0

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div>
            <b>Tote</b>
            <span>Voice picking copilot</span>
          </div>
        </div>
        <span className="chip">
          <b>Sam</b> · picker · tote <span className="mono">T-1042</span>
        </span>
        <span className="chip">
          Powered by <b>AssemblyAI Voice Agent API</b>
        </span>
        <div className="spacer" />
        <select className="select" value={lang} disabled={busy} onChange={(e) => setLang(e.target.value as LangKey)} aria-label="Picker language">
          {Object.entries(LANGS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.flag} {v.label}
            </option>
          ))}
        </select>
        <label className="toggle" title="Server-side voice isolation tuned for a noisy floor (voice_focus: far-field)">
          <input type="checkbox" checked={farField} disabled={busy} onChange={(e) => setFarField(e.target.checked)} />
          Noisy floor
        </label>
        {live ? (
          <>
            <span className="pill ok live">
              <span className="dot" /> LIVE {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </span>
            <button className="btn dark" onClick={stop}>
              End shift
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={start} disabled={status === 'connecting'}>
            {status === 'connecting' ? 'Connecting…' : 'Start shift'}
          </button>
        )}
      </header>

      <Kpis s={s} />

      <div className="main">
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
            {s.rushAt && s.rushAt > 0 ? <span className="pill brand">⚡ RUSH-7781 · courier 14:30</span> : null}
          </div>
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
        <div className="side">
          <Headset s={s} status={status} detail={detail} captions={captions} orbRef={orbRef} />
          <Desk
            s={s}
            live={live}
            onRush={() => shift.injectRush()}
            onBroadcast={(t) => {
              upsert(`d-${Date.now()}`, { who: 'sys', text: `Dana → Sam: “${t}”` })
              shift.broadcast(t)
            }}
            onAnswer={(t) => {
              upsert(`d-${Date.now()}`, { who: 'sys', text: `Dana: “${t}”` })
              shift.answerSupervisor(t)
            }}
          />
        </div>
      </div>

      <div className="bottom">
        <Activity s={s} />
        <Wire events={wire} />
      </div>

      {report.open && <Report s={s} data={report.data} error={report.error} onClose={() => setReport((r) => ({ ...r, open: false }))} onRestart={newShift} />}
    </div>
  )
}

function Intro({ onStart, error }: { onStart: () => void; error?: string }) {
  return (
    <div className="overlay" style={{ position: 'absolute', background: 'rgba(245,245,241,0.72)' }}>
      <div className="modal" style={{ width: 'min(520px, 100%)' }}>
        <h2>Put on the headset, Sam.</h2>
        <p className="sub">You're a picker on tote T-1042. Tote talks you through six picks, hands-free.</p>
        <ol style={{ margin: '0 0 14px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>
            Allow the microphone and say <b>“ready”</b>.
          </li>
          <li>
            When you reach the slot, read the <b>check digits</b> off the label card.
          </li>
          <li>
            Say what you picked. Look at the bin: if it's short or damaged, say so, just like on a real floor.
          </li>
        </ol>
        <p className="hint" style={{ marginTop: 0 }}>
          Watch for a rush order mid-shift, page your lead, or switch the headset language before you start. Chrome or Edge recommended; headphones
          optional.
        </p>
        {error && <p className="err">{error}</p>}
        <button className="btn primary" onClick={onStart}>
          Start shift
        </button>
      </div>
    </div>
  )
}
