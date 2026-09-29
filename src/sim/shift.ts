import { later as clockLater, now as clockNow } from '../clock.ts'
// The shift state machine. Each phase owns a narrow system prompt and a small
// tool list, pushed to the agent with session.update on every transition
// ("progressive tool reveal"): the agent cannot confirm a pick before the
// location is verified, because confirm_pick does not exist until then.

import type { SessionConfig, ToolDef, ToolOutcome } from '../voice/agent.ts'
import {
  AISLES,
  checkDigits,
  code,
  demoBatch,
  demoSlots,
  ITEMS,
  PACK,
  pathLength,
  route,
  rushLines,
  spoken,
  standAt,
  type OrderLine,
  type Pt,
  type Slot,
} from './warehouse.ts'

export type Phase = 'offline' | 'briefing' | 'travel' | 'pick' | 'paused' | 'complete' | 'ended'
export type LineStatus = 'pending' | 'active' | 'picked' | 'short' | 'damaged' | 'skipped'

export type Line = OrderLine & {
  status: LineStatus
  picked: number
  mismatches: number
  verifiedAt?: number
  doneAt?: number
  note?: string
}

export type Task = { id: string; kind: 'replen' | 'qa' | 'audit' | 'lead'; loc: string; text: string; at: number }
export type LogEntry = { t: number; kind: string; loc?: string; item?: string; detail: string; heard?: string }
export type Walk = { path: Pt[]; start: number; ms: number }
export type SupervisorCall = { callId: string; reason: string; at: number }

export type LangKey = 'en' | 'es' | 'de' | 'fr' | 'it' | 'pt'
export const LANGS: Record<LangKey, { label: string; flag: string; voice: string; codes: string[]; line: string; greeting: (n: number) => string }> = {
  en: {
    label: 'English',
    flag: '🇺🇸',
    voice: 'alba',
    codes: ['en'],
    line: 'Speak English.',
    greeting: (n) => `Morning, Sam. Tote ten forty-two, ${n} picks. Say ready when you are.`,
  },
  es: {
    label: 'Español',
    flag: '🇪🇸',
    voice: 'lola',
    codes: ['es', 'en'],
    line: 'Speak only Spanish, even though tool results are in English. Say aisle letters in Spanish ("pasillo B").',
    greeting: (n) => `Buenos días, Sam. Tote diez cuarenta y dos, ${n} líneas. Di listo para empezar.`,
  },
  de: {
    label: 'Deutsch',
    flag: '🇩🇪',
    voice: 'juergen',
    codes: ['de', 'en'],
    line: 'Speak only German, even though tool results are in English.',
    greeting: (n) => `Guten Morgen, Sam. Tote zehn zweiundvierzig, ${n} Positionen. Sag bereit, wenn du startklar bist.`,
  },
  fr: {
    label: 'Français',
    flag: '🇫🇷',
    voice: 'estelle',
    codes: ['fr', 'en'],
    line: 'Speak only French, even though tool results are in English.',
    greeting: (n) => `Bonjour Sam. Bac dix quarante-deux, ${n} lignes. Dis prêt quand tu veux.`,
  },
  it: {
    label: 'Italiano',
    flag: '🇮🇹',
    voice: 'giovanni',
    codes: ['it', 'en'],
    line: 'Speak only Italian, even though tool results are in English.',
    greeting: (n) => `Buongiorno Sam. Contenitore dieci quarantadue, ${n} righe. Di pronto quando vuoi.`,
  },
  pt: {
    label: 'Português',
    flag: '🇵🇹',
    voice: 'rafael',
    codes: ['pt', 'en'],
    line: 'Speak only Portuguese, even though tool results are in English.',
    greeting: (n) => `Bom dia, Sam. Caixa dez quarenta e dois, ${n} linhas. Diz pronto quando quiseres.`,
  },
}

export const TOTE = 'T-1042'
const WALK_PX_PER_S = 320

