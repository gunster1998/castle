import type { GameState, Unit, UnitTypeDef, Team } from './types'
import { UNIT_TYPES, BUILDING_TYPES, GRID_XS, GRID_YS, GRID_CELL, WORLD_W, WORLD_H } from './data'

// ── Scale / perspective ─────────────────────────────────────────────────────
//
// We treat the playing field as a tilted ground plane. The top of the lane is
// "farther", the bottom is "closer". Points are squeezed horizontally toward a
// vanishing centre as they move up, giving the scene an angled, pseudo-3D look
// without a full 3D engine.

let SX = 1, SY = 1

const HORIZON_Y  = 180              // world Y of the vanishing point
const GROUND_Y   = 720              // world Y of "nearest" ground
const VP_X       = WORLD_W / 2      // vanishing X (centre)
const FAR_SCALE  = 0.60             // horizontal squeeze at the horizon
const NEAR_SCALE = 1.0              // horizontal squeeze at the foreground

function depthT(y: number) {
  const t = (y - HORIZON_Y) / (GROUND_Y - HORIZON_Y)
  return Math.max(0, Math.min(1, t))
}
function depthScale(y: number) {
  return FAR_SCALE + (NEAR_SCALE - FAR_SCALE) * depthT(y)
}

export function project(x: number, y: number): { sx: number; sy: number; scale: number } {
  const s = depthScale(y)
  const px = VP_X + (x - VP_X) * s
  return { sx: px * SX, sy: y * SY, scale: s }
}

// Screen → world inverse of project()
export function unproject(screenX: number, screenY: number, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const sx = (screenX - rect.left) / rect.width  * canvas.width
  const sy = (screenY - rect.top)  / rect.height * canvas.height
  const y  = sy / SY
  const s  = depthScale(y)
  const x  = VP_X + (sx / SX - VP_X) / s
  return { x, y }
}

export function initRenderer(canvas: HTMLCanvasElement) {
  resize(canvas)
  window.addEventListener('resize', () => resize(canvas))
}

function resize(canvas: HTMLCanvasElement) {
  const maxW = window.innerWidth
  const maxH = window.innerHeight - 130
  const aspect = WORLD_W / WORLD_H
  let w = maxW, h = w / aspect
  if (h > maxH) { h = maxH; w = h * aspect }
  canvas.width  = Math.floor(w)
  canvas.height = Math.floor(h)
  SX = w / WORLD_W
  SY = h / WORLD_H
}

// ── Floating damage / heal numbers ──────────────────────────────────────────

interface FloatEffect {
  x: number; y: number
  text: string; color: string
  ttl: number; maxTtl: number
  vy: number
}
const effects: FloatEffect[] = []
const prevHp = new Map<string, number>()

// ── Projectile system (client-only, reconstructed from attackCooldown edges) ─

type ProjType = 'arrow' | 'bullet' | 'shell' | 'orb' | 'beam'

interface Projectile {
  x0: number; y0: number
  x1: number; y1: number
  t: number; dur: number
  type: ProjType
  color: string
  arc: number
}

const projectiles: Projectile[] = []
const prevCooldown = new Map<string, number>()

// ── Attack-driven projectile spawn ───────────────────────────────────────────

export function updateEffects(state: GameState) {
  const ids = new Set<string>()

  for (const u of state.units) {
    ids.add(u.id)

    // HP delta → floating number
    const oldHp = prevHp.get(u.id)
    if (oldHp !== undefined) {
      const diff = u.hp - oldHp
      if (diff < 0) {
        effects.push({
          x: u.x + (Math.random() - .5) * 28,
          y: u.y - 14,
          text: String(-Math.round(diff)),
          color: '#ff5555',
          ttl: 42, maxTtl: 42, vy: -0.8,
        })
      } else if (diff > 0) {
        effects.push({
          x: u.x + (Math.random() - .5) * 18,
          y: u.y - 14,
          text: `+${Math.round(diff)}`,
          color: '#44ff88',
          ttl: 38, maxTtl: 38, vy: -0.6,
        })
      }
    }
    prevHp.set(u.id, u.hp)

    // Attack edge: cooldown went from 0 to a positive value → unit just fired
    const prevCd = prevCooldown.get(u.id) ?? 0
    if (prevCd === 0 && u.attackCooldown > 0) {
      spawnProjectileFor(u, state)
    }
    prevCooldown.set(u.id, u.attackCooldown)
  }

  // Cleanup maps for removed units
  for (const id of prevHp.keys())       if (!ids.has(id)) prevHp.delete(id)
  for (const id of prevCooldown.keys()) if (!ids.has(id)) prevCooldown.delete(id)
}

function spawnProjectileFor(u: Unit, state: GameState) {
  const utype = UNIT_TYPES[u.typeId]
  // Melee units: skip — they don't need projectiles
  if (utype.range < 70) return

  // Pick target: priest heals allies, everyone else hits enemies
  const isHealer = u.typeId === 'priest'
  let target: Unit | null = null
  let best = Infinity
  for (const o of state.units) {
    if (o.id === u.id) continue
    if (isHealer) {
      if (o.team !== u.team) continue
      if (o.hp >= o.maxHp) continue
    } else {
      if (o.team === u.team) continue
    }
    const d = Math.hypot(o.x - u.x, o.y - u.y)
    if (d <= utype.range * 1.15 && d < best) { best = d; target = o }
  }
  if (!target) return

  const cfg = projectileConfig(u.typeId)
  projectiles.push({
    x0: u.x, y0: u.y - 8,
    x1: target.x, y1: target.y - 8,
    t: 0, dur: cfg.dur,
    type: cfg.type, color: cfg.color, arc: cfg.arc,
  })
}

function projectileConfig(typeId: string): { type: ProjType; color: string; arc: number; dur: number } {
  switch (typeId) {
    case 'mortar':      return { type: 'shell',  color: '#ffaa44', arc: 120, dur: 32 }
    case 'rifleman':    return { type: 'bullet', color: '#fff0aa', arc: 3,   dur: 7  }
    case 'crypt_fiend': return { type: 'arrow',  color: '#aaff88', arc: 35,  dur: 20 }
    case 'priest':      return { type: 'beam',   color: '#e0f8ff', arc: 0,   dur: 10 }
    case 'necromancer': return { type: 'orb',    color: '#cc88ff', arc: 25,  dur: 22 }
    default:            return { type: 'arrow',  color: '#ffe080', arc: 25,  dur: 20 }
  }
}

function tickEffects() {
  for (const e of effects)     { e.y += e.vy; e.ttl-- }
  for (let i = effects.length - 1; i >= 0; i--)
    if (effects[i].ttl <= 0) effects.splice(i, 1)

  for (const p of projectiles) p.t += 1 / p.dur
  for (let i = projectiles.length - 1; i >= 0; i--)
    if (projectiles[i].t >= 1) projectiles.splice(i, 1)
}

// ── Main render ──────────────────────────────────────────────────────────────

