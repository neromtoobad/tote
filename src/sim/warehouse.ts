// The demo warehouse: six rack rows (A–F), ten bays each, three levels per bay.
// Every slot carries a two-digit check number on its label; reading it back is
// how a picker proves they are standing at the right slot.

export const AISLES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export type Aisle = (typeof AISLES)[number]
export const BAYS = 10
export const LEVELS = 3

export type Loc = { aisle: Aisle; bay: number; level: number }

export const code = (l: Loc) => `${l.aisle}-${String(l.bay).padStart(2, '0')}-${l.level}`
export const spoken = (l: Loc) => `Aisle ${l.aisle}, bay ${l.bay}, level ${l.level}`

export type Item = { sku: string; name: string; hue: number }

export const ITEMS: Record<string, Item> = {
  espresso: { sku: '40117', name: 'Espresso beans', hue: 25 },
  mug: { sku: '40233', name: 'Sage ceramic mug', hue: 140 },
  case: { sku: '40308', name: 'Clear phone case', hue: 200 },
  yoga: { sku: '40412', name: 'Cork yoga mat', hue: 35 },
  socks: { sku: '40521', name: 'Trail running socks', hue: 280 },
  lamp: { sku: '40609', name: 'LED desk lamp', hue: 50 },
  speaker: { sku: '40714', name: 'Mini Bluetooth speaker', hue: 220 },
  mouse: { sku: '40826', name: 'Wireless mouse', hue: 0 },
  bottle: { sku: '40931', name: 'Steel water bottle', hue: 190 },
  notebook: { sku: '41045', name: 'Dotted notebook', hue: 330 },
  headlamp: { sku: '41152', name: 'Hiking headlamp', hue: 95 },
  matcha: { sku: '41260', name: 'Matcha tin', hue: 110 },
}

// Seeded so every rehearsal, video take and judge sees the same floor.
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = rng(1042)
const CHECK = new Map<string, string>()
for (const a of AISLES)
  for (let b = 1; b <= BAYS; b++)
    for (let l = 1; l <= LEVELS; l++) CHECK.set(`${a}-${String(b).padStart(2, '0')}-${l}`, String(10 + Math.floor(rand() * 90)))

export const checkDigits = (l: Loc) => CHECK.get(code(l))!

export type Slot = { loc: Loc; item: Item; onHand: number; damaged: number }

export type OrderLine = {
  id: string
  order: string
  loc: Loc
  item: Item
  qty: number
  rush?: boolean
}

const L = (aisle: Aisle, bay: number, level: number): Loc => ({ aisle, bay, level })

/** The shelf truth the picker sees on screen (and the agent never does). */
export function demoSlots(): Map<string, Slot> {
  const s = new Map<string, Slot>()
  const put = (loc: Loc, item: Item, onHand: number, damaged = 0) => s.set(code(loc), { loc, item, onHand, damaged })
  put(L('A', 3, 2), ITEMS.espresso, 9)
  put(L('B', 7, 1), ITEMS.mug, 3) // order wants 4: a short pick
  put(L('C', 2, 3), ITEMS.case, 14)
  put(L('D', 6, 2), ITEMS.yoga, 1, 1) // the only unit is crushed
  put(L('E', 9, 1), ITEMS.socks, 22)
  put(L('F', 4, 2), ITEMS.lamp, 6)
  put(L('D', 1, 1), ITEMS.speaker, 5)
  put(L('C', 8, 2), ITEMS.mouse, 11)
  // Filler stock so the racks look lived-in.
  const filler = Object.values(ITEMS)
  for (const a of AISLES)
    for (let b = 1; b <= BAYS; b++)
      for (let l = 1; l <= LEVELS; l++) {
        const loc = L(a, b, l)
        if (!s.has(code(loc))) put(loc, filler[Math.floor(rand() * filler.length)], Math.floor(rand() * 12))
      }
  return s
}

export function demoBatch(): OrderLine[] {
  return [
    { id: 'L1', order: 'SO-58210', loc: L('A', 3, 2), item: ITEMS.espresso, qty: 2 },
    { id: 'L2', order: 'SO-58210', loc: L('B', 7, 1), item: ITEMS.mug, qty: 4 },
    { id: 'L3', order: 'SO-58244', loc: L('C', 2, 3), item: ITEMS.case, qty: 1 },
    { id: 'L4', order: 'SO-58244', loc: L('D', 6, 2), item: ITEMS.yoga, qty: 1 },
    { id: 'L5', order: 'SO-58251', loc: L('E', 9, 1), item: ITEMS.socks, qty: 3 },
    { id: 'L6', order: 'SO-58251', loc: L('F', 4, 2), item: ITEMS.lamp, qty: 2 },
  ]
}

export function rushLines(): OrderLine[] {
  return [
    { id: 'R1', order: 'RUSH-7781', loc: L('D', 1, 1), item: ITEMS.speaker, qty: 1, rush: true },
    { id: 'R2', order: 'RUSH-7781', loc: L('C', 8, 2), item: ITEMS.mouse, qty: 2, rush: true },
  ]
}

// --- floor geometry (SVG units) ----------------------------------------------
export const FLOOR = { w: 1210, h: 640 }
/** Right-hand strip of the floor card where Sam's pose is staged. */
export const STAGE_X = 960
export const RACK = { x0: 170, bayW: 72, depth: 30, rowGap: 92, y0: 58 }
export const CROSS = { left: 110, right: 924 }
export const PACK = { x: 64, y: 604 }

export const rackY = (a: Aisle) => RACK.y0 + AISLES.indexOf(a) * RACK.rowGap
/** Walkway centre line in front (south) of a rack row. */
export const walkY = (a: Aisle) => rackY(a) + RACK.depth + 26
export const bayX = (bay: number) => RACK.x0 + (bay - 0.5) * RACK.bayW

export type Pt = { x: number; y: number }

export const standAt = (l: Loc): Pt => ({ x: bayX(l.bay), y: walkY(l.aisle) })

/** Manhattan route through the cross-aisles; racks are never walked through. */
export function route(from: Pt, to: Pt): Pt[] {
  if (Math.abs(from.y - to.y) < 1) return [from, to]
  const viaLeft = Math.abs(from.x - CROSS.left) + Math.abs(to.x - CROSS.left)
  const viaRight = Math.abs(from.x - CROSS.right) + Math.abs(to.x - CROSS.right)
  const cx = viaLeft <= viaRight ? CROSS.left : CROSS.right
  return [from, { x: cx, y: from.y }, { x: cx, y: to.y }, to]
}

export const pathLength = (pts: Pt[]) =>
  pts.slice(1).reduce((d, p, i) => d + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0)

export function pointAt(pts: Pt[], dist: number): Pt {
  let left = dist
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (left <= seg) {
      const f = seg ? left / seg : 1
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f }
    }
    left -= seg
  }
  return pts[pts.length - 1]
}
