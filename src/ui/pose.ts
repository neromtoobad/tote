import { every, now as clockNow } from '../clock'
import { useEffect, useState } from 'react'
import type { Snapshot } from '../sim/shift'

export type Pose = 'walk' | 'read' | 'lift' | 'damaged' | 'break' | 'done'

const EXCEPTION = new Set(['damaged', 'short', 'empty', 'wrong_item', 'mismatch'])

/** Every pose maps to something real in the shift, never decoration. */
export function poseFor(s: Snapshot, onMap = false, now = clockNow()): Pose {
  const last = s.log[s.log.length - 1]
  const lastAt = last && s.startedAt ? s.startedAt + last.t : 0
  if (last && EXCEPTION.has(last.kind) && now - lastAt < 4500) return 'damaged'
  switch (s.phase) {
    case 'travel':
      return s.arrivedAt ? 'read' : 'walk'
    case 'pick':
      return 'lift'
    case 'paused':
      return 'break'
    case 'complete':
    case 'ended':
      return s.walk.ms && now - s.walk.start < s.walk.ms ? 'walk' : 'done'
    default:
      return onMap ? 'done' : 'done'
  }
}

export const POSE_CAPTION: Record<Pose, string> = {
  walk: 'Walking to the slot',
  read: 'Reading the slot label',
  lift: 'Picking into the tote',
  damaged: 'Flagging a problem',
  break: 'On a break',
  done: 'Tote in hand',
}


/** Re-render on a clock, for poses that expire (exception flashes, arrivals). */
export function useNow(ms = 500) {
  const [now, setNow] = useState(() => clockNow())
  useEffect(() => {
    return every(() => setNow(clockNow()), ms)
  }, [ms])
  return now
}