export function render(
  canvas: HTMLCanvasElement,
  state: GameState,
  _myId: string,
  myTeam: Team,
  _selectedBuilding: string | null,
  hoveredCell: { gx: number; gy: number } | null,
) {
  tickEffects()
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height

  drawBackground(ctx, W, H)
  drawGroundPlane(ctx)
  drawBaseZones(ctx)
  drawLane(ctx)
  drawGrid(ctx, state, myTeam, hoveredCell)
  drawCastles(ctx, state)

  // Painter's algorithm: sort buildings + units + projectiles by world Y
  // (deeper first) so near entities overlap far ones correctly.
  interface Drawable { y: number; draw: () => void }
  const entities: Drawable[] = []

  for (const b of state.buildings) {
    entities.push({ y: b.y, draw: () => drawBuilding(ctx, b) })
  }
  for (const u of state.units) {
    entities.push({ y: u.y, draw: () => drawUnit(ctx, u) })
  }
  entities.sort((a, b) => a.y - b.y)
  for (const e of entities) e.draw()

  drawProjectiles(ctx)
  drawFloatingEffects(ctx)
  drawHUD(ctx, state, W, H)
}

// ── Background & ground ──────────────────────────────────────────────────────

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#06061a')
  sky.addColorStop(0.4, '#0d0d28')
  sky.addColorStop(1, '#1a1020')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)

  // Stars — only in the sky area (above horizon)
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  for (let i = 0; i < 70; i++) {
    const sx = ((i * 137.5) % WORLD_W) * SX
    const sy = ((i * 73.1) % (HORIZON_Y * 0.95)) * SY
    const sr = 0.5 + (i % 3) * 0.4
    ctx.beginPath()
    ctx.arc(sx, sy, sr, 0, Math.PI * 2)
    ctx.fill()
  }

  // Distant mountain silhouette along the horizon
  ctx.fillStyle = '#0a0a18'
  ctx.beginPath()
  const hy = HORIZON_Y * SY
  ctx.moveTo(0, hy)
  for (let i = 0; i <= 20; i++) {
    const x = (i / 20) * W
    const bump = Math.sin(i * 1.3) * 8 + Math.sin(i * 0.7) * 14
    ctx.lineTo(x, hy - 18 - Math.abs(bump))
  }
  ctx.lineTo(W, hy)
  ctx.closePath()
  ctx.fill()
}

function drawGroundPlane(ctx: CanvasRenderingContext2D) {
  // A tilted ground spanning from horizon → bottom, shaded darker at the horizon
  const topY = HORIZON_Y
  const botY = WORLD_H
  const tl = project(-200, topY), tr = project(WORLD_W + 200, topY)
  const bl = project(-400, botY), br = project(WORLD_W + 400, botY)

  const grad = ctx.createLinearGradient(0, tl.sy, 0, bl.sy)
  grad.addColorStop(0, '#0a0a1c')
  grad.addColorStop(1, '#14142a')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.moveTo(tl.sx, tl.sy)
  ctx.lineTo(tr.sx, tr.sy)
  ctx.lineTo(br.sx, br.sy)
  ctx.lineTo(bl.sx, bl.sy)
  ctx.closePath()
  ctx.fill()
}

function drawBaseZones(ctx: CanvasRenderingContext2D) {
  // West side glow (blue), East side glow (red) projected onto the ground
  projQuadFill(ctx, [
    [0,   HORIZON_Y], [520, HORIZON_Y],
    [520, WORLD_H],   [0,   WORLD_H],
  ], (g) => {
    g.addColorStop(0, 'rgba(30,70,200,0.35)')
    g.addColorStop(1, 'rgba(30,70,200,0)')
  }, 'h')

  projQuadFill(ctx, [
    [1080, HORIZON_Y], [WORLD_W, HORIZON_Y],
    [WORLD_W, WORLD_H], [1080,    WORLD_H],
  ], (g) => {
    g.addColorStop(0, 'rgba(200,40,40,0)')
    g.addColorStop(1, 'rgba(200,40,40,0.35)')
  }, 'h')
}

function projQuadFill(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  paint: (g: CanvasGradient) => void,
  dir: 'h' | 'v',
) {
  const proj = pts.map(([x, y]) => project(x, y))
  const xs = proj.map(p => p.sx), ys = proj.map(p => p.sy)
  const grad = dir === 'h'
    ? ctx.createLinearGradient(Math.min(...xs), 0, Math.max(...xs), 0)
    : ctx.createLinearGradient(0, Math.min(...ys), 0, Math.max(...ys))
  paint(grad)
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.moveTo(proj[0].sx, proj[0].sy)
  for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i].sx, proj[i].sy)
  ctx.closePath()
  ctx.fill()
}

// ── Lane ─────────────────────────────────────────────────────────────────────

const LANE_TOP = 285, LANE_BOT = 515
const LANE_X0  = 80,  LANE_X1  = 1520

function drawLane(ctx: CanvasRenderingContext2D) {
  const tl = project(LANE_X0, LANE_TOP), tr = project(LANE_X1, LANE_TOP)
  const bl = project(LANE_X0, LANE_BOT), br = project(LANE_X1, LANE_BOT)

  // Base fill (trapezoid)
  ctx.fillStyle = '#1e1a12'
  ctx.beginPath()
  ctx.moveTo(tl.sx, tl.sy); ctx.lineTo(tr.sx, tr.sy)
  ctx.lineTo(br.sx, br.sy); ctx.lineTo(bl.sx, bl.sy)
  ctx.closePath(); ctx.fill()

  // Cobblestone rows (horizontal bands at constant world-Y, each projected)
  const rows = 11, cols = 28
  for (let r = 0; r < rows; r++) {
    const y0 = LANE_TOP + (r     / rows) * (LANE_BOT - LANE_TOP)
    const y1 = LANE_TOP + ((r+1) / rows) * (LANE_BOT - LANE_TOP)
    for (let c = 0; c < cols; c++) {
      const x0 = LANE_X0 + (c     / cols) * (LANE_X1 - LANE_X0) + (r % 2 ? 8 : 0)
      const x1 = LANE_X0 + ((c+1) / cols) * (LANE_X1 - LANE_X0) + (r % 2 ? 8 : 0)
      const p0 = project(x0, y0), p1 = project(x1, y0)
      const p2 = project(x1, y1), p3 = project(x0, y1)
      ctx.fillStyle = ((r + c) % 3 === 0) ? '#262018' : '#1a160f'
      ctx.beginPath()
      ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy)
      ctx.lineTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy)
      ctx.closePath(); ctx.fill()
    }
  }

  // Outline
  ctx.strokeStyle = '#3a3020'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(tl.sx, tl.sy); ctx.lineTo(tr.sx, tr.sy)
  ctx.lineTo(br.sx, br.sy); ctx.lineTo(bl.sx, bl.sy)
  ctx.closePath(); ctx.stroke()

  // Centre dashed line (also receding with perspective)
  ctx.save()
  ctx.setLineDash([14, 10])
  ctx.strokeStyle = 'rgba(255,230,100,0.14)'
  ctx.lineWidth = 1.5
  const cl = project(LANE_X0, 400), cr = project(LANE_X1, 400)
  ctx.beginPath()
  ctx.moveTo(cl.sx, cl.sy)
  ctx.lineTo(cr.sx, cr.sy)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

// ── Grid ─────────────────────────────────────────────────────────────────────

