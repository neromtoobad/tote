// Rehearse a whole shift against the live Voice Agent API with no microphone.
// macOS `say` voices the picker, ffmpeg turns it into PCM16 @ 24 kHz, and the
// same Shift + VoiceAgent code the browser runs handles every tool call.
//
//   node scripts/drive.ts            # English, default voice
//   LANG=es node scripts/drive.ts    # Spanish shift
//   WRONG=1 node scripts/drive.ts    # also misread one check digit
//
// Needs ASSEMBLYAI_API_KEY in .env, macOS `say`, and ffmpeg on PATH.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Shift, type LangKey } from '../src/sim/shift.ts'
import { checkDigits, code } from '../src/sim/warehouse.ts'
import { VoiceAgent } from '../src/voice/agent.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, '..', 'assemblyai', '.env')]) {
  if (!fs.existsSync(f)) continue
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}
const KEY = process.env.ASSEMBLYAI_API_KEY
if (!KEY) throw new Error('ASSEMBLYAI_API_KEY missing')
const LANG = (process.env.LANG_SHIFT ?? process.env.TOTE_LANG ?? 'en') as LangKey
const WRONG = process.env.WRONG === '1'
const RATE = 24_000
const CHUNK = 1200 // 50 ms
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-'))
const DIGIT_WORDS: Record<LangKey, string[]> = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
  fr: ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'],
  it: ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'],
  pt: ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'],
}
const PHRASES: Record<LangKey, Record<string, string>> = {
  en: { ready: 'Ready.', got: 'Got them.', got1: 'Got it.', last: 'Done.', short: 'Only {n} here.', damaged: "Hmm, this one's damaged.", status: 'How am I doing?', end: "That's it. End my shift.", brk: 'I need a quick break.', back: "Okay, I'm back." },
  es: { ready: 'Listo.', got: 'Ya los tengo.', short: 'Solo hay {n}.', damaged: 'Este está dañado.', status: '¿Cómo voy?', end: 'Terminar turno.' },
  de: { ready: 'Bereit.', got: 'Hab sie.', short: 'Nur {n} da.', damaged: 'Der ist beschädigt.', status: 'Wie stehe ich?', end: 'Schicht beenden.' },
  fr: { ready: 'Prêt.', got: "C'est bon.", short: 'Seulement {n}.', damaged: 'Celui-ci est abîmé.', status: 'Où j’en suis ?', end: 'Fin de poste.' },
  it: { ready: 'Pronto.', got: 'Presi.', short: 'Solo {n}.', damaged: 'Questo è danneggiato.', status: 'Come sto andando?', end: 'Fine turno.' },
  pt: { ready: 'Pronto.', got: 'Já tenho.', short: 'Só há {n}.', damaged: 'Este está danificado.', status: 'Como estou?', end: 'Terminar turno.' },
}
const VOICE: Record<LangKey, string> = { en: 'Samantha', es: 'Paulina', de: 'Anna', fr: 'Thomas', it: 'Alice', pt: 'Joana' }

// Pre-voiced lines (video/voice/lines.json) win over macOS `say` when present.
const VOICE_DIR = path.join(ROOT, 'video', 'voice')
const VOICED: Record<string, string> = LANG === 'en' && fs.existsSync(path.join(VOICE_DIR, 'lines.json')) ? JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'lines.json'), 'utf8')) : {}

function tts(text: string): Buffer {
  if (VOICED[text]) {
    // A beat of lead-in so the utterance doesn't start on the first sample.
    return Buffer.concat([Buffer.alloc(2400), fs.readFileSync(path.join(VOICE_DIR, VOICED[text])), Buffer.alloc(2400)])
  }
  const aiff = path.join(TMP, 'u.aiff')
  const raw = path.join(TMP, 'u.raw')
  execFileSync('say', ['-v', VOICE[LANG], '-o', aiff, text])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', String(RATE), '-f', 's16le', raw])
  return fs.readFileSync(raw)
}

