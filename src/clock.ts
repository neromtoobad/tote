// One clock for the whole app. Live, it is the real clock. In replay mode
// (the demo-video renderer) time only moves when renderFrame() advances it,
// so a recorded shift re-renders frame-exact, however long each frame takes.

type Timer = { at: number; fn: () => void; every?: number; id: number }

const virtual = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('replay')

let vNow = 1_800_000_000_000
let seq = 0
let timers: Timer[] = []
let frames: ((t: number) => void)[] = []

export const isVirtual = virtual

export function now() {
  return virtual ? vNow : Date.now()
}

export function later(fn: () => void, ms: number): () => void {
  if (!virtual) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  }
  const t: Timer = { at: vNow + Math.max(0, ms), fn, id: ++seq }
  timers.push(t)
  return () => (timers = timers.filter((x) => x !== t))
}

export function every(fn: () => void, ms: number): () => void {
  if (!virtual) {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  }
  const t: Timer = { at: vNow + ms, fn, every: ms, id: ++seq }
  timers.push(t)
  return () => (timers = timers.filter((x) => x !== t))
}

/** requestAnimationFrame, but virtual frames in replay mode. */
export function onFrame(fn: (t: number) => void): () => void {
  if (!virtual) {
    let raf = 0
    const loop = () => {
      fn(Date.now())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }
  frames.push(fn)
  return () => (frames = frames.filter((f) => f !== fn))
}

/** Replay only: run every timer due up to `to`, in order, then draw a frame. */
export function advanceTo(to: number) {
  for (;;) {
    let next: Timer | null = null
    for (const t of timers) if (t.at <= to && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t
    if (!next) break
    vNow = Math.max(vNow, next.at)
    if (next.every) next.at += next.every
    else timers = timers.filter((x) => x !== next)
    next.fn()
  }
  vNow = to
  for (const f of frames.slice()) f(vNow)
}

export function epoch() {
  return 1_800_000_000_000
}