function drawGrid(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  myTeam: Team,
  hoveredCell: { gx: number; gy: number } | null,
) {
  const half = GRID_CELL * 0.44

  for (const team of ['west', 'east'] as Team[]) {
    const xs = GRID_XS[team]
    for (let gx = 0; gx < 4; gx++) {
      for (let gy = 0; gy < 4; gy++) {
        const cx = xs[gx], cy = GRID_YS[gy]
        const occupied = state.buildings.some(b => b.team === team && b.gridX === gx && b.gridY === gy)
        if (occupied) continue

        const isHovered = team === myTeam && hoveredCell?.gx === gx && hoveredCell?.gy === gy
        const isOwn     = team === myTeam

        // Corners in world space, projected
        const tl = project(cx - half, cy - half)
        const tr = project(cx + half, cy - half)
        const br = project(cx + half, cy + half)
        const bl = project(cx - half, cy + half)

        ctx.fillStyle = isHovered
          ? (team === 'west' ? 'rgba(60,120,255,0.26)' : 'rgba(255,60,60,0.26)')
          : (isOwn ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.012)')
        ctx.strokeStyle = isHovered
          ? (team === 'west' ? 'rgba(90,160,255,0.95)' : 'rgba(255,90,90,0.95)')
          : (team === 'west' ? 'rgba(60,110,210,0.3)'  : 'rgba(210,60,60,0.3)')
        ctx.lineWidth = isHovered ? 2 : 1

        ctx.beginPath()
        ctx.moveTo(tl.sx, tl.sy); ctx.lineTo(tr.sx, tr.sy)
        ctx.lineTo(br.sx, br.sy); ctx.lineTo(bl.sx, bl.sy)
        ctx.closePath()
        ctx.fill(); ctx.stroke()

        if (isOwn && !isHovered) {
          const cp = project(cx, cy)
          ctx.strokeStyle = team === 'west' ? 'rgba(80,120,210,0.28)' : 'rgba(210,80,80,0.28)'
          ctx.lineWidth = 1.3
          ctx.beginPath()
          ctx.moveTo(cp.sx - 6, cp.sy); ctx.lineTo(cp.sx + 6, cp.sy)
          ctx.moveTo(cp.sx, cp.sy - 6); ctx.lineTo(cp.sx, cp.sy + 6)
          ctx.stroke()
        }
      }
    }
  }
}

// ── Castles ──────────────────────────────────────────────────────────────────

function drawCastles(ctx: CanvasRenderingContext2D, state: GameState) {
  drawCastle(ctx, state.castles.west, 'west')
  drawCastle(ctx, state.castles.east, 'east')
}

function drawCastle(
  ctx: CanvasRenderingContext2D,
  castle: { hp: number; maxHp: number },
  team: Team,
) {
  const isWest = team === 'west'
  const baseX  = isWest ? 65 : 1535
  const baseY  = 420

  const p = project(baseX, baseY)
  const s = p.scale
  const W = 110 * SX * s
  const H = 220 * SY * s
  const cx = p.sx
  const cyBottom = p.sy
  const y = cyBottom - H

  const mainColor   = isWest ? '#1a3a8a' : '#8a1a1a'
  const wallColor   = isWest ? '#1e4599' : '#991e1e'
  const towerColor  = isWest ? '#162e70' : '#701616'
  const borderColor = isWest ? '#4488ff' : '#ff4444'

  ctx.shadowColor = isWest ? '#2244cc' : '#cc2222'
  ctx.shadowBlur  = 22 * s

  // Side towers
  const tw = 24 * SX * s, th = H * 1.1
  const tx1 = cx - W / 2 - tw * 0.4
  const tx2 = cx + W / 2 - tw * 0.6
  const ty  = cyBottom - th

  for (const tx of [tx1, tx2]) {
    ctx.fillStyle = towerColor
    roundRect(ctx, tx, ty, tw, th, 3); ctx.fill()
    ctx.strokeStyle = borderColor; ctx.lineWidth = 1.5; ctx.stroke()
    // Battlements
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = towerColor
      ctx.fillRect(tx + i * (tw / 3), ty - 13 * s, tw / 3 - 2, 13 * s)
    }
    // Arrow slit
    ctx.fillStyle = 'rgba(255,240,120,0.8)'
    ctx.fillRect(tx + tw * 0.35, ty + th * 0.35, tw * 0.3, th * 0.12)
  }

  // Main keep
  ctx.fillStyle = mainColor
  roundRect(ctx, cx - W / 2, y, W, H, 4); ctx.fill()
  ctx.strokeStyle = borderColor; ctx.lineWidth = 2; ctx.stroke()

  // Windows
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 3; j++) {
      ctx.fillRect(cx - W * 0.22 + i * W * 0.44 - 5, y + H * 0.18 + j * H * 0.25, 10 * s, 14 * s)
    }
  }

  // Top battlements
  ctx.fillStyle = wallColor
  const bw = W / 5
  for (let i = 0; i < 4; i++) {
    if (i % 2 === 0) ctx.fillRect(cx - W / 2 + i * bw, y - 14 * s, bw - 2, 14 * s)
  }

  // Flag
  const flagX = cx, flagY = y - 34 * s
  ctx.strokeStyle = borderColor; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(flagX, flagY); ctx.lineTo(flagX, flagY + 30 * s); ctx.stroke()
  ctx.fillStyle = isWest ? '#4488ff' : '#ff4444'
  ctx.beginPath()
  ctx.moveTo(flagX, flagY)
  ctx.lineTo(flagX + (isWest ? 18 * s : -18 * s), flagY + 8 * s)
  ctx.lineTo(flagX, flagY + 16 * s)
  ctx.closePath(); ctx.fill()

  ctx.shadowBlur = 0

  // HP bar below the base
  const hpRatio = Math.max(0, castle.hp / castle.maxHp)
  const barW = W + tw
  const barX = cx - barW / 2
  const barY = cyBottom + 8

  ctx.fillStyle = 'rgba(0,0,0,0.75)'
  roundRect(ctx, barX, barY, barW, 14, 3); ctx.fill()

  const hpGrad = ctx.createLinearGradient(barX, 0, barX + barW * hpRatio, 0)
  hpGrad.addColorStop(0, hpColor(hpRatio))
  hpGrad.addColorStop(1, lighten(hpColor(hpRatio), 30))
  ctx.fillStyle = hpGrad
  roundRect(ctx, barX + 1, barY + 1, (barW - 2) * hpRatio, 12, 2); ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 11px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`${Math.max(0, castle.hp)}`, cx, barY + 11)
}

// ── Buildings ────────────────────────────────────────────────────────────────

function drawBuilding(ctx: CanvasRenderingContext2D, b: GameState['buildings'][number]) {
  const btype = BUILDING_TYPES[b.typeId]
  const p = project(b.x, b.y)
  const s = p.scale
  const cs = GRID_CELL * 0.82 * SX * s
  const ch = cs * 1.05    // a tad taller to suggest depth
  const cx = p.sx, cyBottom = p.sy + cs * 0.15

  // Shadow on the ground (elongated ellipse)
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.beginPath()
  ctx.ellipse(cx + 3, cyBottom + 3, cs * 0.55, cs * 0.18, 0, 0, Math.PI * 2)
  ctx.fill()

  // Body block
  const yTop = cyBottom - ch
  ctx.shadowColor = btype.color
  ctx.shadowBlur  = 10 * s

  const grad = ctx.createLinearGradient(cx - cs / 2, yTop, cx + cs / 2, cyBottom)
  grad.addColorStop(0, lighten(btype.color, 28))
  grad.addColorStop(1, btype.color)
  ctx.fillStyle = grad
  roundRect(ctx, cx - cs / 2, yTop, cs, ch, 6)
  ctx.fill()

  ctx.strokeStyle = b.team === 'west' ? '#88aaff' : '#ff8888'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.shadowBlur = 0

  drawBuildingIcon(ctx, b.typeId, cx, yTop + ch / 2, cs, s)

  // Spawn timer (bottom)
  const prog = 1 - b.spawnTimer / BUILDING_TYPES[b.typeId].spawnInterval
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(cx - cs / 2, cyBottom - 7, cs, 7)
  const spawnGrad = ctx.createLinearGradient(cx - cs / 2, 0, cx - cs / 2 + cs * prog, 0)
  spawnGrad.addColorStop(0, '#33cc33')
  spawnGrad.addColorStop(1, '#88ff44')
  ctx.fillStyle = spawnGrad
  ctx.fillRect(cx - cs / 2, cyBottom - 7, cs * prog, 7)

  // HP bar (top)
  const hpR = b.hp / b.maxHp
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(cx - cs / 2, yTop - 9, cs, 6)
  ctx.fillStyle = hpColor(hpR)
  ctx.fillRect(cx - cs / 2, yTop - 9, cs * hpR, 6)

  // Label
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.max(8, 9 * s)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(btype.name, cx, cyBottom - 11)
}

