// Tote server: mints single-use Voice Agent tokens, builds shift reports from
// AssemblyAI session recordings, and serves the built web app.
//
//   node server/index.ts
//
// The API key never reaches the browser.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv(path.join(ROOT, '.env'))
loadEnv(path.join(ROOT, '..', 'assemblyai', '.env'))

const KEY = process.env.ASSEMBLYAI_API_KEY ?? ''
const PORT = Number(process.env.PORT ?? 8787)
const AGENTS = 'https://agents.assemblyai.com/v1'
const GATEWAY = 'https://llm-gateway.assemblyai.com/v1/chat/completions'
const REPORT_MODEL = process.env.TOTE_REPORT_MODEL ?? 'claude-sonnet-5'
// A public demo spends real credits, so sessions are capped and rationed.
const MAX_SESSION_S = Number(process.env.TOTE_MAX_SESSION_S ?? 900)
const TOKENS_PER_HOUR = Number(process.env.TOTE_TOKENS_PER_HOUR ?? 40)
const DIST = path.join(ROOT, 'dist')

if (!KEY) console.warn('ASSEMBLYAI_API_KEY is not set: /api/token will fail')

function loadEnv(file: string) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}

// --- rate limit ---------------------------------------------------------------
const hits = new Map<string, number[]>()
function allow(ip: string) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= TOKENS_PER_HOUR) return false
  recent.push(now)
  hits.set(ip, recent)
  return true
}

