import { later as clockLater, now as clockNow } from '../clock.ts'
import { extractCount, extractDigits, mentions } from './parse.ts'
// The shift state machine. Each phase owns a narrow system prompt and a small
// tool list, pushed to the agent with session.update on every transition
// ("progressive tool reveal"): the agent cannot confirm a pick before the
// location is verified, because confirm_pick does not exist until then.

import type { SessionConfig, ToolDef, ToolOutcome } from '../voice/agent.ts'
import {
  AISLES,
  type Aisle,
  type Loc,
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

export type Task = { id: string; kind: 'replen' | 'qa' | 'audit' | 'lead' | 'safety'; loc: string; text: string; at: number }
export type Hazard = { aisle: Aisle; kind: string; at: number }
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
    codes: ['es'],
    line: 'Speak only Spanish, even though tool results are in English. Say aisle letters in Spanish ("pasillo B").',
    greeting: (n) => `Buenos días, Sam. Tote diez cuarenta y dos, ${n} líneas. Di listo para empezar.`,
  },
  de: {
    label: 'Deutsch',
    flag: '🇩🇪',
    voice: 'juergen',
    codes: ['de'],
    line: 'Speak only German, even though tool results are in English.',
    greeting: (n) => `Guten Morgen, Sam. Tote zehn zweiundvierzig, ${n} Positionen. Sag bereit, wenn du startklar bist.`,
  },
  fr: {
    label: 'Français',
    flag: '🇫🇷',
    voice: 'estelle',
    codes: ['fr'],
    line: 'Speak only French, even though tool results are in English.',
    greeting: (n) => `Bonjour Sam. Bac dix quarante-deux, ${n} lignes. Dis prêt quand tu veux.`,
  },
  it: {
    label: 'Italiano',
    flag: '🇮🇹',
    voice: 'giovanni',
    codes: ['it'],
    line: 'Speak only Italian, even though tool results are in English.',
    greeting: (n) => `Buongiorno Sam. Contenitore dieci quarantadue, ${n} righe. Di pronto quando vuoi.`,
  },
  pt: {
    label: 'Português',
    flag: '🇵🇹',
    voice: 'rafael',
    codes: ['pt'],
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

// The argument-free tool set. Tools that carry values run ~3 s slower on the
// managed model, so here the model only chooses the intent and parse.ts reads
// the digits and counts from the transcript itself.
const EMPTY = { type: 'object', properties: {} }
const A = {
  read_check_digits: {
    type: 'function',
    name: 'read_check_digits',
    description:
      'Call as soon as the picker says the two check digits printed on the slot label ("four seven", "47", "zero nine"). The system reads the digits from their words; pass nothing.',
    parameters: EMPTY,
  },
  confirm_pick: {
    type: 'function',
    name: 'confirm_pick',
    description:
      'Call when the picker says what they picked: "done", "got them", "picked", a number, or fewer than asked ("only three here"). The system reads the count from their words; pass nothing.',
    parameters: EMPTY,
  },
  report_damaged: { type: 'function', name: 'report_damaged', description: 'Call when the product at the slot is damaged, crushed, broken or leaking.', parameters: EMPTY },
  report_wrong_item: { type: 'function', name: 'report_wrong_item', description: 'Call when the bin holds a different product than the one asked for.', parameters: EMPTY },
  report_empty_bin: { type: 'function', name: 'report_empty_bin', description: 'Call when the bin is completely empty.', parameters: EMPTY },
  skip_location: { type: 'function', name: 'skip_location', description: 'Call when the slot is blocked, cannot be found, or is unsafe to reach.', parameters: EMPTY },
  pause_shift: { type: 'function', name: 'pause_shift', description: 'Call when they want a break or the restroom, or report an equipment problem.', parameters: EMPTY },
  report_hazard: {
    type: 'function',
    name: 'report_hazard',
    description: 'Call when the picker reports a safety hazard: a spill, a leak, fallen stock, damaged racking, or an aisle blocked by a pallet or forklift.',
    parameters: EMPTY,
  },
  call_supervisor: {
    type: 'function',
    name: 'call_supervisor',
    description: 'Page the shift lead. Call when they ask for a person or supervisor, feel unsafe, are injured, or are stuck.',
    parameters: EMPTY,
    execution_mode: 'hold',
    timeout_seconds: 120,
  },
} satisfies Record<string, ToolDef>

const ARGLESS_TOOLS: Record<Phase, string[]> = {
  offline: [],
  briefing: ['start_batch', 'shift_status', 'call_supervisor'],
  travel: ['read_check_digits', 'skip_location', 'report_hazard', 'shift_status', 'pause_shift', 'call_supervisor'],
  pick: ['confirm_pick', 'report_damaged', 'report_wrong_item', 'report_empty_bin', 'report_hazard', 'shift_status', 'pause_shift', 'call_supervisor'],
  paused: ['resume_shift', 'shift_status', 'call_supervisor'],
  complete: ['end_shift', 'shift_status'],
  ended: [],
}

export function toolCatalog(argless: boolean) {
  return argless
    ? ['start_batch', 'read_check_digits', 'skip_location', 'confirm_pick', 'report_damaged', 'report_wrong_item', 'report_empty_bin', 'report_hazard', 'shift_status', 'pause_shift', 'resume_shift', 'call_supervisor', 'end_shift']
    : ['start_batch', 'confirm_location', 'skip_location', 'confirm_pick', 'report_exception', 'shift_status', 'pause_shift', 'resume_shift', 'call_supervisor', 'end_shift']
}

/** The same tool without value-shape hints (pattern, examples, bounds). */
function plain(t: ToolDef): ToolDef {
  const props = (t.parameters as { properties?: Record<string, Record<string, unknown>> }).properties ?? {}
  const stripped = Object.fromEntries(
    Object.entries(props).map(([k, v]) => {
      const { pattern: _p, examples: _e, minimum: _mi, maximum: _ma, ...rest } = v
      return [k, rest]
    }),
  )
  return { ...t, parameters: { ...t.parameters, properties: stripped } }
}

/** Words that mean "skip this slot" across the six headset languages. */
const SKIP_WORDS = ['skip', 'block', "can't find", 'cant find', 'cannot find', 'missing', 'unsafe', 'pallet', 'forklift', 'saltar', 'bloque', 'no encuentro', 'überspring', 'blockiert', 'finde', 'passer', 'bloqué', 'trouve pas', 'salta', 'bloccat', 'non trovo', 'pular', 'não encontro', 'nao encontro']

/** Words that mean "I picked it" across the six headset languages. */
const PICK_WORDS = ['got', 'done', 'picked', 'have them', 'all of them', 'only', 'just', 'grabbed', 'listo', 'tengo', 'ya está', 'solo', 'erledigt', 'hab', 'fertig', 'nur', 'fait', 'pris', 'bon', 'seulement', 'presi', 'fatto', 'solo', 'feito', 'tenho', 'só']

export type Tuning = {
  staticPrompt?: boolean
  mode?: 'min_latency' | 'balanced' | 'max_accuracy'
  plainParams?: boolean
  ack?: boolean
  argless?: boolean
  allTools?: boolean
  silence?: [number, number]
}

/** Measured on the live API (scripts/drive.ts): value-free tools plus a pinned
 *  end-of-turn window took speech-end → first audio from ~3.9 s to ~1.6 s. The
 *  adaptive window had stretched to ~3 s because pickers go quiet while walking. */
export const DEFAULT_TUNING: Tuning = { argless: true, silence: [250, 900] }

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
  hazard: Hazard | null
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
  /** Latency knobs: a static prompt keeps the model's prompt cache warm across
   *  phase changes (only the tool list moves); transcription_mode sets how fast
   *  a turn ends. */
  tuning: Tuning = { ...DEFAULT_TUNING }
  private heardSinceTool: string[] = []

  toolNames(): string[] {
    if (this.tuning.allTools) return toolCatalog(Boolean(this.tuning.argless))
    return this.tuning.argless ? ARGLESS_TOOLS[this.s.phase] : PHASE_TOOLS[this.s.phase]
  }

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
      hazard: null,
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
    this.s.tools = this.toolNames()
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
    this.heardSinceTool.push(text)
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
  private task(kind: Task['kind'], line: Line | { loc: Loc }, text: string) {
    const prefix = { replen: 'RPL', qa: 'QA', audit: 'AUD', lead: 'LEAD', safety: 'SAFE' }[kind]
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
      ...(this.tuning.staticPrompt ? { system_prompt: this.fit(this.staticPrompt()) } : {}),
      greeting: lang.greeting(this.s.lines.length),
      input: {
        keyterms,
        language_codes: lang.codes,
        transcription_prompt:
          'Warehouse voice picking on a headset. Expect two-digit check numbers, quantities, aisle letters A to F, and words like ready, done, short, damaged, empty, skip, break.',
        voice_focus: this.s.farField ? 'far-field' : 'near-field',
        turn_detection: {
          interrupt_response: true,
          ...(this.tuning.silence ? { min_silence: this.tuning.silence[0], max_silence: this.tuning.silence[1] } : {}),
        },
        ...(this.tuning.mode ? { transcription_mode: this.tuning.mode } : {}),
      },
      output: { voice: lang.voice },
    }
  }

  private phaseConfig(): SessionConfig {
    let tools = this.toolNames().map((k) => ((this.tuning.argless && k in A ? A[k as keyof typeof A] : T[k as keyof typeof T]) as ToolDef))
    if (this.tuning.plainParams) tools = tools.map(plain)
    return this.tuning.staticPrompt ? { tools } : { system_prompt: this.fit(this.prompt()), tools }
  }

  /** Rename tools in prompt text for the argument-free tool set. */
  private fit(text: string) {
    if (!this.tuning.argless) return text
    return text
      .replaceAll('call confirm_location with them.', 'call read_check_digits.')
      .replaceAll('→ confirm_location with them.', '→ read_check_digits.')
      .replaceAll('[confirm_location "47"]', '[read_check_digits]')
      .replaceAll('call confirm_pick with the number they actually picked.', 'call confirm_pick.')
      .replaceAll('→ confirm_pick with the number actually picked.', '→ confirm_pick.')
      .replaceAll('[confirm_pick 3]', '[confirm_pick]')
      .replaceAll('call report_exception.', 'call report_damaged, report_wrong_item or report_empty_bin.')
      .replaceAll('→ report_exception.', '→ report_damaged, report_wrong_item or report_empty_bin.')
      .replaceAll(
        'Do not mention the item or quantity yet; that comes after the location is confirmed.',
        'You do not know the item, the quantity, or whether the digits are right: only read_check_digits knows. The only valid response to digits is calling read_check_digits, even if the same digits were correct at an earlier slot.',
      )
  }

  /** One prompt for the whole shift; the tool list and tool results carry the state. */
  staticPrompt() {
    const lang = LANGS[this.s.lang]
    return `# Role
You are Tote, the voice in a warehouse picker's headset. The picker, Sam, is walking the floor with both hands busy, picking customer orders into tote ${TOTE}. You direct every pick and log what happens by calling tools.

# Voice style
- One short sentence per reply, twelve words or fewer. Instruction first.
- No filler, no exclamation marks, no markdown, no lists.
- After a tool result, say its "say" field, translated if needed, and nothing more.${this.tuning.ack ? '\n- The picker needs to hear you instantly. Whenever you call a tool, first speak one word ("Checking." or "Okay."), then call the tool in the same reply.' : ''}
- ${lang.line}

# How a pick works
1. Ready, yes, go, let's start → start_batch.
2. They walk to the location you gave and read the two check digits on the slot label. Two digits heard ("four seven", "47") → confirm_location with them. Blocked, can't find it, unsafe → skip_location.
3. After the location is confirmed they pick. A number, "done", "got them" (the full quantity) → confirm_pick. Fewer on the shelf ("only three") → confirm_pick with the number actually picked. Damaged, wrong product, empty bin → report_exception.
4. Tote complete and they say end shift or goodbye → end_shift.
Only the current step's tools exist. The latest tool result says where things stand.

# Truth rules
- Never state a location, check digit, quantity, item, count or rate unless it came from a tool result.
- Never reveal or hint at a check digit.
- When in doubt, call a tool. Call exactly one tool per turn.

# Anytime
- "How am I doing", "what's left" → shift_status. Break or equipment problem → pause_shift; back → resume_shift. Wants a person, unsafe, stuck → call_supervisor. Spill, leak, fallen stock or blocked aisle → report_hazard.`
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
Example: Picker: "Four seven." You: ${this.tuning.ack ? '"Checking." ' : ''}[confirm_location "47"] "Pick 2, espresso beans."`
        break
      case 'pick':
        state = `PICK at ${line && spoken(line.loc)}, location confirmed. Put exactly ${line?.qty} × ${line?.item.name} in the tote.
- They say a number, or "done" / "got them" / "picked" (meaning ${line?.qty}) → call confirm_pick.
- Fewer on the shelf ("only three", "there's just one") → call confirm_pick with the number they actually picked.
- Damaged product, wrong product in the bin, or empty bin → call report_exception.
Example: Picker: "Only three here." You: ${this.tuning.ack ? '"Okay." ' : ''}[confirm_pick 3] "Short one logged. Aisle C, bay 2, level 3."`
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
- No filler ("great", "sure", "okay so")${this.tuning.ack ? ' other than the one-word acknowledgement' : ''}, no exclamation marks, no markdown, no lists.
- Say locations like "Aisle B, bay 7, level 1". Say quantities as plain numbers.
- After a tool result, say its "say" field, translated if needed, and nothing more.${this.tuning.ack ? '\n- The picker needs to hear you instantly. Whenever you call a tool, first speak one word ("Checking." or "Okay."), then call the tool in the same reply.' : ''}
- ${lang.line}

# Truth rules
- Never state a location, check digit, quantity, item, count or rate unless it appears in this prompt or a tool result.
- Never reveal or hint at a check digit.
- When in doubt, call a tool. A wasted call is fine; a wrong pick is not.
- Call exactly one tool per turn.

# Anytime
- "How am I doing", "what's left", "what's my rate" → shift_status.
- Break, restroom, equipment problem → pause_shift.
- Wants a person, feels unsafe, injured, or stuck → call_supervisor.${this.tuning.argless ? '\n- Spill, leak, fallen stock, broken racking or a blocked aisle → report_hazard.' : ''}

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

  /** A picker reports a hazard: close the aisle, alert the lead, re-sequence. */
  private hazardReport(said: string): ToolOutcome {
    const lower = said.toLowerCase()
    const named = lower.match(/\baisle\s+([a-f])\b/)
    const cur = this.activeLine
    const aisle = (named ? named[1].toUpperCase() : cur?.loc.aisle ?? 'A') as Aisle
    const kind = mentions(lower, ['spill', 'leak', 'liquid', 'wet', 'oil'])
      ? 'spill'
      : mentions(lower, ['rack', 'shelf', 'beam'])
        ? 'damaged racking'
        : mentions(lower, ['fell', 'fallen', 'boxes on the floor'])
          ? 'fallen stock'
          : 'blocked aisle'
    this.s.hazard = { aisle, kind, at: this.now() }
    const t = this.task('safety', { loc: { aisle, bay: 1, level: 1 } }, `Safety: ${kind} in aisle ${aisle}, aisle closed`)
    this.log('hazard', `Hazard: ${kind} in aisle ${aisle}; ${t.id} raised, lead alerted`)
    // Picks in the closed aisle wait at the back of the queue.
    let moved = 0
    const keep: Line[] = []
    const later: Line[] = []
    for (const l of this.s.lines) {
      const pendingHere = l.loc.aisle === aisle && (l.status === 'pending' || (l === cur && this.s.phase === 'travel'))
      if (pendingHere) {
        if (l === cur) l.status = 'pending'
        later.push(l)
        moved++
      } else keep.push(l)
    }
    this.s.lines = [...keep, ...later]
    let say = `Logged: ${kind} in aisle ${aisle}. Dana's been alerted.`
    if (cur && cur.status === 'pending') {
      const next = this.s.lines.findIndex((l) => l.status === 'pending' && l.loc.aisle !== aisle)
      if (next >= 0) {
        this.startLine(next)
        say += ` Skip aisle ${aisle} for now. ${spoken(this.s.lines[next].loc)}.`
      } else {
        this.s.active = -1
        say += ` Hold where you are until it's cleared.`
      }
    } else if (moved) say += ` Your aisle ${aisle} picks moved to the end.`
    return this.outcome({ logged: kind, aisle, safety_task: t.id, say })
  }

  /** The lead marks the hazard cleared; returns the reopened aisle. */
  clearHazard(): Aisle | null {
    const h = this.s.hazard
    if (!h) return null
    this.s.hazard = null
    this.log('hazard_clear', `Aisle ${h.aisle} cleared and reopened`)
    this.s.tasks = this.s.tasks.filter((t) => !(t.kind === 'safety' && t.text.includes(`aisle ${h.aisle}`)))
    if (this.s.active === -1 && (this.s.phase === 'travel' || this.s.phase === 'pick')) {
      const next = this.s.lines.findIndex((l) => l.status === 'pending')
      if (next >= 0) this.startLine(next)
    }
    this.changed()
    this.port?.update(this.phaseConfig(), 'state → hazard cleared')
    this.port?.say(`In one sentence, tell the picker aisle ${h.aisle} is clear again.`, `Dana cleared the ${h.kind} in aisle ${h.aisle}.`)
    return h.aisle
  }

  /** Guardrail: the model answered an actionable utterance without calling a
   *  tool. Run the check ourselves and have the agent correct itself. */
  guard(userText: string) {
    if (!this.port || !this.tuning.argless) return
    const lang = this.s.lang
    let tool: string | null = null
    if (this.s.phase === 'travel' && extractDigits(userText, lang).length === 2) tool = 'read_check_digits'
    else if (this.s.phase === 'pick') {
      if (mentions(userText, ['damag', 'broken', 'crushed', 'leak'])) tool = 'report_damaged'
      else if (mentions(userText, ['empty'])) tool = 'report_empty_bin'
      else if (mentions(userText, ['wrong'])) tool = 'report_wrong_item'
      // Only explicit pick language: bare numbers here are often the next
      // slot's check digits said early, and the model is right to wait.
      else if (mentions(userText, PICK_WORDS)) tool = 'confirm_pick'
    }
    if (!tool) return
    if (!this.heardSinceTool.length) this.heardSinceTool = [userText]
    const out = this.handleTool(tool, {}, `guard-${Date.now()}`)
    const say = (out.result as { say?: string }).say
    this.log('guard', `Agent replied without checking; state machine ran ${tool} itself`)
    this.changed()
    if (out.update) this.port.update(out.update, `guard → ${tool}`)
    if (say)
      this.port.say(
        `Your last reply was not based on a check. Say exactly: "Checked. ${say}"`,
        `Authoritative ${tool} result from the warehouse system: ${JSON.stringify(out.result)}`,
      )
  }

  // --- tool handlers ---------------------------------------------------------------
  handleTool = (name: string, args: Record<string, unknown>, callId: string): ToolOutcome => {
    if (!this.tuning.argless) return this.run(name, args, callId)
    // Read the value out of what the picker actually said since the last tool.
    const said = this.heardSinceTool.join(' ')
    this.heardSinceTool = []
    const lang = this.s.lang
    switch (name) {
      case 'read_check_digits': {
        const d = extractDigits(said, lang)
        if (d.length < 2) {
          // A pause between digits can end the turn early: keep what was
          // heard so the next utterance completes the pair.
          if (d.length === 1) this.heardSinceTool = [said]
          return this.outcome({ verified: false, heard: said, say: d.length === 1 ? 'And the second digit?' : 'Read me both check digits.' })
        }
        return this.run('confirm_location', { check_digits: d }, callId)
      }
      case 'confirm_pick': {
        const n = extractCount(said, lang)
        // "Only…" cut off before the number must not become a full pick.
        if (n === null && mentions(said, ['only', 'just', 'fewer', 'short', 'not enough', 'solo', 'nur', 'seulement', 'só'])) {
          this.heardSinceTool = [said]
          return this.outcome({ recorded: false, say: 'How many did you pick?' })
        }
        return this.run('confirm_pick', { quantity: n ?? this.activeLine?.qty ?? 0 }, callId)
      }
      case 'report_damaged':
        return this.run('report_exception', { kind: 'damaged', units_available: 0 }, callId)
      case 'report_wrong_item':
        return this.run('report_exception', { kind: 'wrong_item' }, callId)
      case 'report_empty_bin':
        return this.run('report_exception', { kind: 'empty_bin' }, callId)
      case 'skip_location':
        // Skipping loses a pick, so only the picker's own words can trigger it.
        if (!mentions(said, SKIP_WORDS)) {
          this.heardSinceTool = [said]
          return this.outcome({ skipped: false, heard: said, say: 'I did not catch that. Read the two check digits, or say skip.' })
        }
        return this.run(
          'skip_location',
          { reason: mentions(said, ['block', 'pallet', 'forklift']) ? 'blocked' : mentions(said, ['find', 'where', 'missing']) ? 'cannot_find' : mentions(said, ['unsafe', 'danger', 'high', 'ladder']) ? 'unsafe' : 'other' },
          callId,
        )
      case 'pause_shift':
        return this.run('pause_shift', { reason: mentions(said, ['bathroom', 'restroom', 'toilet', 'loo']) ? 'restroom' : mentions(said, ['battery', 'scanner', 'headset', 'equipment', 'broken']) ? 'equipment' : 'break' }, callId)
      case 'call_supervisor':
        return this.run('call_supervisor', { reason: said.trim() || 'help requested' }, callId)
      case 'report_hazard':
        return this.hazardReport(said)
      default:
        return this.run(name, args, callId)
    }
  }

  private run = (name: string, args: Record<string, unknown>, callId: string): ToolOutcome => {
    // The model occasionally fires two tools for one utterance ("only 3 here"
    // → confirm_pick + report_exception). If the first already closed the
    // line, answer the second with the same instruction instead of an error.
    if (this.lastOutcome && this.now() - this.lastOutcome.at < 1500 && (name === 'report_exception' || name === 'confirm_pick' || name === 'confirm_location')) {
      const stale = (name === 'confirm_location' && this.s.phase !== 'travel') || (name !== 'confirm_location' && this.s.phase !== 'pick')
      if (stale) return { result: { duplicate: true, say: this.lastOutcome.say }, update: this.phaseConfig() }
    }
    const out = this.runInner(name, args, callId)
    const say = (out.result as { say?: string })?.say
    if (say) this.lastOutcome = { at: this.now(), say }
    return out
  }
  private lastOutcome: { at: number; say: string } | null = null

  private runInner = (name: string, args: Record<string, unknown>, callId: string): ToolOutcome => {
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
          return this.run('confirm_pick', { quantity: avail }, callId)
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
        this.later(5500, () => this.port?.end())
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