// --- tools --------------------------------------------------------------------
const T = {
  start_batch: {
    type: 'function',
    name: 'start_batch',
    description: 'Start picking the tote. Call when the picker says ready, yes, go, start, or similar. Do not call for any other reason.',
    parameters: { type: 'object', properties: {} },
  },
  confirm_location: {
    type: 'function',
    name: 'confirm_location',
    description:
      'Verify the picker is at the right slot. Call as soon as they say the two check digits printed on the slot label. Never call with digits you guessed.',
    parameters: {
      type: 'object',
      properties: {
        check_digits: {
          type: 'string',
          description: 'The two check digits exactly as the picker read them, digits only.',
          pattern: ' *[0-9] *[0-9] *',
          examples: ['47', '09', '8 3'],
        },
      },
      required: ['check_digits'],
    },
  },
  skip_location: {
    type: 'function',
    name: 'skip_location',
    description: 'Skip the current slot. Call when the picker says it is blocked, they cannot find it, or it is unsafe to reach.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['blocked', 'cannot_find', 'unsafe', 'other'], description: 'Why the slot is being skipped.' } },
      required: ['reason'],
    },
  },
  confirm_pick: {
    type: 'function',
    name: 'confirm_pick',
    description:
      'Record how many units the picker put in the tote. Call when they say a number, or "done" / "got them" (which means the full quantity asked). If they picked fewer because the shelf ran out, pass the number they actually picked.',
    parameters: {
      type: 'object',
      properties: {
        quantity: { type: 'integer', minimum: 0, maximum: 60, description: 'Units placed in the tote.', examples: [1, 3, 12] },
      },
      required: ['quantity'],
    },
  },
  report_exception: {
    type: 'function',
    name: 'report_exception',
    description:
      'Report a problem at the current slot: product damaged, wrong product in the bin, bin empty, or not enough stock when they have not said how many they took.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['damaged', 'wrong_item', 'empty_bin', 'short'], description: 'What is wrong at the slot.' },
        units_available: {
          type: 'integer',
          minimum: 0,
          description: 'Good units they could pick, only if they said it. Omit when unknown.',
          examples: [0, 2],
        },
      },
      required: ['kind'],
    },
  },
  shift_status: {
    type: 'function',
    name: 'shift_status',
    description: "Get progress, pace and accuracy. Call when they ask how they're doing, what's left, their rate, or how many picks remain.",
    parameters: { type: 'object', properties: {} },
  },
  pause_shift: {
    type: 'function',
    name: 'pause_shift',
    description: 'Pause picking. Call when they want a break, the restroom, or report an equipment problem.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['break', 'restroom', 'equipment', 'other'], description: 'Why they are pausing.' } },
      required: ['reason'],
    },
  },
  resume_shift: {
    type: 'function',
    name: 'resume_shift',
    description: "Resume after a pause. Call when they say they're back, ready, or want to continue.",
    parameters: { type: 'object', properties: {} },
  },
  call_supervisor: {
    type: 'function',
    name: 'call_supervisor',
    description:
      'Page the shift lead. Call when the picker asks for a person or supervisor, feels unsafe, is injured, or is stuck after two failed attempts.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'One short phrase: what they need help with.', examples: ['forklift blocking aisle C', 'ladder needed'] } },
      required: ['reason'],
    },
    execution_mode: 'hold',
    timeout_seconds: 120,
  },
  end_shift: {
    type: 'function',
    name: 'end_shift',
    description: "End the session. Call only when the tote is complete and they say goodbye, they're done, or to end the shift.",
    parameters: { type: 'object', properties: {} },
  },
} satisfies Record<string, ToolDef>

const PHASE_TOOLS: Record<Phase, (keyof typeof T)[]> = {
  offline: [],
  briefing: ['start_batch', 'shift_status', 'call_supervisor'],
  travel: ['confirm_location', 'skip_location', 'shift_status', 'pause_shift', 'call_supervisor'],
  pick: ['confirm_pick', 'report_exception', 'shift_status', 'pause_shift', 'call_supervisor'],
  paused: ['resume_shift', 'shift_status', 'call_supervisor'],
  complete: ['end_shift', 'shift_status'],
  ended: [],
}

