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
  const notes = await chat(
    REPORT_SYSTEM,
    `PICK LOG\n${JSON.stringify(log).slice(0, 16_000)}\n\nHEADSET CONVERSATION (AssemblyAI session timeline)\n${convo}`,
  )
  return {
    notes,
    model: REPORT_MODEL,
    session: session && { id: session.id, status: session.status, duration: session.duration_seconds },
    recording,
    timeline,
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
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })
    return serveStatic(req, res)
  } catch (e) {
    console.error(url.pathname, (e as Error).message)
    return send(res, 500, { error: (e as Error).message })
  }
})

server.listen(PORT, () => console.log(`tote server on http://localhost:${PORT}`))