// --- AssemblyAI ---------------------------------------------------------------
async function aai(pathname: string, init: RequestInit = {}) {
  const res = await fetch(AGENTS + pathname, {
    ...init,
    headers: { Authorization: KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

async function mintToken() {
  const url = new URL(AGENTS + '/token')
  url.searchParams.set('expires_in_seconds', '120')
  url.searchParams.set('max_session_duration_seconds', String(MAX_SESSION_S))
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } })
  if (!res.ok) throw new Error(`token ${res.status} ${(await res.text()).slice(0, 200)}`)
  const { token } = (await res.json()) as { token: string }
  return { token, maxSessionSeconds: MAX_SESSION_S }
}

type Artifact = { type: string; url: string; content_type?: string }
type Session = { id: string; status: string; duration_seconds?: number; artifacts?: Artifact[] }

// Artifacts land a few seconds after session.ended.
async function sessionWithArtifacts(id: string, waitMs = 20_000): Promise<Session> {
  const until = Date.now() + waitMs
  for (;;) {
    const s = (await aai(`/sessions/${encodeURIComponent(id)}`)) as Session
    if (s.artifacts?.some((a) => a.type === 'timeline') || Date.now() > until) return s
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function chat(system: string, user: string) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { Authorization: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: REPORT_MODEL,
      max_tokens: 700,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`gateway ${res.status} ${body.slice(0, 300)}`)
  const data = JSON.parse(body)
  return String(data.choices?.[0]?.message?.content ?? '').trim()
}

const REPORT_SYSTEM = `You write end-of-shift notes for a warehouse floor supervisor.
Input: the pick log a voice-picking system recorded, plus the headset conversation.
Output exactly these markdown sections, terse, no preamble:
**Summary** one sentence with lines, units, accuracy and rate.
**Exceptions** bullets: location, what happened, what the system did (replen task, QA hold, skip).
**Coaching** one or two bullets about the picker, drawn only from the conversation.
**Follow-ups** bullets a supervisor should action today.
Never invent numbers or locations that are not in the input.`

type PickLog = {
  lines?: { order: string; slot: string; item: string; qty: number; picked: number; status: string; check_digit_rejections: number; rush: boolean }[]
  tasks?: { id: string; kind: string; text: string }[]
  events?: { t: number; kind: string; detail: string; heard?: string }[]
  metrics?: { lph: number; accuracy: number; minutes: number }
}

// Used when the account has no LLM Gateway access: the same four sections,
// built straight from the pick log so nothing is ever invented.
function ruleNotes(log: PickLog, turns: number) {
  const lines = log.lines ?? []
  const done = lines.filter((l) => l.status !== 'pending' && l.status !== 'active')
  const units = done.reduce((n, l) => n + l.picked, 0)
  const clean = done.filter((l) => l.status === 'picked' && !l.check_digit_rejections).length
  const ev = log.events ?? []
  const start = ev.find((e) => e.kind === 'start')?.t ?? 0
  const end = ev.find((e) => e.kind === 'complete')?.t ?? ev[ev.length - 1]?.t ?? 0
  const mins = Math.max(0.1, (end - start) / 60000)
  const exceptions = done.filter((l) => l.status !== 'picked' || l.check_digit_rejections)
  const m = log.metrics
  const out = [
    `**Summary** ${done.length} of ${lines.length} lines, ${units} units in ${(m?.minutes ?? mins).toFixed(1)} min (${m?.lph ?? Math.round((done.length / mins) * 60)} lines/h), ${m?.accuracy ?? (done.length ? Math.round((clean / done.length) * 100) : 100)}% first-time right.`,
    '**Exceptions**',
    ...(exceptions.length
      ? exceptions.map((l) => {
          const what =
            l.status === 'short' ? `short ${l.qty - l.picked} of ${l.qty}, replenishment raised` : l.status === 'damaged' ? 'damaged stock, QA hold placed, not picked' : l.status === 'skipped' ? 'skipped and flagged to the lead' : `${l.check_digit_rejections} wrong check-digit read caught before picking`
          return `- ${l.slot} ${l.item}: ${what}.`
        })
      : ['- None.']),
    '**Coaching**',
    ...(ev.some((e) => e.kind === 'mismatch')
      ? ['- Misread a check digit once; the location check stopped a wrong-slot pick. Read both digits at a steady pace.']
      : ['- Clean location reads all shift.']),
    ...(ev.some((e) => e.kind === 'rush') ? ['- Took the rush re-route mid-walk without losing the batch.'] : []),
    '**Follow-ups**',
    ...((log.tasks ?? []).length ? (log.tasks ?? []).map((t) => `- ${t.id}: ${t.text}.`) : ['- None.']),
  ]
  if (turns) out.push(`${turns} headset turns on record in the session timeline.`)
  return out.join('\n')
}

async function buildReport(sessionId: string | undefined, log: unknown) {
  let session: Session | null = null
  let timeline: unknown = null
  let recording: string | null = null
  if (sessionId) {
    try {
      session = await sessionWithArtifacts(sessionId)
      const tl = session.artifacts?.find((a) => a.type === 'timeline')
      const au = session.artifacts?.find((a) => a.type === 'audio')
      recording = au?.url ?? null
      if (tl) timeline = await fetch(tl.url).then((r) => r.json())
    } catch (e) {
      console.warn('session fetch failed', (e as Error).message)
    }
  }
  const convo = timeline ? JSON.stringify(timeline).slice(0, 24_000) : '(recording not available yet)'
  const turns = Array.isArray(timeline) ? timeline.length : Array.isArray((timeline as { turns?: unknown[] })?.turns) ? (timeline as { turns: unknown[] }).turns.length : 0
  let notes: string
  let model = REPORT_MODEL
  try {
    notes = await chat(
      REPORT_SYSTEM,
      `PICK LOG\n${JSON.stringify(log).slice(0, 16_000)}\n\nHEADSET CONVERSATION (AssemblyAI session timeline)\n${convo}`,
    )
  } catch (e) {
    console.warn('gateway unavailable, using rule notes:', (e as Error).message.slice(0, 120))
    notes = ruleNotes(log as PickLog, turns)
    model = 'rules'
  }
  return {
    notes,
    model,
    session: session && { id: session.id, status: session.status, duration: session.duration_seconds },
    recording,
    timeline,
  }
}

// --- post-shift voice analytics (async Universal-3 Pro on the recording) --------
// The session recording is stereo: left = picker, right = agent. A multichannel
// pre-recorded pass gives an independent transcript per speaker, sentiment per
// sentence and key phrases, which the report uses to re-verify every check read.
const STT = 'https://api.assemblyai.com/v2/transcript'
const LANG_CODE: Record<string, string> = { English: 'en', Español: 'es', Deutsch: 'de', Français: 'fr', Italiano: 'it', Português: 'pt' }

async function startAnalysis(sessionId: string, language?: string) {
  const session = await sessionWithArtifacts(sessionId, 30_000)
  const audio = session.artifacts?.find((a) => a.type === 'audio')
  if (!audio) throw new Error('recording not ready yet')
  const res = await fetch(STT, {
    method: 'POST',
    headers: { Authorization: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: audio.url,
      multichannel: true,
      language_code: LANG_CODE[language ?? ''] ?? 'en',
      speech_models: ['universal-3-pro', 'universal-2'],
      sentiment_analysis: true,
      auto_highlights: true,
    }),
  })
  const body = (await res.json()) as { id?: string; error?: string }
  if (!res.ok || !body.id) throw new Error(`transcript ${res.status} ${body.error ?? ''}`)
  return { id: body.id }
}

type Utt = { channel?: string; start: number; end: number; text: string; words?: unknown[] }
type Sent = { channel?: string; start: number; end: number; text: string; sentiment: string; confidence: number }

async function readAnalysis(id: string) {
  const res = await fetch(`${STT}/${encodeURIComponent(id)}`, { headers: { Authorization: KEY } })
  const d = (await res.json()) as {
    status: string
    error?: string
    speech_model_used?: string
    audio_duration?: number
    utterances?: Utt[]
    sentiment_analysis_results?: Sent[]
    auto_highlights_result?: { results?: { text: string; count: number; rank: number }[] }
    words?: { channel?: string; start: number; end: number; text: string }[]
  }
  if (d.status !== 'completed') return { status: d.status, error: d.error }
  // Rebuild phrases from word timings: the recognizer can merge a whole
  // channel's speech into one long utterance, which would hide individual reads
  // and count silence as talk.
  const who = (u: { channel?: string }) => (String(u.channel) === '1' ? 'picker' : 'agent')
  const words = (d.words ?? []).slice().sort((a, b) => a.start - b.start)
  const phrases: { who: 'picker' | 'agent'; at: number; end: number; text: string }[] = []
  const open: Record<string, (typeof phrases)[number] | undefined> = {}
  for (const w of words) {
    const k = who(w)
    const cur = open[k]
    if (cur && w.start - cur.end < 700) {
      cur.text += ` ${w.text}`
      cur.end = w.end
    } else {
      const p = { who: k as 'picker' | 'agent', at: w.start, end: w.end, text: w.text }
      phrases.push(p)
      open[k] = p
    }
  }
  const utts = phrases.length ? phrases : (d.utterances ?? []).map((u) => ({ who: who(u), at: u.start, end: u.end, text: u.text }))
  const talk = { picker: 0, agent: 0 }
  const count = { picker: 0, agent: 0 }
  for (const w of words) {
    talk[who(w)] += (w.end - w.start) / 1000
    count[who(w)]++
  }
  if (!words.length) for (const u of utts) talk[u.who] += (u.end - u.at) / 1000
  const wordsBy = count
  const sentiment = (d.sentiment_analysis_results ?? [])
    .filter((x) => who(x) === 'picker')
    .map((x) => ({ at: x.start, sentiment: x.sentiment, text: x.text }))
  return {
    status: 'completed',
    model: d.speech_model_used ?? 'universal-3-pro',
    duration: d.audio_duration ?? 0,
    talk,
    wpm: {
      picker: talk.picker ? Math.round((wordsBy.picker / talk.picker) * 60) : 0,
      agent: talk.agent ? Math.round((wordsBy.agent / talk.agent) * 60) : 0,
    },
    sentiment,
    highlights: (d.auto_highlights_result?.results ?? [])
      .filter((h) => !/^(bay|level|aisle|sam)$/i.test(h.text))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8)
      .map((h) => h.text),
    utterances: utts.map((u) => ({ who: u.who, at: u.at, text: u.text })),
  }
}