// --- agent port (set per session) ---------------------------------------------
export type AgentPort = {
  update: (s: SessionConfig, detail?: string) => void
  say: (instructions: string, context?: string) => void
  resolveHold: (callId: string, name: string, outcome: ToolOutcome) => void
  end: () => void
}

export type Snapshot = Readonly<{
  phase: Phase
  lang: LangKey
  farField: boolean
  lines: Line[]
  active: number
  walk: Walk
  arrivedAt: number | null
  startedAt: number | null
  pausedAt: number | null
  pausedMs: number
  pauseReason: string | null
  tasks: Task[]
  log: LogEntry[]
  supervisor: SupervisorCall | null
  rushAt: number | null
  latencies: number[]
  lastHeard: string
  tools: string[]
  slots: Map<string, Slot>
  endedAt: number | null
}>

let seq = 100

export class Shift {
  private s: {
    -readonly [K in keyof Snapshot]: Snapshot[K]
  }
  private snap: Snapshot
  private subs = new Set<() => void>()
  private timers: (() => void)[] = []
  port: AgentPort | null = null

  constructor(lang: LangKey = 'en') {
    const lines = demoBatch().map((l) => ({ ...l, status: 'pending' as LineStatus, picked: 0, mismatches: 0 }))
    const home = { x: PACK.x + 40, y: PACK.y }
    this.s = {
      phase: 'offline',
      lang,
      farField: false,
      lines,
      active: -1,
      walk: { path: [home, home], start: 0, ms: 0 },
      arrivedAt: null,
      startedAt: null,
      pausedAt: null,
      pausedMs: 0,
      pauseReason: null,
      tasks: [],
      log: [],
      supervisor: null,
      rushAt: null,
      latencies: [],
      lastHeard: '',
      tools: [],
      slots: demoSlots(),
      endedAt: null,
    }
    this.snap = { ...this.s }
  }

  // --- external store ---------------------------------------------------------
  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
  getSnapshot = () => this.snap
  private changed() {
    this.s.tools = PHASE_TOOLS[this.s.phase]
    this.snap = { ...this.s, lines: this.s.lines.map((l) => ({ ...l })) }
    this.subs.forEach((f) => f())
  }

  dispose() {
    this.timers.forEach((cancel) => cancel())
    this.timers = []
  }

  setLang(lang: LangKey) {
    if (this.s.phase !== 'offline') return
    this.s.lang = lang
    this.changed()
  }
  setFarField(on: boolean) {
    if (this.s.phase !== 'offline') return
    this.s.farField = on
    this.changed()
  }

  heard(text: string) {
    this.s.lastHeard = text
    this.changed()
  }
  latency(ms: number) {
    this.s.latencies = [...this.s.latencies, ms].slice(-50)
    this.changed()
  }

  private get activeLine(): Line | undefined {
    return this.s.lines[this.s.active]
  }
  private now() {
    return clockNow()
  }
  private rel() {
    return this.s.startedAt ? this.now() - this.s.startedAt : 0
  }
  private log(kind: string, detail: string, line?: Line) {
    this.s.log = [
      ...this.s.log,
      { t: this.rel(), kind, detail, loc: line && code(line.loc), item: line?.item.name, heard: this.s.lastHeard || undefined },
    ]
  }
  private task(kind: Task['kind'], line: Line, text: string) {
    const prefix = { replen: 'RPL', qa: 'QA', audit: 'AUD', lead: 'LEAD' }[kind]
    const t: Task = { id: `${prefix}-${++seq}`, kind, loc: code(line.loc), text, at: this.now() }
    this.s.tasks = [t, ...this.s.tasks]
    return t
  }

  // --- session config ---------------------------------------------------------
  initialConfig(): SessionConfig {
    const lang = LANGS[this.s.lang]
    const keyterms = [
      'tote',
      'check digits',
      'aisle',
      'bay',
      'level',
      'short',
      'damaged',
      'empty bin',
      'wrong item',
      'skip',
      'supervisor',
      'ready',
      ...Object.values(ITEMS).map((i) => i.name),
    ]
    this.s.phase = 'briefing'
    this.changed()
    return {
      ...this.phaseConfig(),
      greeting: lang.greeting(this.s.lines.length),
      input: {
        keyterms,
        language_codes: lang.codes,
        transcription_prompt:
          'Warehouse voice picking on a headset. Expect two-digit check numbers, quantities, aisle letters A to F, and words like ready, done, short, damaged, empty, skip, break.',
        voice_focus: this.s.farField ? 'far-field' : 'near-field',
        turn_detection: { interrupt_response: true },
      },
      output: { voice: lang.voice },
    }
  }

