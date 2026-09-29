// Stitch the demo video: intro scene → recorded shift → tech scene → outro.
//   node assemble.mjs <tape> [--demo-from s] [--demo-to s] [--cut a-b ...]
// Narration clips are placed at fixed offsets inside each scene.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
const out = path.join(here, 'out')
const FF = `${os.homedir()}/.local/bin/ffmpeg`
const args = process.argv.slice(2)
const tape = args[0]
const arg = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const cuts = args.flatMap((a, i) => (a === '--cut' ? [args[i + 1].split('-').map(Number)] : []))
const NARR = process.env.NARR ?? 'narration2'
const N = (i) => path.join(here, NARR, `n${i}.wav`)
const ff = (...a) => execFileSync(FF, ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' })
function probe(f) {
  try {
    execFileSync(FF, ['-i', f], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    const m = String(e.stderr).match(/Duration: (\d+):(\d+):([\d.]+)/)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  return 0
}
const FADE = 0.35
const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']

// A deck scene plus its narration lines at offsets (seconds).
function scene(name, lines) {
  const v = path.join(out, `scene-${name}.mp4`)
  const d = probe(v)
  const inputs = ['-i', v]
  lines.forEach(([i]) => inputs.push('-i', N(i)))
  const delays = lines.map(([, at], k) => `[${k + 1}:a]adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[n${k}]`).join(';')
  const mix = `${lines.map((_, k) => `[n${k}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad,atrim=0:${d},afade=t=in:d=${FADE},afade=t=out:st=${d - FADE}:d=${FADE}[a]`
  const vf = `[0:v]fade=t=in:d=${FADE},fade=t=out:st=${d - FADE}:d=${FADE}[v]`
  const file = path.join(out, `seg-${name}.mp4`)
  ff(...inputs, '-filter_complex', `${delays};${mix};${vf}`, '-map', '[v]', '-map', '[a]', ...ENC, '-t', String(d), file)
  return file
}

// The recorded shift, optionally with dead air cut out (--cut 170-228).
function demo() {
  const src = path.join(out, `${tape}.mp4`)
  const from = Number(arg('--demo-from', 0))
  const to = Number(arg('--demo-to', probe(src)))
  const keep = []
  let a = from
  for (const [c0, c1] of cuts.sort((x, y) => x[0] - y[0])) {
    keep.push([a, c0])
    a = c1
  }
  keep.push([a, to])
  const parts = keep.map(([s, e], k) => {
    const f = path.join(out, `demo-part-${k}.mp4`)
    const d = e - s
    ff('-ss', String(s), '-t', String(d), '-i', src, '-vf', `fade=t=in:d=${k ? 0.2 : FADE},fade=t=out:st=${d - (k === keep.length - 1 ? FADE : 0.2)}:d=${k === keep.length - 1 ? FADE : 0.2}`, '-af', `afade=t=in:d=0.15,afade=t=out:st=${d - 0.15}:d=0.15`, ...ENC, f)
    return f
  })
  return parts
}

const segs = [scene('intro', [[0, 2.2], [1, 10.0]]), ...demo(), scene('tech', [[2, 0.4], [3, 8.6], [4, 19.8]]), scene('outro', [[5, 0.6]])]
const list = path.join(out, 'final-list.txt')
fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n'))
const file = path.join(out, 'tote-demo.mp4')
ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file)
console.log('wrote', file, `${probe(file).toFixed(1)}s`)