let t0 = Date.now()
// The tape: every server message with its arrival time, plus both audio tracks,
// so scripts/replay can re-render this exact session frame by frame.
const TAPE_DIR = process.env.TAPE ? path.join(ROOT, 'video', 'tapes', process.env.TAPE) : null
const tape: { lang: LangKey; events: Record<string, unknown>[]; report?: unknown; session?: string | null } = { lang: LANG, events: [] }
const agentPcm: Buffer[] = []
const samPcm: Buffer[] = []
let agentBytes = 0
let samBytes = 0
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`
const out = (who: string, text: string) => console.log(`${ts()}  ${who.padEnd(6)} ${text}`)

const shift = new Shift(LANG)
const agent = new VoiceAgent(shift.handleTool, (b64) => {
  const b = Buffer.from(b64, 'base64')
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
})
shift.port = {
  update: (c, d) => agent.update(c, d),
  say: (i, c) => agent.say(i, c),
  resolveHold: (id, n, o) => agent.resolveHold(id, n, o),
  end: () => agent.end(),
}

// --- mic simulator: continuous real-time stream, speech spliced into silence ---
let speech: Buffer | null = null
let speechPos = 0
const silence = Buffer.alloc(CHUNK * 2)
const mic = setInterval(() => {
  let chunk = silence
  if (speech) {
    chunk = speech.subarray(speechPos, speechPos + CHUNK * 2)
    speechPos += CHUNK * 2
    if (chunk.length < CHUNK * 2) chunk = Buffer.concat([chunk, silence.subarray(chunk.length)])
    if (speechPos >= speech.length) speech = null
  }
  agent.sendAudio(chunk.toString('base64'))
}, 50)

function speak(text: string) {
  out('SAM', text)
  speech = tts(text)
  speechPos = 0
  tape.events.push({ t: Date.now() - t0 + 25, sam: text, off: samBytes, len: speech.length })
  samPcm.push(speech)
  samBytes += speech.length
}

// --- when the agent has finished talking, decide what Sam says next -------------
let replyStart = 0
let replyAudioMs = 0
let respondTimer: ReturnType<typeof setTimeout> | null = null
let askedStatus = false
let wrongDone = !WRONG
const P = PHRASES[LANG]
const digitsSpoken = (d: string) => {
  const w = d.split('').map((c) => DIGIT_WORDS[LANG][Number(c)]).join(' ')
  return `${w[0].toUpperCase()}${w.slice(1)}.`
}
const BREAK = process.env.BREAK === '1'
let breakDone = !BREAK

function nextUtterance(): string | null {
  const s = shift.getSnapshot()
  const line = s.lines[s.active]
  switch (s.phase) {
    case 'briefing':
      return P.ready
    case 'travel': {
      if (!line || !s.arrivedAt) return null
      const d = checkDigits(line.loc)
      if (!wrongDone && line.id === 'L3') {
        wrongDone = true
        return digitsSpoken(String(Number(d) + 10).slice(-2)) // misread the first digit
      }
      if (line.mismatches > 0 && LANG === 'en') return `Oh, sorry. ${digitsSpoken(d)}`
      return digitsSpoken(d)
    }
    case 'pick': {
      if (!line) return null
      const slot = s.slots.get(code(line.loc))!
      if (slot.damaged) return P.damaged
      if (slot.onHand < line.qty) return P.short.replace('{n}', String(slot.onHand))
      if (!askedStatus && s.lines.filter((l) => l.status === 'picked').length >= 4) {
        askedStatus = true
        return P.status
      }
      if (!breakDone && line.id === 'L5') {
        breakDone = true
        return P.brk ?? P.got
      }
      const pending = s.lines.filter((l) => l.status === 'pending').length
      if (!pending && P.last) return P.last
      return line.qty === 1 && P.got1 ? P.got1 : P.got
    }
    case 'paused':
      return P.back ?? P.ready
    case 'complete':
      return P.end
    default:
      return null
  }
}

// Sam answers once per finished agent turn, and never while a tool result is
// still owed (the agent may speak a filler before the real answer).
let agentTurns = 0
let answeredTurn = -1
let owedTools = 0
let resultSent = false
agent.on('toolCall', () => {
  owedTools++
  resultSent = false
})
agent.on('toolResult', () => (resultSent = true))
agent.on('agent', () => {
  agentTurns++
  if (resultSent) {
    owedTools = 0
    resultSent = false
  }
})

function scheduleResponse() {
  if (respondTimer) clearTimeout(respondTimer)
  const wait = Math.max(0, replyStart + replyAudioMs - Date.now()) + 750
  respondTimer = setTimeout(function tryRespond() {
    if (agent.status !== 'listening' || speech || owedTools > 0) return
    if (answeredTurn === agentTurns) return
    const u = nextUtterance()
    if (!u) {
      respondTimer = setTimeout(tryRespond, 400) // e.g. still walking to the slot
      return
    }
    answeredTurn = agentTurns
    speak(u)
  }, wait)
}

agent.on('wire', (e) => {
  if (e.type === 'session.update' || e.type === 'tool.result' || e.type === 'reply.create' || e.type === 'conversation.message' || e.type.startsWith('session.'))
    out(e.dir === 'up' ? '  ↑' : '  ↓', `${e.type}${e.detail ? ` · ${e.detail.slice(0, 110)}` : ''}`)
})
agent.on('ready', (id) => out('READY', id))
agent.on('raw', (msg) => {
  const t = Date.now() - t0
  if (msg.type === 'reply.audio') {
    const b = Buffer.from(String(msg.data), 'base64')
    tape.events.push({ t, msg: { type: 'reply.audio', data: '' }, off: agentBytes, len: b.length })
    agentPcm.push(b)
    agentBytes += b.length
  } else tape.events.push({ t, msg })
})
agent.on('user', (_, text) => {
  shift.heard(text)
  out('heard', `“${text}”`)
})
agent.on('agent', (_, text, cut) => out('TOTE', `${text}${cut ? '  [interrupted]' : ''}`))
agent.on('toolCall', (name, args) => out('tool', `${name}(${JSON.stringify(args)})`))
agent.on('toolResult', (name, r) => out('  →', `${name}: ${JSON.stringify(r).slice(0, 140)}`))
agent.on('latency', (ms) => {
  shift.latency(ms)
  out('lat', `${ms} ms`)
})
agent.on('audio', (pcm) => (replyAudioMs += (pcm.byteLength / 2 / RATE) * 1000))
agent.on('status', (st, d) => {
  if (st === 'speaking') {
    replyStart = Date.now()
    replyAudioMs = 0
  }
  if (st === 'listening') scheduleResponse()
  if (st === 'error') out('ERROR', d ?? '')
  if (st === 'ended' || st === 'error') finish()
})

let finished = false
function finish() {
  if (finished) return
  finished = true
  clearInterval(mic)
  shift.dispose()
  const s = shift.getSnapshot()
  const lat = [...s.latencies].sort((a, b) => a - b)
  console.log('\n--- result ---')
  for (const l of s.lines) console.log(`${l.id.padEnd(3)} ${code(l.loc)} ${l.item.name.padEnd(24)} want ${l.qty} got ${l.picked}  ${l.status}${l.mismatches ? ` (${l.mismatches} rejected)` : ''}`)
  console.log('tasks:', s.tasks.map((t) => `${t.id} ${t.text}`).join(' | ') || 'none')
  console.log(`latency p50 ${lat[Math.floor(lat.length / 2)] ?? '-'} ms, max ${lat[lat.length - 1] ?? '-'} ms, n=${lat.length}`)
  console.log('session', agent.sessionId)
  fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify({ session: agent.sessionId, lines: s.lines, log: s.log, latencies: s.latencies }, null, 2))
  console.log('saved', path.join(TMP, 'result.json'))
  void saveTape(s).finally(() => setTimeout(() => process.exit(0), 300))
}

async function saveTape(s: ReturnType<typeof shift.getSnapshot>) {
  if (!TAPE_DIR) return
  fs.mkdirSync(TAPE_DIR, { recursive: true })
  tape.session = agent.sessionId
  try {
    const res = await fetch(process.env.REPORT_URL ?? 'http://localhost:8787/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: agent.sessionId,
        log: {
          tote: 'T-1042',
          language: LANG,
          lines: s.lines.map((l) => ({ order: l.order, slot: code(l.loc), item: l.item.name, qty: l.qty, picked: l.picked, status: l.status, check_digit_rejections: l.mismatches, rush: Boolean(l.rush) })),
          tasks: s.tasks,
          events: s.log,
        },
      }),
    })
    tape.report = await res.json()
    console.log('report', res.status)
  } catch (e) {
    console.log('report skipped:', (e as Error).message)
  }
  fs.writeFileSync(path.join(TAPE_DIR, 'tape.json'), JSON.stringify(tape))
  fs.writeFileSync(path.join(TAPE_DIR, 'agent.pcm'), Buffer.concat(agentPcm))
  fs.writeFileSync(path.join(TAPE_DIR, 'sam.pcm'), Buffer.concat(samPcm))
  console.log('tape saved to', TAPE_DIR, `${tape.events.length} events`)
}
setTimeout(() => {
  out('TIMEOUT', 'ending session')
  agent.end()
  setTimeout(finish, 3000)
}, Number(process.env.MAX_S ?? 300) * 1000)

// --- go -----------------------------------------------------------------------------
const url = new URL('https://agents.assemblyai.com/v1/token')
url.searchParams.set('expires_in_seconds', '60')
url.searchParams.set('max_session_duration_seconds', '600')
const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } })
if (!res.ok) throw new Error(`token ${res.status} ${await res.text()}`)
const { token } = (await res.json()) as { token: string }
t0 = Date.now()
agent.connect(token, shift.initialConfig())
