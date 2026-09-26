// Предпросмотр 3D-отрисовки без сервера: локальная имитация боя по тем же правилам.
// Открыть: npm run dev → http://localhost:5173/preview.html
import { initRenderer, render, unproject, setView } from './renderer'
import type { GameState, Unit, Building, Team } from './types'
import { UNIT_TYPES, BUILDING_TYPES, BUILDINGS_BY_RACE } from './data'
import { canPlace } from './placement'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
initRenderer(canvas)

const params = new URLSearchParams(location.search)
let uid = 1
const state: GameState = {
  roomId: 'preview', roomName: 'Предпросмотр',
  tick: 0, phase: 'playing', round: 1, maxRounds: 3, wins: { west: 0, east: 0 },
  castles: { west: { hp: 3000, maxHp: 3000 }, east: { hp: 3000, maxHp: 3000 } },
  units: [], buildings: [], strikes: [], auras: { west: { damage: 0, speed: 0 }, east: { damage: 0, speed: 0 } },
  players: [
    { id: 'p1', name: 'Люди', team: 'west', race: 'human', gold: 400, lumber: 0, ready: true, connected: true, strikeUsed: false, nukes: 1, stats: { kills: 0, lost: 0, castleDmg: 0, trained: 0, built: 0, spent: 0, strikeKills: 0, towerKills: 0 } },
    { id: 'p2', name: 'Нежить', team: 'east', race: 'undead', gold: 400, lumber: 0, ready: true, connected: true, strikeUsed: false, nukes: 1, stats: { kills: 0, lost: 0, castleDmg: 0, trained: 0, built: 0, spent: 0, strikeKills: 0, towerKills: 0 } },
  ],
  roundEndTimer: 0,
  // ?night, ?rain — посмотреть погоду
  conditions: { night: params.has('night'), rain: params.has('rain') },
}

function addBuilding(team: Team, typeId: string, x: number, y: number) {
  const b: Building = {
    id: String(uid++), typeId, race: BUILDING_TYPES[typeId].race, team, ownerId: team === 'west' ? 'p1' : 'p2',
    x, y, hp: BUILDING_TYPES[typeId].hp, maxHp: BUILDING_TYPES[typeId].hp,
    spawnTimer: 20 + Math.floor(Math.random() * 60),
    level: 1,
  }
  state.buildings.push(b)
}
BUILDINGS_BY_RACE.human.forEach((t, i) => addBuilding('west', t, 230 + (i % 2) * 110, 300 + Math.floor(i / 2) * 170))
BUILDINGS_BY_RACE.undead.forEach((t, i) => addBuilding('east', t, 1370 - (i % 2) * 110, 300 + Math.floor(i / 2) * 170))

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
function spawn(b: Building) {
  const ut = UNIT_TYPES[BUILDING_TYPES[b.typeId].unitTypeId]
  if (!ut) return // башня
  state.units.push({ id: String(uid++), typeId: ut.id, team: b.team, x: b.x + (b.team === 'west' ? 40 : -40), y: b.y, hp: ut.hp, maxHp: ut.hp, attackCooldown: 0, level: b.level, ownerId: '', lane: 1, wp: 0 })
}
// сразу по одному юниту каждого типа, если просили витрину
if (params.has('showcase')) {
  const types = Object.keys(UNIT_TYPES)
  types.forEach((t, i) => {
    const ut = UNIT_TYPES[t]
    state.units.push({ id: String(uid++), typeId: t, team: i % 2 ? 'east' : 'west', x: 1300 - 330 + (i % 6) * 130, y: 600 - 240 + Math.floor(i / 6) * 120, hp: ut.hp * 0.7, maxHp: ut.hp, attackCooldown: 0, level: 1, ownerId: '', lane: 1, wp: 0 })
  })
}

