// node shot.mjs <url> <out.png> [width] [height] [dpr]
import puppeteer from 'puppeteer-core'
const [url, out, w = 1600, h = 900, dpr = 1] = process.argv.slice(2)
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'], defaultViewport: { width: Number(w), height: Number(h), deviceScaleFactor: Number(dpr) } })
const p = await b.newPage()
await p.goto(url, { waitUntil: 'networkidle0' })
await p.evaluate(() => document.fonts.ready)
await new Promise((r) => setTimeout(r, 400))
await p.screenshot({ path: out, fullPage: true })
await b.close()
