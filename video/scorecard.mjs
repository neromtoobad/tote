// Merge video/scorecard/*.json (written by scripts/drive.ts) into all.json for
// the deck, and print the README table.   node video/scorecard.mjs
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, 'scorecard')
const order = ['en', 'es', 'de', 'fr', 'it', 'pt']
const rows = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith('score-') && f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .sort((a, b) => Number(a.noisy) - Number(b.noisy) || order.indexOf(a.language) - order.indexOf(b.language))
fs.writeFileSync(path.join(dir, 'all.json'), JSON.stringify(rows, null, 2))

const name = { en: 'English', es: 'Spanish', de: 'German', fr: 'French', it: 'Italian', pt: 'Portuguese' }
console.log('| Run | Lines right | Misread check digit | Guard corrections | Speech end → voice (p50 / p95) | First verified pick |')
console.log('| - | - | - | - | - | - |')
for (const r of rows)
  console.log(
    `| ${name[r.language]}${r.noisy ? ', noisy floor' : ''} | ${r.lines_correct}/${r.lines_total} | ${r.wrong_slot_rejected ? 'rejected' : 'not accepted, re-asked'} | ${r.guard_corrections} | ${(r.latency_p50_ms / 1000).toFixed(2)} s / ${(r.latency_p95_ms / 1000).toFixed(2)} s | ${r.first_verified_pick_s ?? '—'} s |`,
  )
const n = rows.length
const lines = rows.reduce((a, r) => a + r.lines_correct, 0)
console.log(`\n${n} runs, ${lines}/${rows.reduce((a, r) => a + r.lines_total, 0)} lines right; no run verified a slot on the misread digits.`)
