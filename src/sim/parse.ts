// Values come from the transcript, not from the model. The agent only picks
// the intent (which tool); these functions read the check digits and counts
// out of what Universal-3 Pro heard, so the LLM never produces a digit.

import type { LangKey } from './shift.ts'

const UNITS: Record<LangKey, string[]> = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
  fr: ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'],
  it: ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'],
  pt: ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'],
}
const EXTRA: Record<string, number> = {
  oh: 0,
  o: 0,
  ten: 10,
  eleven: 11,
  twelve: 12,
  una: 1,
  ein: 1,
  eine: 1,
  zwo: 2,
  une: 1,
  uma: 1,
  duas: 2,
  diez: 10,
  zehn: 10,
  dix: 10,
  dieci: 10,
  dez: 10,
}
// Sound-alikes a recognizer produces for spoken digits, per language. Pickers
// code-switch too, so English number words count in every language.
const HOMOPHONES: Record<LangKey, Record<string, number>> = {
  en: { to: 2, too: 2, for: 4, fore: 4, ate: 8, won: 1, tree: 3, free: 3, nein: 9 },
  es: { do: 2, dose: 2, sei: 6, sais: 6, see: 7, nuebe: 9 },
  de: { zwo: 2, dry: 3, fear: 4, fier: 4, fin: 5, sex: 6, zeks: 6, zieben: 7, nine: 9 },
  fr: { set: 7, cet: 7, cette: 7, cest: 7, sette: 7, deu: 2, cat: 4, sank: 5, sink: 5, cis: 6, wheat: 8, nerf: 9 },
  it: { tray: 3, say: 6, set: 7, sette: 7, oto: 8, cuattro: 4, cuatro: 4, quatro: 4, nove: 9 },
  pt: { doys: 2, tres: 3, tris: 3, sayis: 6, size: 6, says: 6, sais: 6, set: 7, sete: 7, sede: 7, noví: 9 },
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

type Tok = { n: number; digits: string }

// "ottocuattro" → ["otto", "cuattro"]: recognizers sometimes glue two spoken
// digits into one word. Split only when every piece is a number word.
function split(word: string, lang: LangKey): number[] | null {
  const dict = new Map<string, number>()
  UNITS[lang].forEach((w, i) => dict.set(w, i))
  UNITS.en.forEach((w, i) => dict.set(w, i))
  for (const [w, n] of Object.entries(HOMOPHONES[lang])) if (w.length > 2) dict.set(w, n)
  const memo = new Map<number, number[] | null>()
  const go = (i: number): number[] | null => {
    if (i === word.length) return []
    if (memo.has(i)) return memo.get(i)!
    let best: number[] | null = null
    for (const [w, n] of dict) {
      if (w.length >= 3 && word.startsWith(w, i)) {
        const rest = go(i + w.length)
        if (rest) {
          best = [n, ...rest]
          break
        }
      }
    }
    memo.set(i, best)
    return best
  }
  const r = go(0)
  return r && r.length >= 2 ? r : null
}

function tokens(text: string, lang: LangKey): Tok[] {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
  const units = UNITS[lang]
  const out: Tok[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (/^\d+$/.test(w)) {
      out.push({ n: Number(w), digits: w })
      continue
    }
    if (w in TENS) {
      const next = words[i + 1]
      const u = next ? units.indexOf(next) : -1
      if (u > 0) {
        out.push({ n: TENS[w] + u, digits: String(TENS[w] + u) })
        i++
      } else out.push({ n: TENS[w], digits: String(TENS[w]) })
      continue
    }
    const u = units.indexOf(w)
    if (u >= 0) {
      out.push({ n: u, digits: String(u) })
      continue
    }
    const en = UNITS.en.indexOf(w)
    const h = HOMOPHONES[lang][w] ?? (en >= 0 ? en : undefined)
    // A lone homophone like "to"/"de"/"set" only counts inside a run of numbers.
    const parts = w.length >= 6 ? split(w, lang) : null
    if (parts) {
      for (const n of parts) out.push({ n, digits: String(n) })
      continue
    }
    const numberish = (w2?: string) => !!w2 && (/^\d/.test(w2) || UNITS[lang].includes(w2) || UNITS.en.includes(w2) || w2 in HOMOPHONES[lang])
    if (h !== undefined && (en >= 0 || out.length || numberish(words[i + 1]) || numberish(words[i + 2]))) {
      out.push({ n: h, digits: String(h) })
      continue
    }
    // Only treat "o"/"oh" as zero inside a run of numbers ("four oh").
    if (w in EXTRA && !((w === 'o' || w === 'oh') && !out.length)) out.push({ n: EXTRA[w], digits: String(EXTRA[w]) })
  }
  return out
}

/** "7, 6." / "seven six" / "seventy-six" / "four oh" → "76" / "40". The last `keep` digits heard win. */
export function extractDigits(text: string, lang: LangKey, keep = 2): string {
  const all = tokens(text, lang)
    .map((t) => t.digits)
    .join('')
  return all.slice(-keep)
}

/** "Only 3 here" / "only three" / "picked two" → the number; null when none was said. */
export function extractCount(text: string, lang: LangKey): number | null {
  const toks = tokens(text, lang)
  return toks.length ? toks[toks.length - 1].n : null
}

export function mentions(text: string, words: string[]) {
  const t = text.toLowerCase()
  return words.some((w) => t.includes(w))
}
