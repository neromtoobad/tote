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
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

type Tok = { n: number; digits: string }

function tokens(text: string, lang: LangKey): Tok[] {
  const words = text
    .toLowerCase()
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