// нагрузочный режим: ?stress=N — N юнитов и по 15 зданий у каждой команды
const stress = Number(params.get('stress') || 0)
if (stress) {
  state.buildings = []
  for (let i = 0; i < 15; i++) {
    addBuilding('west', BUILDINGS_BY_RACE.human[i % 4], 160 + (i % 5) * 85, 220 + Math.floor(i / 5) * 150)
    addBuilding('east', BUILDINGS_BY_RACE.undead[i % 4], 1440 - (i % 5) * 85, 220 + Math.floor(i / 5) * 150)
  }
  const types = Object.keys(UNIT_TYPES)
  for (let i = 0; i < stress; i++) {
    const t = types[i % types.length]
    const ut = UNIT_TYPES[t]
    const team: Team = i % 2 ? 'west' : 'east'
    state.units.push({ id: String(uid++), typeId: t, team, x: 500 + Math.random() * 600, y: 280 + Math.random() * 240, hp: ut.hp * 5, maxHp: ut.hp * 5, attackCooldown: 0, level: 1, ownerId: '', lane: 1, wp: 0 })
  }
}

function step() {
  if (params.has('freeze')) return
  state.tick++
  for (const u of state.units) if (u.attackCooldown > 0) u.attackCooldown--
  const dead = new Set<string>()
  for (const u of state.units) {
    if (dead.has(u.id)) continue
    const t = UNIT_TYPES[u.typeId]
    const enemies = state.units.filter(o => o.team !== u.team && !dead.has(o.id))
    if (u.typeId === 'priest' && u.attackCooldown === 0) {
      const hurt = state.units.filter(a => a.team === u.team && a.id !== u.id && a.hp < a.maxHp && dist(u, a) <= t.range)[0]
      if (hurt) { hurt.hp = Math.min(hurt.maxHp, hurt.hp + 25); u.attackCooldown = t.attackInterval }
    }
    const c = enemies.sort((a, b) => dist(u, a) - dist(u, b))[0]
    const move = (tx: number, ty: number) => {
      const d = Math.hypot(tx - u.x, ty - u.y)
      if (d > 0) { u.x += (tx - u.x) / d * t.speed; u.y += (ty - u.y) / d * t.speed }
    }
    if (c) {
      if (dist(u, c) <= t.range) {
        if (u.attackCooldown === 0) { c.hp -= t.damage; u.attackCooldown = t.attackInterval; if (c.hp <= 0) dead.add(c.id) }
      } else move(c.x, c.y)
    } else {
      const cx = u.team === 'west' ? 1540 : 60
      if (Math.abs(u.x - cx) < 80) { state.castles[u.team === 'west' ? 'east' : 'west'].hp -= t.damage * 2; dead.add(u.id) }
      else move(cx, 400)
    }
  }
  state.units = state.units.filter(u => !dead.has(u.id))
  for (const b of state.buildings) {
    if (--b.spawnTimer <= 0) { spawn(b); b.spawnTimer = BUILDING_TYPES[b.typeId].spawnInterval }
  }
  for (const t of ['west', 'east'] as Team[]) if (state.castles[t].hp <= 0) state.castles[t].hp = 3000
}

let snapshot: GameState = structuredClone(state)
setInterval(() => { step(); snapshot = structuredClone(state) }, 50)

let selected: string | null = params.get('build')
let hovered: { x: number; y: number } | null = params.has('hover') ? { x: 300, y: 560 } : null
canvas.addEventListener('mousemove', e => { hovered = unproject(e.clientX, e.clientY, canvas) })
canvas.addEventListener('click', () => {
  if (selected && hovered && canPlace('west', hovered.x, hovered.y, state.buildings).ok) addBuilding('west', selected, hovered.x, hovered.y)
})
;(window as unknown as { preview: unknown }).preview = { state, select: (t: string | null) => { selected = t }, hover: (c: typeof hovered) => { hovered = c } }

const view = params.get('view')
if (view) {
  const [px, py, pz, tx, ty, tz] = view.split(',').map(Number)
  setTimeout(() => setView([px, py, pz], [tx, ty, tz]), 100)
}

function loop() {
  render(canvas, snapshot, 'p1', 'west', selected, hovered)
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