  private phaseConfig(): SessionConfig {
    return { system_prompt: this.prompt(), tools: PHASE_TOOLS[this.s.phase].map((k) => T[k] as ToolDef) }
  }

  private summaryLine() {
    const done = this.s.lines.filter((l) => l.status !== 'pending' && l.status !== 'active')
    const shorts = done.filter((l) => l.status === 'short').length
    const dmg = done.filter((l) => l.status === 'damaged').length
    const skip = done.filter((l) => l.status === 'skipped').length
    const units = done.reduce((n, l) => n + l.picked, 0)
    const parts = [`${done.length} lines`, `${units} units`]
    if (shorts) parts.push(`${shorts} short`)
    if (dmg) parts.push(`${dmg} damaged`)
    if (skip) parts.push(`${skip} skipped`)
    return parts.join(', ')
  }

  prompt() {
    const lang = LANGS[this.s.lang]
    const n = this.s.lines.length
    const line = this.activeLine
    const idx = this.s.active + 1
    let state = ''
    switch (this.s.phase) {
      case 'briefing':
        state = `BRIEFING. Tote ${TOTE} has ${n} lines across aisles ${AISLES.join(', ')}. Nothing started yet.
- They say ready, yes, go, or let's start → call start_batch, then say its "say" field.
Example: Picker: "Ready." You: [start_batch] "Aisle A, bay 3, level 2. Check digits when you're there."`
        break
      case 'travel':
        state = `TRAVEL. Line ${idx} of ${n}${line?.rush ? ' (RUSH order)' : ''}. Destination: ${line && spoken(line.loc)}. They are walking there now.
They prove they are at the slot by reading the two check digits on its label.
- Two digits heard ("four seven", "47", "zero nine") → call confirm_location with them.
- Blocked, can't find it, or unsafe → call skip_location.
- Asked where to go → repeat the destination.
Do not mention the item or quantity yet; that comes after the location is confirmed.
Example: Picker: "Four seven." You: [confirm_location "47"] "Pick 2, espresso beans."`
        break
      case 'pick':
        state = `PICK at ${line && spoken(line.loc)}, location confirmed. Put exactly ${line?.qty} × ${line?.item.name} in the tote.
- They say a number, or "done" / "got them" / "picked" (meaning ${line?.qty}) → call confirm_pick.
- Fewer on the shelf ("only three", "there's just one") → call confirm_pick with the number they actually picked.
- Damaged product, wrong product in the bin, or empty bin → call report_exception.
Example: Picker: "Only three here." You: [confirm_pick 3] "Short one logged. Aisle C, bay 2, level 3."`
        break
      case 'paused':
        state = `PAUSED for ${this.s.pauseReason}. Stay quiet unless spoken to.
- They say they're back, ready, or want to continue → call resume_shift, then say its "say" field.`
        break
      case 'complete':
        state = `COMPLETE. Tote ${TOTE} is finished: ${this.summaryLine()}. It goes to pack station 3.
- They say goodbye, done, or end the shift → call end_shift.`
        break
      default:
        state = 'OFFLINE.'
    }
    return `# Role
You are Tote, the voice in a warehouse picker's headset. The picker, Sam, is walking the floor with both hands busy, picking customer orders into tote ${TOTE}. You direct every pick and log what happens by calling tools.

# Voice style
- One short sentence per reply, twelve words or fewer. Instruction first.
- No filler ("great", "sure", "okay so"), no exclamation marks, no markdown, no lists.
- Say locations like "Aisle B, bay 7, level 1". Say quantities as plain numbers.
- After a tool result, say its "say" field, translated if needed, and nothing more.
- ${lang.line}

# Truth rules
- Never state a location, check digit, quantity, item, count or rate unless it appears in this prompt or a tool result.
- Never reveal or hint at a check digit.
- When in doubt, call a tool. A wasted call is fine; a wrong pick is not.

# Anytime
- "How am I doing", "what's left", "what's my rate" → shift_status.
- Break, restroom, equipment problem → pause_shift.
- Wants a person, feels unsafe, injured, or stuck → call_supervisor.

# Current state
${state}`
  }

