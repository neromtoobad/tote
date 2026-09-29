// Slides and video scenes from deck/index.html (served by Vite on :5178).
//   node deck.mjs pdf                 -> out/tote-deck.pdf + out/slide-<n>.png
//   node deck.mjs scene intro|tech|outro [--still 3.5]  -> out/scene-<name>.mp4
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = import.meta.dirname
const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })
const [mode, name] = process.argv.slice(2)
const FF = `${os.homedir()}/.local/bin/ffmpeg`
const BASE = 'http://localhost:5178/video/deck/index.html'
const FPS = 30

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

if (mode === 'pdf') {
  await page.goto(BASE, { waitUntil: 'networkidle0' })
  await page.evaluate(() => document.fonts.ready)
  await page.pdf({ path: path.join(out, 'tote-deck.pdf'), width: '1920px', height: '1080px', printBackground: true })
  const slides = await page.$$('.slide')
  for (let i = 0; i < slides.length; i++) await slides[i].screenshot({ path: path.join(out, `slide-${i + 1}.png`) })
  console.log(`deck: ${slides.length} slides → out/tote-deck.pdf`)
} else if (mode === 'scene') {
  await page.goto(`${BASE}?scene=${name}&fps=${FPS}`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.READY === true)
  const still = process.argv.indexOf('--still')
  if (still > 0) {
    const t = Number(process.argv[still + 1])
    await page.evaluate((n) => window.renderFrame(n), Math.round(t * FPS))
    await page.screenshot({ path: path.join(out, `scene-${name}-${t}.png`) })
  } else {
    const total = await page.evaluate(() => window.TOTAL_FRAMES)
    const file = path.join(out, `scene-${name}.mp4`)
    const ff = spawn(FF, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS), file], { stdio: ['pipe', 'inherit', 'inherit'] })
    for (let f = 0; f < total; f++) {
      await page.evaluate((n) => window.renderFrame(n), f)
      const buf = await page.screenshot({ type: 'png', optimizeForSpeed: true })
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    }
    ff.stdin.end()
    await new Promise((r) => ff.on('close', r))
    console.log(`scene ${name}: ${total} frames → ${file}`)
  }
}
await browser.close()
