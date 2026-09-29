// Rebuild the audio a picker would have heard during a recorded shift.
//   node mix.mjs <tape> [lead_ms]  -> tapes/<tape>/mix.wav (48 kHz stereo)
// Agent audio is laid down the way the browser's ring buffer plays it: each
// chunk starts no earlier than it arrived and no earlier than the previous one
// ends; an interrupted reply is cut at the moment of interruption. Sam's audio
// starts when it was streamed; a soft tick marks every end of speech.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const name = process.argv[2]
const lead = Number(process.argv[3] ?? 0)
const dir = path.join(import.meta.dirname, 'tapes', name)
const tape = JSON.parse(fs.readFileSync(path.join(dir, 'tape.json'), 'utf8'))
const agent = fs.readFileSync(path.join(dir, 'agent.pcm'))
const sam = fs.readFileSync(path.join(dir, 'sam.pcm'))
const opt = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : Buffer.alloc(0))
const desk = opt('desk.pcm')
const dana = opt('dana.pcm')
let deskCursor = 0
const R = 24000
const at = (ms) => Math.round(((ms + lead) / 1000) * R)
const last = tape.events[tape.events.length - 1].t
const total = at(last + (tape.tail ?? 9000))
const out = new Float32Array(total)

let cursor = 0
const placed = [] // [start, end] of agent audio, for flushes
for (const e of tape.events) {
  if (e.msg?.type === 'reply.audio' && e.len) {
    const start = Math.max(cursor, at(e.t))
    const n = e.len / 2
    for (let i = 0; i < n && start + i < total; i++) out[start + i] += agent.readInt16LE(e.off + i * 2) / 32768
    cursor = start + n
    placed.push([start, cursor])
  } else if (e.msg?.type === 'reply.done' && e.msg.status === 'interrupted') {
    const cut = at(e.t)
    for (let i = cut; i < Math.min(cursor, total); i++) out[i] = 0
    cursor = Math.min(cursor, cut)
  } else if (e.dana && e.len) {
    const start = at(e.t)
    for (let i = 0; i < e.len / 2 && start + i < total; i++) out[start + i] += (dana.readInt16LE(e.off + i * 2) / 32768) * 0.95
  } else if (e.sam && e.len) {
    const start = at(e.t)
    const n = e.len / 2
    for (let i = 0; i < n && start + i < total; i++) out[start + i] += (sam.readInt16LE(e.off + i * 2) / 32768) * 0.95
  } else if (e.msg?.type === 'input.speech.stopped') {
    // The app's "heard you" tick: 880 Hz then 1320 Hz, 80 ms each.
    const start = at(e.t)
    for (const [f, dt] of [[880, 0], [1320, 0.06]]) {
      const s0 = start + Math.round(dt * R)
      for (let i = 0; i < 0.08 * R && s0 + i < total; i++) {
        const env = Math.min(1, i / 120) * Math.exp(-i / (0.03 * R))
        out[s0 + i] += Math.sin((2 * Math.PI * f * i) / R) * 0.06 * env
      }
    }
  }
}

// Second pass: the desk agent, on its own queue. Dana's desk and Sam's headset
// are different places, so where both agents talk at once the desk ducks.
const headsetOn = new Uint8Array(total)
for (const [a, b] of placed) headsetOn.fill(1, a, Math.min(b, total))
for (const e of tape.events) {
  if (e.desk?.type === 'reply.audio' && e.len) {
    const start = Math.max(deskCursor, at(e.t))
    const n = e.len / 2
    for (let i = 0; i < n && start + i < total; i++) out[start + i] += (desk.readInt16LE(e.off + i * 2) / 32768) * (headsetOn[start + i] ? 0.12 : 1)
    deskCursor = start + n
  } else if (e.desk?.type === 'reply.done' && e.desk.status === 'interrupted') {
    deskCursor = Math.min(deskCursor, at(e.t))
  }
}

const pcm = Buffer.alloc(total * 2)
for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767))), i * 2)
const raw = path.join(dir, 'mix.raw')
fs.writeFileSync(raw, pcm)
const ff = process.env.FFMPEG ?? `${process.env.HOME}/.local/bin/ffmpeg`
execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(R), '-ac', '1', '-i', raw, '-ar', '48000', '-ac', '2', path.join(dir, 'mix.wav')])
fs.rmSync(raw)
console.log(`mix.wav ${(total / R).toFixed(1)}s, ${placed.length} agent chunks`)