  // --- movement ---------------------------------------------------------------
  private here(): Pt {
    const w = this.s.walk
    const t = Math.min(1, w.ms ? (this.now() - w.start) / w.ms : 1)
    const len = pathLength(w.path)
    let left = len * t
    for (let i = 1; i < w.path.length; i++) {
      const a = w.path[i - 1]
      const b = w.path[i]
      const seg = Math.hypot(b.x - a.x, b.y - a.y)
      if (left <= seg) {
        const f = seg ? left / seg : 1
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      }
      left -= seg
    }
    return w.path[w.path.length - 1]
  }

  private walkTo(to: Pt) {
    const path = route(this.here(), to)
    const ms = Math.max(600, (pathLength(path) / WALK_PX_PER_S) * 1000)
    this.s.walk = { path, start: this.now(), ms }
    this.s.arrivedAt = null
    const line = this.activeLine
    this.later(ms, () => {
      if (this.activeLine !== line) return
      this.s.arrivedAt = this.now()
      this.changed()
      this.nudgeIfQuiet(line)
    })
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(clockLater(fn, ms))
  }

  // One gentle prompt if a picker stands at the slot saying nothing.
  private nudgeIfQuiet(line: Line | undefined) {
    if (!line) return
    const heardBefore = this.s.lastHeard
    this.later(14_000, () => {
      if (this.s.phase !== 'travel' || this.activeLine !== line || this.s.lastHeard !== heardBefore) return
      this.port?.say('In one short sentence, ask them to read the two check digits on the slot label.')
    })
  }

  // --- transitions -------------------------------------------------------------
  private to(phase: Phase) {
    this.s.phase = phase
  }

  private startLine(i: number) {
    this.s.active = i
    const line = this.s.lines[i]
    line.status = 'active'
    this.to('travel')
    this.walkTo(standAt(line.loc))
    this.maybeScheduleRush()
  }

  /** Close the active line and move on. Returns what the agent should say next. */
  private advance(prefix: string): { say: string; next?: string } {
    const line = this.activeLine
    if (line) line.doneAt = this.now()
    const next = this.s.lines.findIndex((l) => l.status === 'pending')
    if (next === -1) {
      this.to('complete')
      this.s.active = -1
      this.walkTo({ x: PACK.x + 40, y: PACK.y })
      this.log('complete', `Tote ${TOTE} complete: ${this.summaryLine()}`)
      return { say: `${prefix} Tote complete: ${this.summaryLine()}. Take it to pack station 3.`.trim() }
    }
    this.startLine(next)
    const nl = this.s.lines[next]
    return { say: `${prefix} ${spoken(nl.loc)}.`.trim(), next: code(nl.loc) }
  }

  private outcome(result: Record<string, unknown>, isError = false): ToolOutcome {
    this.changed()
    return { result, isError, update: this.phaseConfig() }
  }

  // --- rush order ----------------------------------------------------------------
  private maybeScheduleRush() {
    if (this.s.rushAt !== null) return
    const doneCount = this.s.lines.filter((l) => ['picked', 'short', 'damaged', 'skipped'].includes(l.status)).length
    if (doneCount < 2) return
    const line = this.activeLine
    this.s.rushAt = -1 // scheduled
    // Lands mid-walk: say() holds it until the agent finishes giving the
    // next location, then the agent re-routes the picker unprompted.
    this.later(2500, () => {
      if (this.s.phase !== 'travel' || this.activeLine !== line) {
        this.s.rushAt = null // try again on the next line
        this.changed()
        return
      }
      this.injectRush()
    })
  }

