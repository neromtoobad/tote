// Tote Desk: a second voice agent, for the shift lead. It reads the live floor
// through tools and acts on the picker's session: a message Dana speaks here
// is relayed by the picker's own agent, in the picker's language.

import type { SessionConfig, ToolDef, ToolOutcome } from '../voice/agent.ts'
import { LANGS, metrics, TOTE, type Shift } from './shift.ts'
import { code, spoken } from './warehouse.ts'

const EMPTY = { type: 'object', properties: {} }

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    name: 'floor_status',
    description:
      "Live status of the picker and tote: progress, pace, accuracy, where they are and what's gone wrong. Call for ANY question about how Sam, the tote or the floor is doing. Never answer those from memory.",
    parameters: EMPTY,
  },
  {
    type: 'function',
    name: 'open_tasks',
    description: 'Open replenishment, QA-hold, audit and safety tasks the floor has raised. Call when asked what needs attention or what went wrong.',
    parameters: EMPTY,
  },
  {
    type: 'function',
    name: 'message_picker',
    description:
      "Speak a short message into the picker's headset. Tote relays it in the picker's own language. Call when the lead says to tell, ask or remind Sam something.",
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message in plain words, as the lead wants it heard, without "tell Sam".',
          examples: ['Great pace, keep it up', 'Take your break after this tote'],
        },
      },
      required: ['message'],
    },
  },
  {
    type: 'function',
    name: 'drop_rush_order',
    description: "Insert the waiting same-day rush order into Sam's batch; Tote re-routes Sam. Call when the lead asks to push, drop or add the rush order.",
    parameters: EMPTY,
  },
  {
    type: 'function',
    name: 'answer_page',
    description: "Reply to Sam's open page for help. Call when the lead answers a page.",
    parameters: { type: 'object', properties: { reply: { type: 'string', description: 'What to tell Sam.' } }, required: ['reply'] },
  },
  {
    type: 'function',
    name: 'clear_hazard',
    description: 'Mark a reported floor hazard as cleaned up so the aisle reopens. Call when the lead says a spill or blockage is cleared.',
    parameters: EMPTY,
  },
]

const PROMPT = `# Role
You are Tote Desk, the voice assistant at the shift lead's desk in a warehouse. The lead is Dana. On the floor, a picker named Sam is working tote ${TOTE} with a headset agent called Tote. You can see the live floor only through your tools.

# Style
- At most two short sentences. Numbers first. No filler, no exclamation marks, no markdown.
- After a tool result, say its "say" field, and add at most one short sentence of judgement if useful.

# Rules
- Never state a number, location, item or status unless it came from a tool result in this turn or the last one. For any question about the floor, call floor_status or open_tasks first.
- To tell Sam something, call message_picker with just the message.
- Call exactly one tool per turn.`

export class Desk {
  private shift: Shift
  constructor(shift: Shift) {
    this.shift = shift
  }

  config(): SessionConfig {
    return {
      system_prompt: PROMPT,
      greeting: 'Desk here. Ask me about the floor.',
      tools: TOOLS,
      input: {
        keyterms: ['Sam', 'tote', 'rush order', 'replen', 'QA hold', 'spill', 'aisle'],
        turn_detection: { interrupt_response: true, min_silence: 300, max_silence: 1100 },
      },
      output: { voice: 'george' },
    }
  }

  handleTool = (name: string, args: Record<string, unknown>): ToolOutcome => {
    const sh = this.shift
    const s = sh.getSnapshot()
    const m = metrics(s)
    const line = s.lines[s.active]
    switch (name) {
      case 'floor_status': {
        const exceptions = s.lines
          .filter((l) => ['short', 'damaged', 'skipped'].includes(l.status))
          .map((l) => `${l.status === 'damaged' ? 'damaged' : l.status} at ${code(l.loc)} (${l.item.name})`)
        const where = s.hazard && !line
          ? `holding for the ${s.hazard.kind} in aisle ${s.hazard.aisle}`
          : s.phase === 'paused'
            ? 'on a break'
            : line
              ? `${s.phase === 'pick' ? 'picking at' : 'heading to'} ${spoken(line.loc)}`
              : s.phase === 'complete'
                ? 'done, tote at pack station 3'
                : 'not started'
        const say = s.startedAt
          ? `Sam's done ${m.done} of ${m.total} lines at ${m.lph} an hour, ${m.accuracy} percent first-time right, now ${where}.${exceptions.length ? ` Exceptions: ${exceptions.join('; ')}.` : ' No exceptions.'}`
          : "Sam hasn't started the tote yet."
        return {
          result: {
            picker: 'Sam',
            language: LANGS[s.lang].label,
            phase: s.phase,
            done: m.done,
            total: m.total,
            lines_per_hour: m.lph,
            first_time_right_pct: m.accuracy,
            wrong_slots_caught: m.caught,
            now: where,
            exceptions,
            voice_latency_p50_ms: m.p50,
            say,
          },
        }
      }
      case 'open_tasks': {
        const say = s.tasks.length ? `${s.tasks.length} open: ${s.tasks.map((t) => t.text).join('; ')}.` : 'No open tasks.'
        return { result: { tasks: s.tasks.map((t) => ({ id: t.id, kind: t.kind, text: t.text })), say } }
      }
      case 'message_picker': {
        const text = String(args.message ?? '').trim()
        if (!text) return { result: { sent: false, say: 'What should I tell Sam?' } }
        if (!sh.port) return { result: { sent: false, say: "Sam's headset is offline." } }
        sh.broadcast(text)
        return { result: { sent: true, to: 'Sam', language: LANGS[s.lang].label, say: `Sent. Sam hears it in ${LANGS[s.lang].label}.` } }
      }
      case 'drop_rush_order': {
        if (s.rushAt && s.rushAt > 0) return { result: { ok: false, say: 'The rush order is already in the batch.' } }
        if (s.phase !== 'travel' && s.phase !== 'pick') return { result: { ok: false, say: "Sam isn't mid-tote right now." } }
        sh.injectRush()
        return { result: { ok: true, say: 'Rush order dropped. Tote is re-routing Sam.' } }
      }
      case 'answer_page': {
        if (!s.supervisor) return { result: { ok: false, say: 'There is no open page from Sam.' } }
        sh.answerSupervisor(String(args.reply ?? 'On my way.'))
        return { result: { ok: true, say: 'Sam has your answer.' } }
      }
      case 'clear_hazard': {
        const cleared = sh.clearHazard()
        return { result: { ok: Boolean(cleared), say: cleared ? `Aisle ${cleared} reopened. Tote will route Sam back through it.` : 'No hazard is open.' } }
      }
    }
    return { result: { error: `unknown tool ${name}` }, isError: true }
  }
}