function drawBuildingIcon(
  ctx: CanvasRenderingContext2D,
  typeId: string, cx: number, cy: number, cs: number, s: number,
) {
  const r = cs * 0.3
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 1.2

  switch (typeId) {
    case 'barracks': {
      ctx.beginPath()
      ctx.moveTo(cx, cy - r - 10 * s); ctx.lineTo(cx + r, cy - 3 * s)
      ctx.lineTo(cx + r * 0.6, cy + r * 0.5); ctx.lineTo(cx, cy + r + 3 * s)
      ctx.lineTo(cx - r * 0.6, cy + r * 0.5); ctx.lineTo(cx - r, cy - 3 * s)
      ctx.closePath(); ctx.fill(); ctx.stroke()
      break
    }
    case 'rifle_range':
    case 'spider_lair': {
      ctx.beginPath(); ctx.arc(cx, cy - 6 * s, r * 0.7, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r, cy - 6 * s); ctx.lineTo(cx + r, cy - 6 * s)
      ctx.moveTo(cx, cy - 6 * s - r); ctx.lineTo(cx, cy - 6 * s + r)
      ctx.stroke()
      break
    }
    case 'church': {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.fillRect(cx - 3 * s, cy - r - 10 * s, 6 * s, r * 1.4)
      ctx.fillRect(cx - r * 0.6, cy - r * 0.2 - 8 * s, r * 1.2, 5 * s)
      break
    }
    case 'mortar_battery':
    case 'slaughterhouse': {
      ctx.beginPath(); ctx.arc(cx, cy - 6 * s, r * 0.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r * 0.5, cy - 6 * s - r * 0.5); ctx.lineTo(cx + r * 0.5, cy - 6 * s + r * 0.5)
      ctx.moveTo(cx + r * 0.5, cy - 6 * s - r * 0.5); ctx.lineTo(cx - r * 0.5, cy - 6 * s + r * 0.5)
      ctx.stroke()
      break
    }
    case 'crypt':
    case 'necromancer_tower': {
      ctx.beginPath(); ctx.arc(cx, cy - r * 0.4 - 6 * s, r * 0.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.beginPath(); ctx.arc(cx - r * 0.28, cy - r * 0.5 - 6 * s, r * 0.2, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(cx + r * 0.28, cy - r * 0.5 - 6 * s, r * 0.2, 0, Math.PI * 2); ctx.fill()
      break
    }
  }
}

// ── Units ────────────────────────────────────────────────────────────────────

function drawUnit(ctx: CanvasRenderingContext2D, unit: Unit) {
  const utype = UNIT_TYPES[unit.typeId]
  const p = project(unit.x, unit.y)
  const s = p.scale
  const ux = p.sx, uy = p.sy
  // Base size (used for both horizontal extent and character height)
  const r  = utype.radius * SX * s * 1.35
  const hpR = unit.hp / unit.maxHp

  const isWest = unit.team === 'west'
  const teamRing = isWest ? 'rgba(80,150,255,0.85)' : 'rgba(255,80,80,0.85)'

  // Team colored ground ring (replaces body outline)
  ctx.strokeStyle = teamRing
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.ellipse(ux, uy + r * 0.05, r * 0.75, r * 0.25, 0, 0, Math.PI * 2)
  ctx.stroke()

  // Ground shadow
  ctx.beginPath()
  ctx.ellipse(ux + 2, uy + r * 0.1, r * 0.7, r * 0.22, 0, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fill()

  // Facing direction (west units face right, east units face left)
  const facing = isWest ? 1 : -1

  // Character drawn standing "above" the shadow
  drawCharacter(ctx, unit, ux, uy, r, facing)

  // HP bar if damaged
  if (hpR < 0.99) {
    const bw = r * 2.0, bh = 4
    const bx = ux - bw / 2, by = uy - r * 2.3
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    roundRect(ctx, bx, by, bw, bh, 2); ctx.fill()
    ctx.fillStyle = hpColor(hpR)
    roundRect(ctx, bx + 1, by + 1, (bw - 2) * hpR, bh - 2, 1); ctx.fill()
  }

  // Generic muzzle flash for ranged units that don't draw their own
  // (mortar handles its own blast inside drawCharacter).
  const hasOwnFlash = unit.typeId === 'mortar'
  if (utype.range >= 70 && !hasOwnFlash &&
      unit.attackCooldown >= utype.attackInterval - 2) {
    ctx.fillStyle = 'rgba(255,240,160,0.9)'
    ctx.shadowColor = '#ffeaa0'
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.arc(ux + facing * r * 0.9, uy - r * 1.0, r * 0.45, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }
}

// A wooden spoked wheel for the mortar carriage.
function drawMortarWheel(ctx: CanvasRenderingContext2D, wx_: number, wy_: number, wr: number) {
  const wood = '#8a5a32'
  // Tyre
  ctx.fillStyle = wood
  ctx.beginPath(); ctx.arc(wx_, wy_, wr, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = darken(wood, 35); ctx.lineWidth = 1.2
  ctx.stroke()
  // Spokes
  ctx.strokeStyle = darken(wood, 25); ctx.lineWidth = 1.2
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4
    ctx.beginPath()
    ctx.moveTo(wx_ + Math.cos(a) * wr * 0.9, wy_ + Math.sin(a) * wr * 0.9)
    ctx.lineTo(wx_ - Math.cos(a) * wr * 0.9, wy_ - Math.sin(a) * wr * 0.9)
    ctx.stroke()
  }
  // Hub
  ctx.fillStyle = '#4a4a50'
  ctx.beginPath(); ctx.arc(wx_, wy_, wr * 0.2, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#1a1a20'; ctx.lineWidth = 1
  ctx.stroke()
}

// Little dwarf / gnome operator for the mortar team.
function drawGnome(
  ctx: CanvasRenderingContext2D,
  gx: number, gy: number, gr: number,
  team: Team, role: 'gunner' | 'loader',
  facing: number, firing: boolean,
) {
  const isWest = team === 'west'
  const armor     = isWest ? '#3a66c0' : '#b03232'
  const armorLite = isWest ? '#6a98e8' : '#e06060'
  const skin = '#e6c9a6'
  const beard = '#a85a20'
  const helmet = '#4a4a52'
  const leather = '#5a3a18'

  // Stubby legs / boots
  ctx.fillStyle = leather
  ctx.fillRect(gx - gr * 0.28, gy - gr * 0.25, gr * 0.22, gr * 0.25)
  ctx.fillRect(gx + gr * 0.06, gy - gr * 0.25, gr * 0.22, gr * 0.25)

  // Lean-back on firing (gunner more than loader)
  const lean = firing ? (role === 'gunner' ? -facing * gr * 0.12 : -facing * gr * 0.05) : 0

  // Torso (armor plate)
  const tg = ctx.createLinearGradient(gx - gr * 0.4, 0, gx + gr * 0.4, 0)
  tg.addColorStop(0, darken(armor, 20))
  tg.addColorStop(0.5, armor)
  tg.addColorStop(1, darken(armor, 20))
  ctx.fillStyle = tg
  roundRect(ctx, gx - gr * 0.42 + lean, gy - gr * 0.95, gr * 0.84, gr * 0.75, gr * 0.15)
  ctx.fill()
  ctx.strokeStyle = armorLite; ctx.lineWidth = 1
  ctx.stroke()
  // Belt
  ctx.fillStyle = '#2a1a0a'
  ctx.fillRect(gx - gr * 0.42 + lean, gy - gr * 0.35, gr * 0.84, gr * 0.12)
  // Belt buckle
  ctx.fillStyle = '#d4b04a'
  ctx.fillRect(gx - gr * 0.08 + lean, gy - gr * 0.33, gr * 0.16, gr * 0.08)

  // Head
  const headX = gx + lean * 0.7
  const headY = gy - gr * 1.15
  ctx.fillStyle = skin
  ctx.beginPath(); ctx.arc(headX, headY, gr * 0.3, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1
  ctx.stroke()
  // Beard covering lower face
  ctx.fillStyle = beard
  ctx.beginPath()
  ctx.arc(headX, headY + gr * 0.05, gr * 0.28, 0, Math.PI)
  ctx.fill()
  // Big nose
  ctx.fillStyle = darken(skin, 15)
  ctx.beginPath()
  ctx.arc(headX + facing * gr * 0.14, headY + gr * 0.02, gr * 0.08, 0, Math.PI * 2)
  ctx.fill()
  // Eye (one visible)
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.arc(headX + facing * gr * 0.08, headY - gr * 0.05, gr * 0.04, 0, Math.PI * 2)
  ctx.fill()

  // Steel helmet / pot hat
  ctx.fillStyle = helmet
  ctx.beginPath()
  ctx.arc(headX, headY - gr * 0.05, gr * 0.34, Math.PI, Math.PI * 2)
  ctx.fill()
  // Helmet brim
  ctx.fillRect(headX - gr * 0.36, headY - gr * 0.08, gr * 0.72, gr * 0.06)
  // Helmet rim highlight
  ctx.strokeStyle = '#8a8a92'; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(headX, headY - gr * 0.05, gr * 0.34, Math.PI, Math.PI * 2)
  ctx.stroke()

  // Role-specific prop
  if (role === 'gunner') {
    // Lit fuse / linstock held forward toward the barrel touch-hole
    ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(gx - facing * gr * 0.25 + lean, gy - gr * 0.55)
    ctx.lineTo(gx - facing * gr * 0.9, gy - gr * 1.0)
    ctx.stroke()
    // Flame at the far end
    ctx.fillStyle = 'rgba(255,160,40,0.95)'
    ctx.shadowColor = '#ff7700'; ctx.shadowBlur = 8
    ctx.beginPath()
    ctx.ellipse(gx - facing * gr * 0.95, gy - gr * 1.05, gr * 0.1, gr * 0.18, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,230,140,0.9)'
    ctx.beginPath()
    ctx.ellipse(gx - facing * gr * 0.95, gy - gr * 1.08, gr * 0.05, gr * 0.11, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  } else {
    // Loader cradling a black cannonball against the hip
    ctx.fillStyle = '#1a1a1a'
    ctx.beginPath()
    ctx.arc(gx + facing * gr * 0.4, gy - gr * 0.55, gr * 0.22, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1
    ctx.stroke()
    // Spec highlight
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.beginPath()
    ctx.arc(gx + facing * gr * 0.33, gy - gr * 0.62, gr * 0.06, 0, Math.PI * 2)
    ctx.fill()
    // Fuse sticking out
    ctx.strokeStyle = '#8a6a2a'; ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(gx + facing * gr * 0.4, gy - gr * 0.75)
    ctx.lineTo(gx + facing * gr * 0.5, gy - gr * 0.9)
    ctx.stroke()
  }
}

// Build little humanoid / creature silhouettes out of primitives. All shapes
// use (ux, uy) as the ground point — character stands up from there.
function drawCharacter(
  ctx: CanvasRenderingContext2D,
  unit: Unit,
  ux: number, uy: number, r: number, facing: number,
) {
  const utype = UNIT_TYPES[unit.typeId]
  const body = utype.color
  const bodyDark = darken(body, 25)
  const bodyLite = lighten(body, 30)
  const skin = unit.team === 'east' && ['ghoul','crypt_fiend','necromancer','abomination'].includes(unit.typeId)
    ? '#8fb470'            // pallid green for undead
    : '#e6c9a6'            // human skin
  const steel     = '#cfd3d8'
  const steelDark = '#7c828a'
  const wood      = '#8a5a32'
  const cloth     = '#20202a'

  // Helper: head at (hx, hy) with radius hr
  const head = (hx: number, hy: number, hr: number, color = skin) => {
    ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  switch (unit.typeId) {
    case 'footman': {
      // Legs
      ctx.fillStyle = steelDark
      ctx.fillRect(ux - r * 0.35, uy - r * 0.55, r * 0.28, r * 0.55)
      ctx.fillRect(ux + r * 0.07, uy - r * 0.55, r * 0.28, r * 0.55)
      // Torso (team-coloured armour)
      const g = ctx.createLinearGradient(ux - r * 0.5, 0, ux + r * 0.5, 0)
      g.addColorStop(0, bodyDark); g.addColorStop(0.5, body); g.addColorStop(1, bodyDark)
      ctx.fillStyle = g
      roundRect(ctx, ux - r * 0.55, uy - r * 1.25, r * 1.1, r * 0.8, r * 0.12); ctx.fill()
      // Shoulder pads
      ctx.fillStyle = steel
      ctx.beginPath(); ctx.arc(ux - r * 0.55, uy - r * 1.2, r * 0.2, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(ux + r * 0.55, uy - r * 1.2, r * 0.2, 0, Math.PI * 2); ctx.fill()
      // Head / helmet
      head(ux, uy - r * 1.55, r * 0.32, steel)
      ctx.fillStyle = '#000'
      ctx.fillRect(ux - r * 0.18, uy - r * 1.6, r * 0.36, r * 0.08)
      // Helmet crest
      ctx.fillStyle = bodyLite
      ctx.fillRect(ux - r * 0.04, uy - r * 1.95, r * 0.08, r * 0.35)
      // Sword arm
      ctx.strokeStyle = steel
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 0.45, uy - r * 1.0)
      ctx.lineTo(ux + facing * r * 1.1, uy - r * 1.75)
      ctx.stroke()
      // Sword hilt
      ctx.strokeStyle = wood
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 0.95, uy - r * 1.5)
      ctx.lineTo(ux + facing * r * 1.25, uy - r * 1.55)
      ctx.stroke()
      // Shield on other arm
      ctx.fillStyle = body
      roundRect(ctx, ux - facing * r * 0.85, uy - r * 1.15, r * 0.35, r * 0.55, 3); ctx.fill()
      ctx.strokeStyle = steel; ctx.lineWidth = 1; ctx.stroke()
      break
    }
    case 'rifleman': {
      // Legs (dark trousers)
      ctx.fillStyle = darken(body, 35)
      ctx.fillRect(ux - r * 0.3, uy - r * 0.5, r * 0.25, r * 0.5)
      ctx.fillRect(ux + r * 0.05, uy - r * 0.5, r * 0.25, r * 0.5)
      // Coat
      const g = ctx.createLinearGradient(ux - r * 0.4, 0, ux + r * 0.4, 0)
      g.addColorStop(0, bodyDark); g.addColorStop(0.5, body); g.addColorStop(1, bodyDark)
      ctx.fillStyle = g
      roundRect(ctx, ux - r * 0.45, uy - r * 1.2, r * 0.9, r * 0.75, r * 0.1); ctx.fill()
      // Belt
      ctx.fillStyle = wood
      ctx.fillRect(ux - r * 0.45, uy - r * 0.6, r * 0.9, r * 0.08)
      // Head + tricorne hat
      head(ux, uy - r * 1.5, r * 0.28)
      ctx.fillStyle = cloth
      ctx.beginPath()
      ctx.moveTo(ux - r * 0.45, uy - r * 1.6)
      ctx.lineTo(ux + r * 0.45, uy - r * 1.6)
      ctx.lineTo(ux + r * 0.25, uy - r * 1.85)
      ctx.lineTo(ux - r * 0.25, uy - r * 1.85)
      ctx.closePath(); ctx.fill()
      // Rifle (held diagonally)
      ctx.strokeStyle = wood; ctx.lineWidth = 3
      const rx0 = ux + facing * r * 0.1, ry0 = uy - r * 0.9
      const rx1 = ux + facing * r * 1.3, ry1 = uy - r * 1.35
      ctx.beginPath(); ctx.moveTo(rx0, ry0); ctx.lineTo(rx1, ry1); ctx.stroke()
      // Barrel (thinner darker tip)
      ctx.strokeStyle = steelDark; ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(rx1, ry1)
      ctx.lineTo(rx1 + facing * r * 0.25, ry1 - r * 0.1)
      ctx.stroke()
      break
    }
    case 'priest': {
      // Robe (trapezoid)
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.moveTo(ux - r * 0.55, uy)
      ctx.lineTo(ux + r * 0.55, uy)
      ctx.lineTo(ux + r * 0.35, uy - r * 1.3)
      ctx.lineTo(ux - r * 0.35, uy - r * 1.3)
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = darken(body, 30); ctx.lineWidth = 1; ctx.stroke()
      // Hood shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      ctx.beginPath(); ctx.arc(ux, uy - r * 1.35, r * 0.35, 0, Math.PI, true); ctx.fill()
      // Head with hood
      head(ux, uy - r * 1.5, r * 0.28)
      // Halo
      ctx.strokeStyle = '#ffe880'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(ux, uy - r * 1.85, r * 0.3, 0, Math.PI * 2); ctx.stroke()
      // Staff with glowing orb
      ctx.strokeStyle = wood; ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 0.6, uy)
      ctx.lineTo(ux + facing * r * 0.75, uy - r * 1.9)
      ctx.stroke()
      ctx.fillStyle = '#ddeeff'
      ctx.shadowColor = '#aaccff'; ctx.shadowBlur = 8
      ctx.beginPath(); ctx.arc(ux + facing * r * 0.75, uy - r * 2.0, r * 0.15, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
      break
    }
    case 'mortar': {
      // Recoil: when firing, the whole cannon jerks back; gnomes lean away.
      const firing = unit.attackCooldown >= utype.attackInterval - 3
      const recoil = firing ? -facing * r * 0.18 : 0

      // Ground platform shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.beginPath()
      ctx.ellipse(ux, uy - r * 0.05, r * 1.15, r * 0.28, 0, 0, Math.PI * 2)
      ctx.fill()

      // ── Far-side (back) gnome: loader holding a cannonball ──────────────
      // Drawn first so the cannon carriage covers his front
      const loaderX = ux - facing * r * 0.75
      const loaderY = uy - r * 0.15
      drawGnome(ctx, loaderX, loaderY, r * 0.45, unit.team, 'loader', facing, firing)

      // ── Wheels (behind carriage) ────────────────────────────────────────
      drawMortarWheel(ctx, ux - r * 0.75, uy - r * 0.25, r * 0.32)
      drawMortarWheel(ctx, ux + r * 0.75, uy - r * 0.25, r * 0.32)

      // ── Carriage block (wooden base the cannon sits on) ─────────────────
      ctx.fillStyle = darken(wood, 10)
      roundRect(ctx, ux - r * 0.65 + recoil, uy - r * 0.72, r * 1.3, r * 0.5, 4)
      ctx.fill()
      ctx.strokeStyle = darken(wood, 35); ctx.lineWidth = 1
      ctx.stroke()
      // Iron bands
      ctx.fillStyle = steelDark
      ctx.fillRect(ux - r * 0.65 + recoil, uy - r * 0.5, r * 1.3, r * 0.05)
      ctx.fillRect(ux - r * 0.65 + recoil, uy - r * 0.7, r * 1.3, r * 0.05)

      // ── Cannon barrel (fat, short, tilted ~45° forward+up) ──────────────
      ctx.save()
      ctx.translate(ux + recoil, uy - r * 0.78)
      ctx.rotate(facing * -0.75)
      // Barrel body
      const bg = ctx.createLinearGradient(-r * 0.35, 0, r * 0.35, 0)
      bg.addColorStop(0, '#0a0a0f')
      bg.addColorStop(0.5, '#2a2a32')
      bg.addColorStop(1, '#0a0a0f')
      ctx.fillStyle = bg
      roundRect(ctx, -r * 0.32, -r * 1.05, r * 0.64, r * 1.05, 5)
      ctx.fill()
      ctx.strokeStyle = '#4a4a52'; ctx.lineWidth = 1
      ctx.stroke()
      // Reinforcement rings
      ctx.fillStyle = '#191920'
      ctx.fillRect(-r * 0.36, -r * 0.2,  r * 0.72, r * 0.09)
      ctx.fillRect(-r * 0.36, -r * 0.55, r * 0.72, r * 0.08)
      ctx.fillRect(-r * 0.36, -r * 0.9,  r * 0.72, r * 0.08)
      // Highlight stripe
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(-r * 0.12, -r * 0.05); ctx.lineTo(-r * 0.12, -r * 1.0)
      ctx.stroke()
      // Muzzle (dark bore)
      ctx.fillStyle = '#000'
      ctx.beginPath()
      ctx.ellipse(0, -r * 1.05, r * 0.26, r * 0.08, 0, 0, Math.PI * 2)
      ctx.fill()
      // Touch-hole / fuse on top
      if (firing) {
        // Muzzle blast inside the barrel direction
        ctx.fillStyle = 'rgba(255,230,110,0.95)'
        ctx.shadowColor = '#ff9922'; ctx.shadowBlur = 16
        ctx.beginPath()
        ctx.moveTo(0, -r * 1.1)
        ctx.lineTo(-r * 0.5, -r * 1.55)
        ctx.lineTo(0, -r * 1.85)
        ctx.lineTo(r * 0.5, -r * 1.55)
        ctx.closePath(); ctx.fill()
        ctx.fillStyle = 'rgba(255,255,220,1)'
        ctx.beginPath(); ctx.arc(0, -r * 1.2, r * 0.22, 0, Math.PI * 2); ctx.fill()
        ctx.shadowBlur = 0
      }
      ctx.restore()

      // Smoke puff near the muzzle after firing
      if (firing) {
        ctx.fillStyle = 'rgba(200,200,200,0.45)'
        const puff = [
          [facing * r * 0.9,  -r * 1.55, r * 0.28],
          [facing * r * 1.25, -r * 1.35, r * 0.22],
          [facing * r * 0.5,  -r * 1.75, r * 0.18],
        ] as const
        for (const [dx, dy, pr] of puff) {
          ctx.beginPath(); ctx.arc(ux + dx, uy + dy, pr, 0, Math.PI * 2); ctx.fill()
        }
      }

      // ── Gunner (front gnome with lit fuse / torch) ──────────────────────
      const gunnerX = ux + facing * r * 0.75
      const gunnerY = uy - r * 0.2
      drawGnome(ctx, gunnerX, gunnerY, r * 0.5, unit.team, 'gunner', facing, firing)
      break
    }
    case 'ghoul': {
      // Hunched, claws forward
      // Legs
      ctx.fillStyle = darken(body, 25)
      ctx.fillRect(ux - r * 0.4, uy - r * 0.45, r * 0.3, r * 0.45)
      ctx.fillRect(ux + r * 0.1, uy - r * 0.45, r * 0.3, r * 0.45)
      // Hunched torso
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.moveTo(ux - r * 0.55, uy - r * 0.45)
      ctx.lineTo(ux + r * 0.55, uy - r * 0.45)
      ctx.lineTo(ux + facing * r * 0.2 + r * 0.35, uy - r * 1.1)
      ctx.lineTo(ux + facing * r * 0.2 - r * 0.35, uy - r * 1.1)
      ctx.closePath(); ctx.fill()
      // Head
      head(ux + facing * r * 0.25, uy - r * 1.25, r * 0.28, skin)
      // Glowing red eye
      ctx.fillStyle = '#ff4433'
      ctx.beginPath(); ctx.arc(ux + facing * r * 0.35, uy - r * 1.3, r * 0.07, 0, Math.PI * 2); ctx.fill()
      // Claws (front arm extended)
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 2
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath()
        ctx.moveTo(ux + facing * r * 0.55, uy - r * 0.95 + i * r * 0.08)
        ctx.lineTo(ux + facing * r * 1.0, uy - r * 1.1 + i * r * 0.12)
        ctx.stroke()
      }
      break
    }
    case 'crypt_fiend': {
      // Spider-like: low body + 4 visible legs + 2 raised front legs
      // Legs beneath
      ctx.strokeStyle = darken(body, 30); ctx.lineWidth = 2
      for (const off of [-1, -0.4, 0.4, 1]) {
        ctx.beginPath()
        ctx.moveTo(ux + off * r * 0.5, uy - r * 0.3)
        ctx.lineTo(ux + off * r * 1.0, uy - r * 0.05)
        ctx.stroke()
      }
      // Main bulbous body
      ctx.fillStyle = body
      ctx.beginPath(); ctx.ellipse(ux, uy - r * 0.65, r * 0.7, r * 0.5, 0, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = darken(body, 30); ctx.lineWidth = 1; ctx.stroke()
      // Pattern stripes
      ctx.strokeStyle = darken(body, 40)
      ctx.beginPath()
      ctx.moveTo(ux - r * 0.4, uy - r * 0.65); ctx.lineTo(ux + r * 0.4, uy - r * 0.65)
      ctx.stroke()
      // Front raised legs / pincers aiming forward
      ctx.strokeStyle = darken(body, 30); ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 0.4, uy - r * 0.9)
      ctx.lineTo(ux + facing * r * 1.0, uy - r * 1.2)
      ctx.moveTo(ux + facing * r * 0.4, uy - r * 0.9)
      ctx.lineTo(ux + facing * r * 1.0, uy - r * 0.7)
      ctx.stroke()
      // Eyes (4 small red dots)
      ctx.fillStyle = '#ff3333'
      for (const ox of [-0.2, 0.2]) for (const oy of [-0.05, 0.1]) {
        ctx.beginPath()
        ctx.arc(ux + facing * (0.35 + ox) * r, uy - r * (0.75 + oy), r * 0.05, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'necromancer': {
      // Dark hooded caster
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.moveTo(ux - r * 0.55, uy)
      ctx.lineTo(ux + r * 0.55, uy)
      ctx.lineTo(ux + r * 0.4, uy - r * 1.3)
      ctx.lineTo(ux - r * 0.4, uy - r * 1.3)
      ctx.closePath(); ctx.fill()
      // Hood peak
      ctx.beginPath()
      ctx.moveTo(ux - r * 0.4, uy - r * 1.3)
      ctx.lineTo(ux + r * 0.4, uy - r * 1.3)
      ctx.lineTo(ux, uy - r * 1.9)
      ctx.closePath(); ctx.fill()
      // Face shadow inside hood (no visible skin, glowing eyes)
      ctx.fillStyle = '#000'
      ctx.beginPath(); ctx.arc(ux, uy - r * 1.45, r * 0.28, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#ff77ff'
      ctx.shadowColor = '#cc88ff'; ctx.shadowBlur = 6
      ctx.beginPath(); ctx.arc(ux - r * 0.1, uy - r * 1.48, r * 0.05, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(ux + r * 0.1, uy - r * 1.48, r * 0.05, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
      // Crooked staff with skull
      ctx.strokeStyle = darken(wood, 20); ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 0.55, uy)
      ctx.quadraticCurveTo(ux + facing * r * 0.9, uy - r, ux + facing * r * 0.7, uy - r * 1.9)
      ctx.stroke()
      ctx.fillStyle = '#eee'
      ctx.beginPath(); ctx.arc(ux + facing * r * 0.7, uy - r * 2.0, r * 0.15, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#000'
      ctx.beginPath(); ctx.arc(ux + facing * r * 0.66, uy - r * 2.02, r * 0.04, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(ux + facing * r * 0.74, uy - r * 2.02, r * 0.04, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'abomination': {
      // Huge bloated flesh-blob
      const grad = ctx.createRadialGradient(ux - r * 0.3, uy - r * 0.9, r * 0.1, ux, uy - r * 0.7, r * 1.2)
      grad.addColorStop(0, lighten(body, 35))
      grad.addColorStop(0.7, body)
      grad.addColorStop(1, darken(body, 30))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.ellipse(ux, uy - r * 0.7, r * 1.1, r * 0.95, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = darken(body, 40); ctx.lineWidth = 1.5; ctx.stroke()
      // Stitches across
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1
      for (let i = 0; i < 6; i++) {
        const x = ux - r * 0.7 + i * r * 0.28
        ctx.beginPath()
        ctx.moveTo(x, uy - r * 0.85)
        ctx.lineTo(x + r * 0.08, uy - r * 0.55)
        ctx.stroke()
      }
      // Hook / cleaver arm
      ctx.strokeStyle = steelDark; ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 0.9, uy - r * 0.6)
      ctx.lineTo(ux + facing * r * 1.3, uy - r * 0.2)
      ctx.stroke()
      ctx.fillStyle = steel
      ctx.beginPath()
      ctx.moveTo(ux + facing * r * 1.3, uy - r * 0.2)
      ctx.lineTo(ux + facing * r * 1.55, uy - r * 0.1)
      ctx.lineTo(ux + facing * r * 1.25, uy - r * 0.05)
      ctx.closePath(); ctx.fill()
      // Single sunken eye
      ctx.fillStyle = '#ffcc33'
      ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 6
      ctx.beginPath(); ctx.arc(ux + facing * r * 0.15, uy - r * 1.1, r * 0.12, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
      break
    }
    default: {
      // Fallback: simple pawn
      ctx.fillStyle = body
      ctx.beginPath()
      ctx.arc(ux, uy - r * 0.6, r * 0.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

// ── Projectiles ──────────────────────────────────────────────────────────────

function drawProjectiles(ctx: CanvasRenderingContext2D) {
  for (const p of projectiles) {
    const t = Math.min(1, Math.max(0, p.t))

    // World-space interpolation
    const wx0 = p.x0 + (p.x1 - p.x0) * t
    const wy0 = p.y0 + (p.y1 - p.y0) * t
    const cur  = project(wx0, wy0)
    const arcLift = Math.sin(t * Math.PI) * p.arc

    const px = cur.sx
    const py = cur.sy - arcLift - 10 * cur.scale // small "standing" offset

    const origin = project(p.x0, p.y0)
    const dest   = project(p.x1, p.y1)
    const angle  = Math.atan2(dest.sy - origin.sy, dest.sx - origin.sx)

    ctx.save()

    switch (p.type) {
      case 'arrow': {
        ctx.translate(px, py)
        ctx.rotate(angle)
        ctx.strokeStyle = p.color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(-12, 0); ctx.lineTo(6, 0); ctx.stroke()
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.moveTo(10, 0); ctx.lineTo(3, -3); ctx.lineTo(3, 3); ctx.closePath(); ctx.fill()
        // fletching
        ctx.strokeStyle = 'rgba(255,255,255,0.4)'
        ctx.beginPath()
        ctx.moveTo(-12, 0); ctx.lineTo(-14, -2)
        ctx.moveTo(-12, 0); ctx.lineTo(-14,  2)
        ctx.stroke()
        break
      }
      case 'bullet': {
        // Short tracer from behind current position
        const tt = Math.max(0, t - 0.25)
        const tx = p.x0 + (p.x1 - p.x0) * tt
        const ty = p.y0 + (p.y1 - p.y0) * tt
        const tp = project(tx, ty)
        ctx.strokeStyle = p.color
        ctx.lineWidth = 2
        ctx.shadowColor = p.color; ctx.shadowBlur = 8
        ctx.beginPath()
        ctx.moveTo(tp.sx, tp.sy - Math.sin(tt * Math.PI) * p.arc - 10 * tp.scale)
        ctx.lineTo(px, py)
        ctx.stroke()
        ctx.shadowBlur = 0
        break
      }
      case 'shell': {
        // Dark iron ball with glow, spinning
        ctx.translate(px, py)
        ctx.rotate(t * Math.PI * 6)
        ctx.fillStyle = '#222'
        ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = p.color
        ctx.beginPath(); ctx.arc(-2, -2, 2.5, 0, Math.PI * 2); ctx.fill()
        // smoke puff trail
        ctx.fillStyle = 'rgba(200,200,200,0.4)'
        ctx.beginPath(); ctx.arc(-6, 3, 3, 0, Math.PI * 2); ctx.fill()
        // explosion near the end
        if (t > 0.9) {
          ctx.globalAlpha = (1 - t) / 0.1
          ctx.fillStyle = '#ff7722'
          ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = '#ffdd66'
          ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
        }
        break
      }
      case 'orb': {
        ctx.shadowColor = p.color; ctx.shadowBlur = 14
        const pulse = 0.7 + 0.3 * Math.sin(t * Math.PI * 6)
        ctx.fillStyle = p.color
        ctx.beginPath(); ctx.arc(px, py, 5 + pulse * 2, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill()
        ctx.shadowBlur = 0
        break
      }
      case 'beam': {
        const op = Math.sin(t * Math.PI)
        const grad = ctx.createLinearGradient(origin.sx, origin.sy - 10 * origin.scale, dest.sx, dest.sy - 10 * dest.scale)
        grad.addColorStop(0, `rgba(255,255,255,${0.1 * op})`)
        grad.addColorStop(0.5, p.color)
        grad.addColorStop(1, `rgba(180,255,255,${0.1 * op})`)
        ctx.globalAlpha = op
        ctx.strokeStyle = grad
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(origin.sx, origin.sy - 10 * origin.scale)
        ctx.lineTo(dest.sx,   dest.sy   - 10 * dest.scale)
        ctx.stroke()
        ctx.globalAlpha = 1
        break
      }
    }

    ctx.restore()
  }
}

// ── Floating numbers ─────────────────────────────────────────────────────────

function drawFloatingEffects(ctx: CanvasRenderingContext2D) {
  for (const e of effects) {
    const alpha = e.ttl / e.maxTtl
    const p = project(e.x, e.y)
    ctx.globalAlpha = alpha
    ctx.fillStyle = e.color
    ctx.font = `bold ${Math.max(10, 10 * p.scale)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.shadowColor = e.color
    ctx.shadowBlur = 6
    ctx.fillText(e.text, p.sx, p.sy)
    ctx.shadowBlur = 0
  }
  ctx.globalAlpha = 1
}

// ── HUD ─────────────────────────────────────────────────────────────────────

function drawHUD(ctx: CanvasRenderingContext2D, state: GameState, W: number, H: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  roundRect(ctx, W / 2 - 130, 8, 260, 34, 6); ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1; ctx.stroke()

  ctx.fillStyle = '#fff'
  ctx.font = 'bold 13px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`Раунд ${state.round}  |  Запад ${state.wins.west} — ${state.wins.east} Восток`, W / 2, 30)

  if (state.phase === 'round_end') {
    const winner = state.castles.west.hp <= 0 ? 'Восток' : 'Запад'
    const color  = state.castles.west.hp <= 0 ? '#ff4444' : '#4488ff'
    ctx.fillStyle = 'rgba(0,0,0,0.82)'
    roundRect(ctx, W / 2 - 180, H / 2 - 45, 360, 90, 10); ctx.fill()
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke()
    ctx.fillStyle = color
    ctx.font = 'bold 22px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${winner} выиграл раунд!`, W / 2, H / 2 + 10)
  }

  if (state.phase === 'game_end') {
    const winner = state.wins.west > state.wins.east ? 'Запад' : 'Восток'
    ctx.fillStyle = 'rgba(0,0,0,0.9)'
    roundRect(ctx, W / 2 - 200, H / 2 - 55, 400, 110, 12); ctx.fill()
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 2; ctx.stroke()
    ctx.fillStyle = '#ffd700'
    ctx.font = 'bold 24px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`${winner} победил в матче!`, W / 2, H / 2 + 12)
  }

  if (state.phase === 'lobby') {
    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    roundRect(ctx, W / 2 - 160, H / 2 - 30, 320, 60, 8); ctx.fill()
    ctx.fillStyle = '#aaa'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Ожидание игроков...', W / 2, H / 2 + 10)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function hpColor(r: number) {
  if (r > 0.6) return '#44dd44'
  if (r > 0.3) return '#ffaa00'
  return '#ff3333'
}

function lighten(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, (num >> 16) + amount)
  const g = Math.min(255, ((num >> 8) & 0xff) + amount)
  const b = Math.min(255, (num & 0xff) + amount)
  return `rgb(${r},${g},${b})`
}

function darken(hex: string, amount: number): string {
  return lighten(hex, -amount)
}