  /** A same-day order lands mid-walk; the agent re-routes the picker unprompted. */
  injectRush() {
    if (this.s.rushAt !== null && this.s.rushAt > 0) return
    if (this.s.phase !== 'travel' && this.s.phase !== 'pick') return
    const rush = rushLines().map((l) => ({ ...l, status: 'pending' as LineStatus, picked: 0, mismatches: 0 }))
    this.s.rushAt = this.now()
    const cur = this.activeLine!
    if (this.s.phase === 'travel') {
      // Not verified yet: the current line goes back in the queue behind the rush.
      cur.status = 'pending'
      const at = this.s.active
      this.s.lines.splice(at, 0, ...rush)
      this.startLine(at)
      const first = this.s.lines[at]
      this.log('rush', `Rush order ${first.order} inserted (${rush.length} lines, courier 14:30); re-routed to ${code(first.loc)}`)
      this.changed()
      this.port?.update(this.phaseConfig(), 'state → rush re-route')
      this.port?.say(
        `Interrupt briefly: rush order for the 2:30 courier. Change route: ${spoken(first.loc)}. One sentence.`,
        `Dispatch: rush order ${first.order} inserted ahead of the batch. The picker's destination changed to ${spoken(first.loc)}.`,
      )
    } else {
      this.s.lines.splice(this.s.active + 1, 0, ...rush)
      this.log('rush', `Rush order ${rush[0].order} queued next (${rush.length} lines, courier 14:30)`)
      this.changed()
      this.port?.update(this.phaseConfig(), 'state → rush queued')
      this.port?.say(
        'In one sentence, tell them a rush order was added and comes right after this pick.',
        `Dispatch: rush order ${rush[0].order} inserted right after the current pick.`,
      )
    }
  }

  /** Supervisor desk: relay a typed message through the picker's headset, in their language. */
  broadcast(text: string) {
    if (!this.port || this.s.phase === 'offline' || this.s.phase === 'ended') return
    this.log('broadcast', `Supervisor: "${text}"`)
    this.changed()
    this.port.say(
      `Relay this message from the shift lead to the picker, in their language, briefly: "${text}"`,
      `Message from the shift lead: ${text}`,
    )
  }

  answerSupervisor(message: string) {
    const call = this.s.supervisor
    if (!call || !this.port) return
    this.s.supervisor = null
    this.log('supervisor', `Shift lead replied: "${message}"`)
    this.changed()
    this.port.resolveHold(call.callId, 'call_supervisor', {
      result: { supervisor: 'Dana, shift lead', message, say: `Dana says: ${message}` },
      update: this.phaseConfig(),
    })
  }

  endSession() {
    this.to('ended')
    this.s.endedAt = this.now()
    this.dispose()
    this.changed()
  }

