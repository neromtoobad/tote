import { now as clockNow, onFrame } from '../clock'
import { useEffect, useRef } from 'react'
import type { Line, Snapshot, Walk } from '../sim/shift'
import { poseFor, useNow } from './pose'
import type { AgentStatus } from '../voice/agent'
import {
  AISLES,
  BAYS,
  CROSS,
  FLOOR,
  LEVELS,
  PACK,
  RACK,
  STAGE_X,
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
  const flipRef = useRef<SVGGElement>(null)
  const lastX = useRef<number | null>(null)
  const now = useNow(500)
  const mapPose = poseFor(s, true, now)
  const routeRef = useRef<SVGPolylineElement>(null)
  const walkRef = useRef(s.walk)
  walkRef.current = s.walk

  useEffect(() => {
    const frame = () => {
      const w = walkRef.current
      const now = clockNow()
      const p = posAt(w, now)
      pickerRef.current?.setAttribute('transform', `translate(${p.x} ${p.y})`)
      // Face the direction of travel (the sprites face right).
      if (lastX.current !== null && Math.abs(p.x - lastX.current) > 0.3) {
        flipRef.current?.setAttribute('transform', p.x < lastX.current ? 'scale(-1 1)' : '')
      }
      lastX.current = p.x
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
    }
    return onFrame(frame)
  }, [])

  const active = s.lines[s.active] && (s.phase === 'travel' || s.phase === 'pick' || s.phase === 'paused') ? s.lines[s.active] : undefined
  const pinFor = (l: Line) => ({ x: bayX(l.loc.bay), y: rackY(l.loc.aisle) + RACK.depth / 2 })

  return (
    <svg viewBox={`0 0 ${FLOOR.w} ${FLOOR.h}`} role="img" aria-label="Warehouse floor map">
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="#e8ebe5" strokeWidth="1" />
        </pattern>
        <pattern id="hazard" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="16" height="16" fill="#fde8e6" />
          <rect width="7" height="16" fill="#f7b4ad" />
        </pattern>
        <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.4" floodColor="#16181d" floodOpacity="0.22" />
        </filter>
      </defs>
      <rect width={FLOOR.w} height={FLOOR.h} fill="#f1f3ef" />
      <rect width={STAGE_X} height={FLOOR.h} fill="url(#grid)" />

      <rect x={STAGE_X} y="0" width={FLOOR.w - STAGE_X} height={FLOOR.h} fill="#f7f8f5" />
      <line x1={STAGE_X} x2={STAGE_X} y1="0" y2={FLOOR.h} stroke="#dee1da" />

      {/* walkways */}
      <g stroke="#d3d8cf" strokeDasharray="3 7" strokeWidth="1.5" strokeLinecap="round" fill="none">
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

      {/* the aisle Sam is working, tinted so the eye lands there first */}
      {active && (
        <rect
          x={RACK.x0 - 52}
          y={rackY(active.loc.aisle) - 12}
          width={BAYS * RACK.bayW + 66}
          height={RACK.depth + 58}
          rx="14"
          fill="#fdeee6"
          opacity="0.75"
        />
      )}

      {/* racks: neutral bins, stock drawn as small cartons */}
      {AISLES.map((a) => (
        <g key={a}>
          <g transform={`translate(${RACK.x0 - 32} ${rackY(a) + RACK.depth / 2})`}>
            <rect x="-13" y="-13" width="26" height="26" rx="8" fill={active?.loc.aisle === a ? '#e4571e' : '#1d2230'} />
            <text textAnchor="middle" dy="4.5" fontSize="13" fontWeight="800" fill="#fff">
              {a}
            </text>
          </g>
          <rect x={RACK.x0 - 3} y={rackY(a) - 3} width={BAYS * RACK.bayW + 6} height={RACK.depth + 10} rx="7" fill="#dfe3da" />
          {Array.from({ length: BAYS }, (_, i) => {
            const bay = i + 1
            const x = RACK.x0 + i * RACK.bayW
            const isTarget = active?.loc.aisle === a && active.loc.bay === bay
            return (
              <g key={bay}>
                <rect x={x + 1.5} y={rackY(a)} width={RACK.bayW - 3} height={RACK.depth} rx="5" fill={isTarget ? '#fff' : '#fbfbf9'} stroke={isTarget ? '#e4571e' : '#e3e6df'} strokeWidth={isTarget ? 2 : 1} />
                <rect x={x + 1.5} y={rackY(a) + RACK.depth - 3} width={RACK.bayW - 3} height="3" rx="1.5" fill={isTarget ? '#f6b99c' : '#e6e9e2'} />
                {Array.from({ length: LEVELS }, (_, lv) => {
                  const slot = s.slots.get(`${a}-${String(bay).padStart(2, '0')}-${lv + 1}`)
                  const n = slot ? Math.min(5, Math.ceil(slot.onHand / 3)) : 0
                  const hot = isTarget && active!.loc.level === lv + 1
                  return Array.from({ length: n }, (_, k) => (
                    <rect key={`${lv}-${k}`} x={x + 8 + k * 11} y={rackY(a) + 4 + lv * 8} width="9" height="5.5" rx="1.5" fill={hot ? '#e4571e' : '#cfd5c9'} opacity={hot ? 1 : 0.9} />
                  ))
                })}
              </g>
            )
          })}
        </g>
      ))}

      {/* a reported hazard closes the aisle */}
      {s.hazard && (
        <g>
          <rect x={CROSS.left - 6} y={walkY(s.hazard.aisle) - 14} width={CROSS.right - CROSS.left + 12} height="28" rx="8" fill="url(#hazard)" opacity="0.9" />
          <g transform={`translate(${(CROSS.left + CROSS.right) / 2} ${walkY(s.hazard.aisle)})`}>
            <rect x="-92" y="-15" width="184" height="30" rx="15" fill="#b42318" filter="url(#soft)" />
            <text textAnchor="middle" dy="5" fontSize="13" fontWeight="800" fill="#fff" letterSpacing="0.04em">
              ⚠ {s.hazard.kind.toUpperCase()} · AISLE {s.hazard.aisle} CLOSED
            </text>
          </g>
        </g>
      )}

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
              {l.status === 'picked' ? '✓' : l.status === 'short' ? '!' : l.status === 'damaged' || l.status === 'skipped' ? '×' : l.rush ? '⚡' : i + 1}
            </text>
          </g>
        )
      })}

      {/* picker: the same 3D Sam, posed by state, walking the floor */}
      <g ref={pickerRef}>
        <ellipse cx="0" cy="2" rx="13" ry="4" fill="#16181d" opacity="0.18" />
        {agent === 'speaking' && (
          <ellipse cx="0" cy="2" rx="18" ry="6" fill="none" stroke="var(--brand)" strokeWidth="2" opacity="0.6">
            <animate attributeName="rx" values="14;22;14" dur="0.9s" repeatCount="indefinite" />
          </ellipse>
        )}
        <g ref={flipRef}>
          <image href={`/sam/${mapPose}.webp`} x={-19} y={-78} height="80" width="38" preserveAspectRatio="xMidYMax meet" />
        </g>
      </g>
    </svg>
  )
}
