import { useEffect, useRef } from 'react'
import type { Line, Snapshot, Walk } from '../sim/shift'
import type { AgentStatus } from '../voice/agent'
import {
  AISLES,
  BAYS,
  CROSS,
  FLOOR,
  LEVELS,
  PACK,
  RACK,
  bayX,
  pathLength,
  pointAt,
  rackY,
  walkY,
  type Pt,
} from '../sim/warehouse'

const STATUS_COLOR: Record<Line['status'], string> = {
  pending: '#8a909a',
  active: '#e4571e',
  picked: '#15803d',
  short: '#c27803',
  damaged: '#b42318',
  skipped: '#5e6470',
}

function posAt(walk: Walk, now: number): Pt {
  const t = walk.ms ? Math.min(1, (now - walk.start) / walk.ms) : 1
  // Ease in and out so the avatar reads as walking, not sliding.
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  return pointAt(walk.path, pathLength(walk.path) * e)
}

export function FloorMap({ s, agent }: { s: Snapshot; agent: AgentStatus }) {
  const pickerRef = useRef<SVGGElement>(null)
  const routeRef = useRef<SVGPolylineElement>(null)
  const walkRef = useRef(s.walk)
  walkRef.current = s.walk

  useEffect(() => {
    let raf = 0
    const frame = () => {
      const w = walkRef.current
      const now = Date.now()
      const p = posAt(w, now)
      pickerRef.current?.setAttribute('transform', `translate(${p.x} ${p.y})`)
      // Draw only the part of the route still ahead of the picker.
      const t = w.ms ? Math.min(1, (now - w.start) / w.ms) : 1
      if (routeRef.current) {
        if (t >= 1) routeRef.current.setAttribute('points', '')
        else {
          const ahead: Pt[] = [p]
          let acc = 0
          const total = pathLength(w.path)
          const done = total * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
          for (let i = 1; i < w.path.length; i++) {
            acc += Math.hypot(w.path[i].x - w.path[i - 1].x, w.path[i].y - w.path[i - 1].y)
            if (acc > done) ahead.push(w.path[i])
          }
          routeRef.current.setAttribute('points', ahead.map((q) => `${q.x},${q.y}`).join(' '))
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const pinFor = (l: Line) => ({ x: bayX(l.loc.bay), y: rackY(l.loc.aisle) + RACK.depth / 2 })

  return (
    <svg viewBox={`0 0 ${FLOOR.w} ${FLOOR.h}`} role="img" aria-label="Warehouse floor map">
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="#e3e7e0" strokeWidth="1" />
        </pattern>
        <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.4" floodColor="#16181d" floodOpacity="0.22" />
        </filter>
      </defs>
      <rect width={FLOOR.w} height={FLOOR.h} fill="#eef1ec" />
      <rect width={FLOOR.w} height={FLOOR.h} fill="url(#grid)" />

      {/* walkways */}
      <g stroke="#c4c9bf" strokeDasharray="6 7" strokeWidth="1.5" fill="none">
        {AISLES.map((a) => (
          <line key={a} x1={CROSS.left} x2={CROSS.right} y1={walkY(a)} y2={walkY(a)} />
        ))}
        <line x1={CROSS.left} x2={CROSS.left} y1={walkY('A') - 10} y2={PACK.y} />
        <line x1={CROSS.right} x2={CROSS.right} y1={walkY('A') - 10} y2={walkY('F')} />
      </g>

      {/* bay numbers */}
      <g fontFamily="var(--mono)" fontSize="10" fill="#8a909a" textAnchor="middle">
        {Array.from({ length: BAYS }, (_, i) => (
          <text key={i} x={bayX(i + 1)} y={rackY('A') - 8}>
            {String(i + 1).padStart(2, '0')}
          </text>
        ))}
      </g>

      {/* racks */}
      {AISLES.map((a) => (
        <g key={a}>
          <g transform={`translate(${RACK.x0 - 34} ${rackY(a) + RACK.depth / 2})`}>
            <circle r="13" fill="#1d2230" />
            <text textAnchor="middle" dy="4.5" fontSize="13" fontWeight="800" fill="#fff">
              {a}
            </text>
          </g>
          <rect x={RACK.x0 - 2} y={rackY(a) - 2} width={BAYS * RACK.bayW + 4} height={RACK.depth + 8} rx="5" fill="#d7dbd2" />
          {Array.from({ length: BAYS }, (_, i) => {
            const bay = i + 1
            const x = RACK.x0 + i * RACK.bayW
            return (
              <g key={bay}>
                <rect x={x + 1} y={rackY(a)} width={RACK.bayW - 2} height={RACK.depth} rx="4" fill="#f7f8f5" stroke="#dee1da" />
                {Array.from({ length: LEVELS }, (_, lv) => {
                  const slot = s.slots.get(`${a}-${String(bay).padStart(2, '0')}-${lv + 1}`)
                  const fill = slot ? Math.min(1, slot.onHand / 12) : 0
                  const w = (RACK.bayW - 14) * fill
                  return (
                    <rect
                      key={lv}
                      x={x + 7}
                      y={rackY(a) + 5 + lv * 8}
                      width={Math.max(2, w)}
                      height="5"
                      rx="1.5"
                      fill={slot ? `hsl(${slot.item.hue} 45% 62%)` : '#ccc'}
                      opacity={slot && slot.onHand ? 0.75 : 0.18}
                    />
                  )
                })}
              </g>
            )
          })}
        </g>
      ))}

      {/* pack station */}
      <g transform={`translate(${PACK.x - 44} ${PACK.y - 22})`}>
        <rect width="92" height="40" rx="8" fill="#fff" stroke="#c4c9bf" />
        <text x="46" y="17" textAnchor="middle" fontSize="10" fontWeight="700" fill="#5e6470" letterSpacing="0.08em">
          PACK
        </text>
        <text x="46" y="31" textAnchor="middle" fontSize="12" fontWeight="800" fill="#1d2230">
          STATION 3
        </text>
      </g>

      {/* route to the next pick */}
      <polyline ref={routeRef} fill="none" stroke="var(--route)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />

      {/* pick pins */}
      {s.lines.map((l, i) => {
        const p = pinFor(l)
        const color = STATUS_COLOR[l.status]
        const isActive = i === s.active
        return (
          <g key={l.id} transform={`translate(${p.x} ${p.y})`}>
            {isActive && (
              <circle r="16" fill="none" stroke={color} strokeWidth="2.5" opacity="0.6">
                <animate attributeName="r" values="12;22;12" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.7;0;0.7" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}
            <circle r={isActive ? 12 : 10} fill={color} stroke="#fff" strokeWidth="2.5" filter="url(#soft)" />
            <text textAnchor="middle" dy="4" fontSize={isActive ? 12 : 11} fontWeight="800" fill="#fff">
              {l.status === 'picked' ? '✓' : l.status === 'damaged' || l.status === 'skipped' ? '×' : l.rush ? '⚡' : i + 1}
            </text>
          </g>
        )
      })}

      {/* picker */}
      <g ref={pickerRef}>
        <ellipse cx="0" cy="15" rx="12" ry="4" fill="#16181d" opacity="0.15" />
        {agent === 'speaking' && (
          <circle r="20" fill="none" stroke="var(--brand)" strokeWidth="2" opacity="0.5">
            <animate attributeName="r" values="16;24;16" dur="0.9s" repeatCount="indefinite" />
          </circle>
        )}
        <circle r="14" fill="#fff" stroke="var(--brand)" strokeWidth="3" filter="url(#soft)" />
        <text textAnchor="middle" dy="5" fontSize="13" fontWeight="800" fill="#1d2230">
          S
        </text>
        {/* headset */}
        <path d="M-10 -4 A10 10 0 0 1 10 -4" fill="none" stroke="#1d2230" strokeWidth="2.5" />
        <rect x="-13" y="-6" width="5" height="8" rx="2" fill="#1d2230" />
        <rect x="8" y="-6" width="5" height="8" rx="2" fill="#1d2230" />
      </g>

    </svg>
  )
}