  // --- tool handlers ---------------------------------------------------------------
  handleTool = (name: string, args: Record<string, unknown>, callId: string): ToolOutcome => {
    const line = this.activeLine
    switch (name) {
      case 'start_batch': {
        if (this.s.phase !== 'briefing') return this.outcome({ say: 'Already picking.' })
        this.s.startedAt = this.now()
        this.log('start', `Started tote ${TOTE}, ${this.s.lines.length} lines`)
        this.startLine(0)
        const first = this.activeLine!
        return this.outcome({ started: true, lines: this.s.lines.length, say: `${spoken(first.loc)}. Check digits when you're there.` })
      }

      case 'confirm_location': {
        if (!line || this.s.phase !== 'travel') return this.outcome({ error: 'No location to confirm right now.' }, true)
        const heard = String(args.check_digits ?? '').replace(/\D/g, '')
        if (heard === checkDigits(line.loc)) {
          line.verifiedAt = this.now()
          this.to('pick')
          this.log('verify', `Location ${code(line.loc)} verified (check ${heard})`, line)
          return this.outcome({ verified: true, location: code(line.loc), quantity: line.qty, item: line.item.name, say: `Pick ${line.qty}, ${line.item.name}.` })
        }
        line.mismatches++
        this.log('mismatch', `Check digits "${heard}" rejected at ${code(line.loc)} (wrong slot prevented)`, line)
        const again =
          line.mismatches >= 2
            ? `Still no match. Say skip to move on, or ask for your lead.`
            : `Those digits don't match. Check you're at ${spoken(line.loc)} and read again.`
        return this.outcome({ verified: false, heard, say: again })
      }

      case 'skip_location': {
        if (!line) return this.outcome({ error: 'Nothing to skip.' }, true)
        line.status = 'skipped'
        const reason = String(args.reason ?? 'other').replace('_', ' ')
        line.note = reason
        const t = this.task('lead', line, `Slot ${code(line.loc)} skipped: ${reason}`)
        this.log('skip', `Skipped ${code(line.loc)} (${reason}); ${t.id} raised`, line)
        return this.outcome({ skipped: true, task: t.id, ...this.advance('Skipped, lead notified.') })
      }

      case 'confirm_pick': {
        if (!line || this.s.phase !== 'pick') return this.outcome({ error: 'Confirm the location first.' }, true)
        const q = Math.max(0, Math.round(Number(args.quantity)))
        if (!Number.isFinite(q)) return this.outcome({ error: 'Quantity missing.', say: 'How many did you pick?' }, true)
        if (q > line.qty) {
          const extra = q - line.qty
          this.log('overpick', `Over-pick caught at ${code(line.loc)}: ${q} for ${line.qty}`, line)
          return this.outcome({ recorded: false, say: `That's ${extra} too many. Put ${extra} back, then say done.` })
        }
        line.picked = q
        this.takeStock(line, q)
        if (q === line.qty) {
          line.status = 'picked'
          this.log('pick', `Picked ${q} × ${line.item.name}`, line)
          return this.outcome({ recorded: q, ...this.advance('') })
        }
        line.status = 'short'
        const t = this.task('replen', line, `Replenish ${line.item.name} at ${code(line.loc)} (short ${line.qty - q})`)
        this.log('short', `Short pick: ${q} of ${line.qty} × ${line.item.name}; ${t.id} raised`, line)
        return this.outcome({ recorded: q, short_by: line.qty - q, replen_task: t.id, ...this.advance(`Short ${line.qty - q} logged, replen raised.`) })
      }

      case 'report_exception': {
        if (!line || this.s.phase !== 'pick') return this.outcome({ error: 'Confirm the location first.' }, true)
        const kind = String(args.kind)
        const avail = args.units_available === undefined ? undefined : Math.max(0, Math.round(Number(args.units_available)))
        if (kind === 'short') {
          if (avail === undefined) return this.outcome({ needs: 'units_available', say: 'How many did you pick?' })
          return this.handleTool('confirm_pick', { quantity: avail }, callId)
        }
        if (kind === 'damaged') {
          const good = Math.min(avail ?? 0, line.qty)
          line.status = 'damaged'
          line.picked = good
          this.takeStock(line, good, true)
          const t = this.task('qa', line, `QA hold: damaged ${line.item.name} at ${code(line.loc)}`)
          if (good < line.qty) this.task('replen', line, `Replenish ${line.item.name} at ${code(line.loc)} (damaged stock)`)
          this.log('damaged', `Damaged ${line.item.name}; ${good} good picked; ${t.id} QA hold`, line)
          return this.outcome({ logged: 'damaged', qa_hold: t.id, ...this.advance('Damage logged, QA hold placed. Leave it.') })
        }
        if (kind === 'wrong_item') {
          line.status = 'skipped'
          line.note = 'wrong item in bin'
          const t = this.task('audit', line, `Stock audit: wrong product in ${code(line.loc)}`)
          this.log('wrong_item', `Wrong product in ${code(line.loc)}; ${t.id} audit`, line)
          return this.outcome({ logged: 'wrong_item', audit: t.id, ...this.advance('Flagged for audit.') })
        }
        // empty_bin
        line.status = 'short'
        line.picked = 0
        const t = this.task('replen', line, `Replenish ${line.item.name} at ${code(line.loc)} (bin empty)`)
        this.log('empty', `Empty bin at ${code(line.loc)}; ${t.id} raised`, line)
        return this.outcome({ logged: 'empty_bin', replen_task: t.id, ...this.advance('Empty bin logged, replen raised.') })
      }

      case 'shift_status': {
        const m = metrics(this.snap)
        return this.outcome({
          done: m.done,
          total: m.total,
          remaining: m.total - m.done,
          units: m.units,
          lines_per_hour: m.lph,
          accuracy_pct: m.accuracy,
          say: `${m.done} of ${m.total} done, ${m.total - m.done} to go${m.lph ? `, pace ${m.lph} lines an hour` : ''}.`,
        })
      }

      case 'pause_shift': {
        const prev = this.s.phase
        this.s.pausedAt = this.now()
        this.s.pauseReason = String(args.reason ?? 'break')
        this.resumeTo = prev
        this.to('paused')
        this.log('pause', `Paused: ${this.s.pauseReason}`)
        return this.outcome({ paused: true, say: 'Paused. Say back when you are ready.' })
      }

      case 'resume_shift': {
        if (this.s.pausedAt) this.s.pausedMs += this.now() - this.s.pausedAt
        this.s.pausedAt = null
        this.s.pauseReason = null
        this.to(this.resumeTo ?? 'travel')
        this.log('resume', 'Resumed')
        const l = this.activeLine
        const say =
          this.s.phase === 'pick' && l
            ? `Welcome back. Pick ${l.qty}, ${l.item.name}.`
            : l
              ? `Welcome back. ${spoken(l.loc)}.`
              : 'Welcome back.'
        return this.outcome({ resumed: true, say })
      }

      case 'call_supervisor': {
        const reason = String(args.reason ?? 'help')
        this.s.supervisor = { callId, reason, at: this.now() }
        this.log('page', `Shift lead paged: ${reason}`)
        this.changed()
        // The agent goes quiet during a hold; one status line keeps the picker informed.
        this.later(5000, () => {
          if (this.s.supervisor?.callId === callId) this.port?.say('In one short sentence, tell them the shift lead has been paged.')
        })
        this.later(35_000, () => {
          if (this.s.supervisor?.callId === callId) this.answerSupervisor('On my way, two minutes. Carry on if you can.')
        })
        return { result: { __hold: true } }
      }

      case 'end_shift': {
        this.log('end', 'Shift ended by picker')
        this.later(3500, () => this.port?.end())
        return this.outcome({ ended: true, say: 'Shift closed. Nice work, Sam.' })
      }
    }
    return this.outcome({ error: `Unknown tool ${name}` }, true)
  }

