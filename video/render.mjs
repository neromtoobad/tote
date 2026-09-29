// Render a recorded shift through the real app, frame-exact.
//   node render.mjs <tape> --stills 5,40,90      -> out/<tape>-still-<t>.png
//   node render.mjs <tape> [--from 0 --to 60] [--workers 6] [--fps 30]
//                                                -> out/<tape>.mp4 (with mix.wav if present)
// Needs the Vite dev server on :5178 (npm run dev). Each frame is a pure
// function of its index: renderFrame(n) advances the app's virtual clock.
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
const args = process.argv.slice(2)
const tape = args[0]
const arg = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const FPS = Number(arg('--fps', 30))
const BASE = arg('--base', 'http://localhost:5178')
const FF = process.env.FFMPEG ?? `${os.homedir()}/.local/bin/ffmpeg`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })

// The app fetches /replay/<tape>/tape.json; Vite serves public/.
const pub = path.join(here, '..', 'public', 'replay', tape)
fs.mkdirSync(pub, { recursive: true })
fs.copyFileSync(path.join(here, 'tapes', tape, 'tape.json'), path.join(pub, 'tape.json'))

async function open() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1.2 },
  })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('console', (m) => m.type() === 'error' && console.log('[page]', m.text()))
  await page.goto(`${BASE}/?replay=${tape}&fps=${FPS}${args.includes('--full') ? '&full=1' : ''}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.READY === true, { timeout: 30000 })
  await page.evaluate(() => document.fonts.ready)
  const total = await page.evaluate(() => window.TOTAL_FRAMES)
  return { browser, page, total }
}

async function shot(page, f) {
  await page.evaluate((n) => window.renderFrame(n), f)
  return page.screenshot({ type: 'png', optimizeForSpeed: true })
}

if (args.includes('--stills')) {
  const { browser, page } = await open()
  const times = arg('--stills', '0').split(',').map(Number).sort((a, b) => a - b)
  for (const t of times) {
    await page.evaluate((n) => window.renderFrame(n), Math.round(t * FPS))
    fs.writeFileSync(path.join(out, `${tape}-still-${t}${args.includes('--full') ? '-full' : ''}.png`), await page.screenshot({ type: 'png', fullPage: args.includes('--full') }))
  }
  console.log('stills in', out)
  await browser.close()
  process.exit(0)
}

const started = Date.now()
const probe = await open()
const from = Math.round(Number(arg('--from', 0)) * FPS)
const to = Math.min(probe.total, Math.round(Number(arg('--to', 1e9)) * FPS))
await probe.browser.close()
const workers = Number(arg('--workers', Math.max(2, Math.min(6, os.cpus().length - 2))))
const span = Math.ceil((to - from) / workers)
const segs = []
await Promise.all(
  Array.from({ length: workers }, async (_, w) => {
    const a = from + w * span
    const b = Math.min(to, a + span)
    if (a >= b) return
    const seg = path.join(out, `seg-${w}.mp4`)
    segs[w] = seg
    const { browser, page } = await open()
    const ff = spawn(FF, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-vf', 'scale=1920:1080:flags=lanczos', '-r', String(FPS), seg], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    for (let f = a; f < b; f++) {
      const buf = await shot(page, f)
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
      if ((f - a) % 300 === 0) console.log(`w${w} ${f - a}/${b - a} ${((Date.now() - started) / 1000).toFixed(0)}s`)
    }
    ff.stdin.end()
    await new Promise((r) => ff.on('close', r))
    await browser.close()
  }),
)
const list = path.join(out, 'segs.txt')
fs.writeFileSync(list, segs.filter(Boolean).map((s) => `file '${s}'`).join('\n'))
const file = path.join(out, arg('--out', `${tape}.mp4`))
const mix = path.join(here, 'tapes', tape, 'mix.wav')
const cat = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list]
if (fs.existsSync(mix)) cat.push('-ss', String(from / FPS), '-i', mix, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest')
else cat.push('-c', 'copy')
cat.push('-movflags', '+faststart', file)
await new Promise((r) => spawn(FF, cat, { stdio: 'inherit' }).on('close', r))
segs.forEach((s) => s && fs.rmSync(s))
fs.rmSync(list)
console.log(`wrote ${file} in ${((Date.now() - started) / 1000).toFixed(0)}s`)
process.exit(0)