// --- http ---------------------------------------------------------------------
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage, limit = 256_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  let file = path.join(DIST, decodeURIComponent(url.pathname))
  if (!file.startsWith(DIST)) return send(res, 403, { error: 'forbidden' })
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) return send(res, 404, { error: 'build the web app first: npm run build' })
  const ext = path.extname(file)
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, key: Boolean(KEY), maxSessionSeconds: MAX_SESSION_S, reportModel: REPORT_MODEL })
    }
    if (url.pathname === '/api/token') {
      if (!KEY) return send(res, 503, { error: 'server has no ASSEMBLYAI_API_KEY' })
      if (!allow(ip)) return send(res, 429, { error: 'demo limit reached for this hour, try again later' })
      return send(res, 200, await mintToken())
    }
    if (url.pathname === '/api/report' && req.method === 'POST') {
      const { sessionId, log } = JSON.parse(await readBody(req)) as { sessionId?: string; log: unknown }
      return send(res, 200, await buildReport(sessionId, log))
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const { sessionId, language } = JSON.parse(await readBody(req)) as { sessionId: string; language?: string }
      return send(res, 200, await startAnalysis(sessionId, language))
    }
    if (url.pathname.startsWith('/api/analyze/')) {
      return send(res, 200, await readAnalysis(url.pathname.slice('/api/analyze/'.length)))
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })
    return serveStatic(req, res)
  } catch (e) {
    console.error(url.pathname, (e as Error).message)
    return send(res, 500, { error: (e as Error).message })
  }
})

server.listen(PORT, () => console.log(`tote server on http://localhost:${PORT}`))