  private resumeTo: Phase | null = null

  private takeStock(line: Line, units: number, damaged = false) {
    const slot = this.s.slots.get(code(line.loc))
    if (!slot) return
    const next = new Map(this.s.slots)
    next.set(code(line.loc), {
      ...slot,
      onHand: Math.max(0, slot.onHand - units - (damaged ? slot.damaged : 0)),
      damaged: damaged ? 0 : slot.damaged,
    })
    this.s.slots = next
  }
}

// --- metrics --------------------------------------------------------------------
export function metrics(s: Snapshot, now = clockNow()) {
  const total = s.lines.length
  const closed = s.lines.filter((l) => ['picked', 'short', 'damaged', 'skipped'].includes(l.status))
  const done = closed.length
  const units = closed.reduce((n, l) => n + l.picked, 0)
  const end = s.endedAt ?? (s.phase === 'complete' ? Math.max(...closed.map((l) => l.doneAt ?? 0)) : now)
  const activeMs = s.startedAt ? Math.max(1, end - s.startedAt - s.pausedMs - (s.pausedAt ? now - s.pausedAt : 0)) : 0
  const lph = activeMs && done ? Math.round((done / activeMs) * 3_600_000) : 0
  const clean = closed.filter((l) => l.status === 'picked' && l.mismatches === 0).length
  const accuracy = done ? Math.round((clean / done) * 100) : 100
  const caught = s.log.filter((e) => e.kind === 'mismatch' || e.kind === 'overpick').length
  const exceptions = closed.filter((l) => l.status !== 'picked').length
  const sorted = [...s.latencies].sort((a, b) => a - b)
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
  return { total, done, units, lph, accuracy, caught, exceptions, activeMs, p50 }
}
