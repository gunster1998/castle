// 3D-отрисовка «Битвы замков» на Three.js.
// Интерфейс тот же, что у 2D-версии (renderer2d.ts): initRenderer, render, updateEffects, unproject.
// Модели: KayKit (Kay Lousberg, CC0) — собираются скриптом scripts/build-assets.mjs в public/assets.
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeCharacter, flattenStatic } from './merge'
import type { GameState, Unit, Building, Team, Race } from './types'
import { UNIT_TYPES, BUILDING_TYPES } from './data'
import { BASE_ZONE, BUILDING_SPACING, canPlace } from './placement'
import { spawnMult } from './upgrades'

// ── Мир → сцена ──────────────────────────────────────────────────────────────
// Мир сервера: x 0..1600, y 0..800 (y растёт «к зрителю»). Сцена: X вправо, Z к зрителю, Y вверх.

const S = 0.02
const wx = (x: number) => (x - 800) * S
const wz = (y: number) => (y - 400) * S
const CASTLE_X = { west: 60, east: 1540 }
const TEAM_COLOR = { west: '#3f7ee8', east: '#e0483a' }
const TEAM_KIT = { west: 'blue', east: 'red' } as const
const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`

// ── Загрузка ассетов ─────────────────────────────────────────────────────────

const loader = new GLTFLoader()
const assets = new Map<string, GLTF>()
const loading = new Map<string, Promise<GLTF>>()
let clips: THREE.AnimationClip[] = []

function load(name: string): Promise<GLTF> {
  let p = loading.get(name)
  if (!p) {
    // демо-страница встраивает модели в HTML (window.__castleAssets: имя -> base64)
    const inline = (window as unknown as { __castleAssets?: Record<string, string> }).__castleAssets?.[name]
    const src = inline
      ? loader.parseAsync(Uint8Array.from(atob(inline), c => c.charCodeAt(0)).buffer, ASSET_BASE)
      : loader.loadAsync(`${ASSET_BASE}${name}.glb`)
    p = src.then(g => {
      g.scene.traverse(o => {
        const m = o as THREE.Mesh
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
      })
      assets.set(name, g)
      return g
    })
    p.catch(err => console.error('asset', name, err))
    loading.set(name, p)
  }
  return p
}
function asset(name: string): GLTF | undefined {
  const g = assets.get(name)
  if (!g) void load(name)
  return g
}

const bboxCache = new Map<string, THREE.Box3>()
function bbox(name: string, obj: THREE.Object3D): THREE.Box3 {
  let b = bboxCache.get(name)
  if (!b) {
    obj.updateMatrixWorld(true)
    b = new THREE.Box3().setFromObject(obj)
    bboxCache.set(name, b)
  }
  return b
}

/** Копия статичной модели: fit — вписать в квадрат основания, height — по высоте. */
function prop(name: string, opts: { fit?: number; height?: number; scale?: number } = {}): THREE.Object3D | null {
  const g = asset(name)
  if (!g) return null
  const box = bbox(name, g.scene)
  const size = box.getSize(new THREE.Vector3())
  let k = opts.scale ?? 1
  if (opts.fit) k = opts.fit / Math.max(size.x, size.z)
  if (opts.height) k = opts.height / size.y
  const inner = g.scene.clone(true)
  inner.scale.setScalar(k)
  const c = box.getCenter(new THREE.Vector3())
  inner.position.set(-c.x * k, -box.min.y * k, -c.z * k)
  const outer = new THREE.Group()
  outer.add(inner)
  return outer
}

// ── Юниты: какая модель, оружие и анимации ──────────────────────────────────

type ProjKind = 'bolt' | 'stone' | 'beam' | 'orb' | 'none'
interface UnitVisual {
  model: string
  height: number
  show?: string[]
  attach?: { asset: string; slot: 'handslotr' | 'handslotl' | 'chest' }[]
  idle: string; move: string; attack: string; death: string; hit: string
  moveBase: number
  proj: ProjKind
  hand: number
}

const UNIT_SCALE = 1.25
const UNIT_VIS: Record<string, UnitVisual> = {
  footman: { model: 'knight', height: 1.08, show: ['1H_Sword', 'Round_Shield'], idle: 'Idle', move: 'Walking_A', attack: '1H_Melee_Attack_Chop', death: 'Death_A', hit: 'Hit_A', moveBase: 2.2, proj: 'none', hand: 0.6 },
  rifleman: { model: 'rogue', height: 1.0, show: ['2H_Crossbow'], idle: '2H_Ranged_Aiming', move: 'Walking_B', attack: '2H_Ranged_Shoot', death: 'Death_B', hit: 'Hit_A', moveBase: 2.0, proj: 'bolt', hand: 0.62 },
  priest: { model: 'mage', height: 1.02, show: ['2H_Staff'], idle: 'Idle', move: 'Walking_A', attack: 'Spellcast_Shoot', death: 'Death_A', hit: 'Hit_A', moveBase: 2.2, proj: 'beam', hand: 0.75 },
  mortar: { model: 'barbarian', height: 1.05, show: [], idle: 'Unarmed_Idle', move: 'Walking_B', attack: 'Throw', death: 'Death_B', hit: 'Hit_A', moveBase: 1.8, proj: 'stone', hand: 0.9 },
  ghoul: { model: 'skel_minion', height: 0.95, attach: [{ asset: 'skel_blade', slot: 'handslotr' }], idle: 'Idle', move: 'Running_A', attack: '1H_Melee_Attack_Slice_Diagonal', death: 'Death_A', hit: 'Hit_A', moveBase: 3.4, proj: 'none', hand: 0.55 },
  crypt_fiend: { model: 'skel_rogue', height: 1.0, attach: [{ asset: 'skel_crossbow', slot: 'handslotr' }, { asset: 'skel_quiver', slot: 'chest' }], idle: '2H_Ranged_Aiming', move: 'Walking_A', attack: '2H_Ranged_Shoot', death: 'Death_B', hit: 'Hit_A', moveBase: 2.1, proj: 'bolt', hand: 0.62 },
  necromancer: { model: 'skel_mage', height: 1.02, attach: [{ asset: 'skel_staff', slot: 'handslotr' }], idle: 'Idle', move: 'Walking_A', attack: 'Spellcast_Shoot', death: 'Death_A', hit: 'Hit_A', moveBase: 2.0, proj: 'orb', hand: 0.75 },
  abomination: { model: 'skel_warrior', height: 1.75, attach: [{ asset: 'skel_axe', slot: 'handslotr' }, { asset: 'skel_shield', slot: 'handslotl' }], idle: 'Idle', move: 'Walking_B', attack: '1H_Melee_Attack_Chop', death: 'Death_A', hit: 'Hit_A', moveBase: 1.6, proj: 'none', hand: 1.0 },
}

// ── Сцена ────────────────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let sun: THREE.DirectionalLight
const clock = new THREE.Clock()
let canvasEl: HTMLCanvasElement
let overlay: HTMLDivElement
let hudTop: HTMLDivElement
let banner: HTMLDivElement
const raycaster = new THREE.Raycaster()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

export function initRenderer(canvas: HTMLCanvasElement) {
  canvasEl = canvas
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // в тенях только статика (здания, замки, деревья): пересчитываем по событию, а не каждый кадр
  renderer.shadowMap.autoUpdate = false
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.outputColorSpace = THREE.SRGBColorSpace

  scene = new THREE.Scene()
  scene.background = skyTexture()
  scene.fog = new THREE.Fog('#c9dcea', 38, 80)

  camera = new THREE.PerspectiveCamera(34, 2, 0.1, 200)
  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
  controls.minDistance = 8
  controls.maxDistance = 40
  controls.minPolarAngle = 0.35
  controls.maxPolarAngle = 1.2
  controls.screenSpacePanning = false
  canvas.addEventListener('contextmenu', e => e.preventDefault())

  scene.add(barBg, barFill, rings.west, rings.east, blobs, partMesh)
  scene.add(new THREE.HemisphereLight('#dfe9ff', '#46522c', 1.0))
  sun = new THREE.DirectionalLight('#fff0d6', 2.1)
  sun.position.set(-9, 18, 10)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 16, bottom: -16, near: 1, far: 60 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.03
  scene.add(sun)

  makeOverlay(canvas)
  // отладка/тесты: мир сервера -> координаты экрана
  ;(window as unknown as { __castle: unknown }).__castle = {
    perf() {
      return { quality, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, fps: Math.round(fpsAvg), frameMs: +frameMsAvg.toFixed(2), units: unitViews.size, buildings: buildingViews.size, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }
    },
    toScreen(x: number, y: number) {
      const v = new THREE.Vector3(wx(x), 0, wz(y)).project(camera)
      const r = canvas.getBoundingClientRect()
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height }
    },
  }
  resize()
  window.addEventListener('resize', resize)
  // панель снизу появляется и меняет высоту по ходу игры
  const hud = document.getElementById('hud')
  if (hud) new ResizeObserver(resize).observe(hud)

  // сначала земля и замки, потом всё остальное
  const first = ['hex_grass', 'castle_blue', 'castle_red', 'anims']
  const rest = ['tower_A_blue', 'tower_A_red', 'wall_straight', 'flag_blue', 'flag_red', 'building_destroyed',
    ...new Set(Object.values(UNIT_VIS).map(v => v.model)),
    ...Object.values(UNIT_VIS).flatMap(v => (v.attach ?? []).map(a => a.asset)),
    'arrow', 'stone', 'trees_A_large', 'trees_A_medium', 'trees_B_large', 'trees_B_medium', 'tree_single_A', 'tree_single_B',
    'mountain_A', 'mountain_B', 'mountain_C', 'hills_A', 'hills_B', 'rock_A', 'rock_B', 'rock_C', 'cloud_big',
    'barracks_blue', 'barracks_red', 'archeryrange_blue', 'archeryrange_red', 'church_blue', 'church_red',
    'tower_catapult_blue', 'tower_catapult_red', 'tower_B_blue', 'tower_B_red', 'blacksmith_blue', 'blacksmith_red',
    'crypt', 'arch_gate', 'grave_A', 'grave_B', 'gravestone', 'tree_dead_large', 'tree_dead_medium', 'coffin', 'ribcage',
    'bone_A', 'post_skull', 'skull_candle', 'lantern', 'weaponrack', 'target', 'barrel', 'crate', 'tent']
  Promise.all(first.map(load)).then(() => {
    clips = assets.get('anims')!.animations
    rest.forEach(n => void load(n))
  })
}

function skyTexture() {
  const c = document.createElement('canvas')
  c.width = 4; c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#6f9fd6')
  grad.addColorStop(0.55, '#b9d3ea')
  grad.addColorStop(1, '#dfe9ef')
  g.fillStyle = grad
  g.fillRect(0, 0, 4, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function resize() {
  const hud = document.getElementById('hud')
  const hudH = hud && hud.offsetHeight ? hud.offsetHeight : 72
  const w = window.innerWidth
  const h = Math.max(240, window.innerHeight - hudH)
  renderer.setSize(w, h, true)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  if (overlay) overlay.style.height = `${h}px`
  fitCamera()
}

/** Камера под углом ~40°, отодвинута так, чтобы оба замка влезали по ширине. */
function fitCamera() {
  const halfW = 18.6
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const dist = Math.max(20, halfW / (tanH * camera.aspect))
  const elev = THREE.MathUtils.degToRad(29)
  const target = new THREE.Vector3(0, 0, 2.3)
  controls.target.copy(target)
  camera.position.set(0, Math.sin(elev) * dist, target.z + Math.cos(elev) * dist)
  controls.maxDistance = dist * 1.4
  controls.update()
}

/** Для предпросмотра: поставить камеру. */
export function setView(pos: [number, number, number], target: [number, number, number]) {
  camera.position.set(...pos)
  controls.target.set(...target)
  controls.update()
}

/** Экран → мир сервера (пересечение луча с землёй). */
export function unproject(screenX: number, screenY: number, canvas: HTMLCanvasElement): { x: number; y: number } {
  const r = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(((screenX - r.left) / r.width) * 2 - 1, -((screenY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, camera)
  const hit = new THREE.Vector3()
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) return { x: -9999, y: -9999 }
  return { x: hit.x / S + 800, y: hit.z / S + 400 }
}

// ── Оверлей: верхняя панель, баннеры, всплывающие числа ─────────────────────

function makeOverlay(canvas: HTMLCanvasElement) {
  const parent = canvas.parentElement!
  parent.style.position = 'relative'
  overlay = document.createElement('div')
  overlay.style.cssText = 'position:absolute;left:0;top:0;right:0;height:100%;pointer-events:none;overflow:hidden;font-family:Consolas,"Courier New",monospace;'
  parent.insertBefore(overlay, canvas.nextSibling)
  const style = document.createElement('style')
  style.textContent = `
    .r3-top{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;
      background:rgba(12,16,28,.72);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 14px;color:#fff;font-size:13px;white-space:nowrap}
    .r3-side{display:flex;flex-direction:column;gap:3px;min-width:150px}
    .r3-side.east{align-items:flex-end}
    .r3-name{font-weight:bold;font-size:12px;letter-spacing:.5px}
    .r3-bar{width:150px;height:9px;background:rgba(0,0,0,.55);border-radius:5px;overflow:hidden;border:1px solid rgba(255,255,255,.15)}
    .r3-fill{height:100%;border-radius:5px;transition:width .2s}
    .r3-roster{font-size:11px;color:#b9c0cc;max-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r3-mid{text-align:center;font-size:12px;color:#ddd;line-height:1.35}
    .r3-mid b{font-size:15px;color:#ffd35c}
    .r3-banner{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);padding:18px 34px;border-radius:12px;
      background:rgba(8,10,18,.84);border:2px solid #ffd35c;color:#ffd35c;font-size:24px;font-weight:bold;text-align:center}
    .r3-float{position:absolute;font:bold 12px sans-serif;transform:translate(-50%,-50%);text-shadow:0 0 4px #000,0 0 2px #000;will-change:transform,opacity}
    @media (max-width:640px){.r3-side{min-width:90px}.r3-bar{width:90px}.r3-top{gap:8px;padding:5px 8px}}
  `
  document.head.appendChild(style)
  hudTop = document.createElement('div')
  hudTop.className = 'r3-top'
  hudTop.innerHTML = `
    <div class="r3-side west"><span class="r3-name" style="color:${TEAM_COLOR.west}">Запад</span><div class="r3-bar"><div class="r3-fill" data-f="west"></div></div><span data-hp="west"></span><span class="r3-roster" data-roster="west"></span></div>
    <div class="r3-mid" data-mid></div>
    <div class="r3-side east"><span class="r3-name" style="color:${TEAM_COLOR.east}">Восток</span><div class="r3-bar"><div class="r3-fill" data-f="east"></div></div><span data-hp="east"></span><span class="r3-roster" data-roster="east"></span></div>`
  overlay.appendChild(hudTop)
  banner = document.createElement('div')
  banner.className = 'r3-banner'
  banner.hidden = true
  overlay.appendChild(banner)
}

function hpColor(r: number) {
  return r > 0.6 ? '#46d36a' : r > 0.3 ? '#f2c14e' : '#ef5a4a'
}

function updateHud(state: GameState) {
  for (const t of ['west', 'east'] as Team[]) {
    const c = state.castles[t]
    const r = Math.max(0, c.hp / c.maxHp)
    const f = hudTop.querySelector<HTMLDivElement>(`[data-f="${t}"]`)!
    f.style.width = `${r * 100}%`
    f.style.background = hpColor(r)
    hudTop.querySelector(`[data-hp="${t}"]`)!.textContent = `${Math.max(0, Math.round(c.hp))} / ${c.maxHp}`
    const roster = state.players.filter(p => p.team === t)
    hudTop.querySelector(`[data-roster="${t}"]`)!.textContent = roster.length > 1 ? roster.map(p => p.name).join(', ') : ''
  }
  hudTop.querySelector('[data-mid]')!.innerHTML = `Раунд ${state.round} из ${state.maxRounds}<br><b>${state.wins.west} : ${state.wins.east}</b>`
  if (state.phase === 'round_end') {
    const winner: Team = state.castles.west.hp <= 0 ? 'east' : 'west'
    banner.hidden = false
    banner.style.borderColor = TEAM_COLOR[winner]
    banner.style.color = TEAM_COLOR[winner]
    banner.textContent = `${winner === 'west' ? 'Запад' : 'Восток'} выиграл раунд!`
  } else if (state.phase === 'game_end') {
    const winner = state.wins.west > state.wins.east ? 'Запад' : 'Восток'
    banner.hidden = false
    banner.style.borderColor = '#ffd35c'
    banner.style.color = '#ffd35c'
    banner.textContent = `${winner} победил в матче!`
    if (state.notice) {
      const small = document.createElement('div')
      small.style.cssText = 'font-size:14px;color:#ddd;font-weight:normal;margin-top:6px'
      small.textContent = state.notice
      banner.appendChild(small)
    }
  } else {
    banner.hidden = true
  }
}

interface Floater { el: HTMLDivElement; pos: THREE.Vector3; t: number; life: number }
const floaters: Floater[] = []
function floatText(pos: THREE.Vector3, text: string, color: string) {
  if (floaters.length > 28) return
  const el = document.createElement('div')
  el.className = 'r3-float'
  el.textContent = text
  el.style.color = color
  overlay.appendChild(el)
  floaters.push({ el, pos: pos.clone(), t: 0, life: 1.1 })
}
function tickFloaters(dt: number) {
  const w = canvasEl.clientWidth, h = canvasEl.clientHeight
  const v = new THREE.Vector3()
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]
    f.t += dt
    if (f.t >= f.life) { f.el.remove(); floaters.splice(i, 1); continue }
    v.copy(f.pos); v.y += f.t * 0.9
    v.project(camera)
    f.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(-50%,-50%)`
    f.el.style.left = '0'; f.el.style.top = '0'
    f.el.style.opacity = String(1 - (f.t / f.life) ** 2)
  }
}

// ── Полоски здоровья: все в двух InstancedMesh, всегда к камере ──────────────

const MAX_BARS = 1200
const bars = new Set<Bar>()
const barGeo = new THREE.PlaneGeometry(1, 1)
const barBg = new THREE.InstancedMesh(barGeo, new THREE.MeshBasicMaterial({ color: '#101418', transparent: true, opacity: 0.78, depthTest: false, depthWrite: false }), MAX_BARS)
// обе полоски прозрачные, чтобы порядок renderOrder соблюдался в одном проходе
const barFill = new THREE.InstancedMesh(barGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 1, depthTest: false, depthWrite: false }), MAX_BARS)
barBg.renderOrder = 10
barFill.renderOrder = 11
for (const m of [barBg, barFill]) { m.frustumCulled = false; m.count = 0 }
barFill.setColorAt(0, new THREE.Color('#ffffff'))

class Bar {
  /** Якорь в сцене: полоска рисуется над ним. */
  group = new THREE.Object3D()
  ratio = 1
  color = new THREE.Color('#46d36a')
  constructor(public w: number, public h: number, private fixed?: string) {
    bars.add(this)
    this.set(1)
  }
  set(r: number, color?: string) {
    this.ratio = Math.max(0.001, Math.min(1, r))
    this.color.set(color ?? this.fixed ?? hpColor(this.ratio))
  }
  dispose() { bars.delete(this) }
}

const _bm = new THREE.Matrix4(), _bp = new THREE.Vector3(), _bs = new THREE.Vector3(), _bc = new THREE.Vector3(), _br = new THREE.Vector3()
function shownInScene(o: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false
    if (p === scene) return true
  }
  return false
}
function updateBars() {
  const q = camera.quaternion
  _br.set(1, 0, 0).applyQuaternion(q)
  let n = 0
  for (const b of bars) {
    if (n >= MAX_BARS || !shownInScene(b.group)) continue
    b.group.getWorldPosition(_bp)
    _bm.compose(_bp, q, _bs.set(b.w, b.h, 1))
    barBg.setMatrixAt(n, _bm)
    const wi = b.w - b.h * 0.35
    const fw = wi * b.ratio
    _bc.copy(_bp).addScaledVector(_br, -wi / 2 + fw / 2)
    _bm.compose(_bc, q, _bs.set(fw, b.h * 0.62, 1))
    barFill.setMatrixAt(n, _bm)
    barFill.setColorAt(n, b.color)
    n++
  }
  barBg.count = barFill.count = n
  barBg.instanceMatrix.needsUpdate = true
  barFill.instanceMatrix.needsUpdate = true
  if (barFill.instanceColor) barFill.instanceColor.needsUpdate = true
}

// ── Кольцо команды под юнитом ───────────────────────────────────────────────

const ringGeo = new THREE.RingGeometry(0.3, 0.4, 28).rotateX(-Math.PI / 2)
const MAX_UNITS_DRAWN = 1500
const rings: Record<Team, THREE.InstancedMesh> = {
  west: new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: TEAM_COLOR.west, transparent: true, opacity: 0.75, depthWrite: false }), MAX_UNITS_DRAWN),
  east: new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: TEAM_COLOR.east, transparent: true, opacity: 0.75, depthWrite: false }), MAX_UNITS_DRAWN),
}
for (const r of Object.values(rings)) { r.renderOrder = 5; r.frustumCulled = false; r.count = 0 }
const blobTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32)
  grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(0.6, 'rgba(0,0,0,0.3)'); grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
})()
const blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, color: '#000000' }), MAX_UNITS_DRAWN)
blobs.renderOrder = 4
blobs.frustumCulled = false
blobs.count = 0

function updateRings() {
  const n = { west: 0, east: 0 }
  let nb = 0
  for (const v of unitViews.values()) {
    const b = v.ringScale * (v.dying ? 1.1 : 0.95)
    _bm.makeScale(b, 1, b).setPosition(v.root.position.x + 0.08, 0.025, v.root.position.z + 0.05)
    blobs.setMatrixAt(nb++, _bm)
    if (v.dying) continue
    const k = v.ringScale
    _bm.makeScale(k, 1, k).setPosition(v.root.position.x, 0.03, v.root.position.z)
    rings[v.team].setMatrixAt(n[v.team]++, _bm)
  }
  blobs.count = nb
  blobs.instanceMatrix.needsUpdate = true
  for (const t of ['west', 'east'] as Team[]) {
    rings[t].count = n[t]
    rings[t].instanceMatrix.needsUpdate = true
  }
}

// ── Юниты ────────────────────────────────────────────────────────────────────

interface UnitView {
  id: string; typeId: string; team: Team; vis: UnitVisual
  root: THREE.Group; body: THREE.Object3D; mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>; current: THREE.AnimationAction | null
  prev: THREE.Vector3; next: THREE.Vector3; recvAt: number
  yaw: number; faceYaw: number | null
  busyUntil: number
  bar: Bar; ringScale: number; mixDt: number
  hp: number; maxHp: number
  dying: boolean; deadAt: number
}
const unitViews = new Map<string, UnitView>()

/** Модель юнита с оружием, склеенная в 1–2 сетки. Строится один раз на тип. */
const unitTemplates = new Map<string, THREE.Object3D>()
function unitTemplate(typeId: string, vis: UnitVisual, g: GLTF): THREE.Object3D {
  let t = unitTemplates.get(typeId)
  if (t) return t
  t = SkeletonUtils.clone(g.scene)
  t.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh && o.parent && /handslot/.test(o.parent.name)) o.visible = (vis.show ?? []).includes(o.name)
  })
  for (const a of vis.attach ?? []) {
    const slot = t.getObjectByName(a.slot)
    slot?.add(asset(a.asset)!.scene.clone(true))
  }
  mergeCharacter(t)
  // скрытое запасное оружие из набора не нужно копировать в каждого юнита
  const hidden: THREE.Object3D[] = []
  t.traverse(o => { if ((o as THREE.Mesh).isMesh && !o.visible) hidden.push(o) })
  for (const o of hidden) o.parent?.remove(o)
  // юниты не рисуются в карту теней: у них пятно-тень под ногами (дешевле в разы)
  t.traverse(o => { (o as THREE.Mesh).castShadow = false })
  unitTemplates.set(typeId, t)
  return t
}

function makeUnit(u: Unit): UnitView | null {
  const vis = UNIT_VIS[u.typeId]
  if (!vis || !clips.length) return null
  const g = asset(vis.model)
  if (!g) return null
  for (const a of vis.attach ?? []) if (!asset(a.asset)) return null
  const body = SkeletonUtils.clone(unitTemplate(u.typeId, vis, g))
  const box = bbox(vis.model, g.scene)
  body.scale.setScalar(vis.height * UNIT_SCALE * (1 + 0.07 * ((u.level ?? 1) - 1)) / (box.max.y - box.min.y))
  const root = new THREE.Group()
  root.add(body)
  const bar = new Bar(vis.height > 1.5 ? 0.9 : 0.6, 0.085)
  bar.group.position.y = vis.height * UNIT_SCALE + 0.2
  bar.group.visible = false
  root.add(bar.group)
  const mixer = new THREE.AnimationMixer(body)
  const actions = new Map<string, THREE.AnimationAction>()
  for (const name of new Set([vis.idle, vis.move, vis.attack, vis.death, vis.hit])) {
    const clip = THREE.AnimationClip.findByName(clips, name)
    if (clip) actions.set(name, mixer.clipAction(clip))
  }
  const death = actions.get(vis.death)
  if (death) { death.setLoop(THREE.LoopOnce, 1); death.clampWhenFinished = true }
  for (const n of [vis.attack, vis.hit]) actions.get(n)?.setLoop(THREE.LoopOnce, 1)
  const p = new THREE.Vector3(wx(u.x), 0, wz(u.y))
  root.position.copy(p)
  const yaw = u.team === 'west' ? Math.PI / 2 : -Math.PI / 2
  root.rotation.y = yaw
  scene.add(root)
  const view: UnitView = {
    id: u.id, typeId: u.typeId, team: u.team, vis, root, body, mixer, actions, current: null,
    prev: p.clone(), next: p.clone(), recvAt: performance.now(), yaw, faceYaw: null, busyUntil: 0,
    bar, ringScale: (vis.height > 1.5 ? 1.6 : 1) * UNIT_SCALE, mixDt: 0, hp: u.hp, maxHp: u.maxHp, dying: false, deadAt: 0,
  }
  play(view, vis.idle, 0)
  mixer.update(Math.random() * 2)
  spawnPuff(p, u.team === 'west' ? '#cfe0ff' : '#ffd5cc', 8)
  return view
}

function play(v: UnitView, name: string, fade = 0.18, restart = false) {
  const a = v.actions.get(name)
  if (!a) return
  if (v.current === a && !restart) return
  a.reset().setEffectiveWeight(1).play()
  if (v.current && v.current !== a) v.current.crossFadeTo(a, fade, false)
  v.current = a
}

function removeUnitView(v: UnitView) {
  scene.remove(v.root)
  v.bar.dispose()
  v.mixer.stopAllAction()
  unitViews.delete(v.id)
}

// ── Здания ───────────────────────────────────────────────────────────────────

interface BuildingView { id: string; group: THREE.Group; bar: Bar; spawn: Bar; bornAt: number; typeId: string; team: Team; level: number; stars: THREE.Sprite; hp: number; hitAt: number; x: number; y: number }
const buildingViews = new Map<string, BuildingView>()

/** Композиция здания; null — если модели ещё грузятся. */
function composeBuilding(typeId: string, team: Team): THREE.Group | null {
  const kit = TEAM_KIT[team]
  const g = new THREE.Group()
  const add = (o: THREE.Object3D | null, x = 0, z = 0, ry = 0) => {
    if (!o) throw new Error('not ready')
    o.position.set(x, 0, z)
    o.rotation.y = ry
    g.add(o)
    return o
  }
  const flag = () => add(prop(`flag_${kit}`, { height: 0.75 }), 0.55, -0.5)
  try {
    switch (typeId) {
      case 'barracks': add(prop(`barracks_${kit}`, { fit: 1.35 })); add(prop('weaponrack', { height: 0.35 }), -0.55, 0.5, 0.4); break
      case 'rifle_range': add(prop(`archeryrange_${kit}`, { fit: 1.35 })); add(prop('target', { height: 0.4 }), 0.55, 0.55, -0.6); break
      case 'church': add(prop(`church_${kit}`, { fit: 1.3 })); break
      case 'mortar_battery': add(prop(`tower_catapult_${kit}`, { fit: 1.25 })); add(prop('barrel', { height: 0.28 }), -0.55, 0.5); break
      case 'crypt': add(prop('crypt', { fit: 1.25 })); add(prop('grave_A', { height: 0.3 }), -0.55, 0.55, 0.3); flag(); break
      case 'spider_lair':
        add(prop('arch_gate', { fit: 1.1 }), 0, -0.1)
        add(prop('tree_dead_large', { height: 1.1 }), -0.45, -0.35)
        add(prop('grave_B', { height: 0.28 }), 0.45, 0.5, -0.4)
        add(prop('gravestone', { height: 0.3 }), -0.4, 0.55, 0.3)
        flag(); break
      case 'necromancer_tower':
        add(prop(`tower_B_${kit}`, { fit: 1.0 }))
        add(prop('post_skull', { height: 0.55 }), -0.55, 0.5)
        add(prop('skull_candle', { height: 0.2 }), 0.5, 0.55)
        break
      case 'slaughterhouse':
        add(prop(`blacksmith_${kit}`, { fit: 1.3 }))
        add(prop('ribcage', { height: 0.3 }), -0.5, 0.55, 0.6)
        add(prop('bone_A', { height: 0.1 }), 0.45, 0.6, 1.2)
        break
      default: add(prop(`barracks_${kit}`, { fit: 1.3 }))
    }
  } catch {
    return null
  }
  // лицом к линии боя
  g.rotation.y = team === 'west' ? Math.PI / 2 : -Math.PI / 2
  return g
}

/** Склеенная композиция здания: копии дешевле, чем вся иерархия моделей. */
const buildingCache = new Map<string, THREE.Group>()
function flatBuilding(typeId: string, team: Team): THREE.Group | null {
  const key = `${typeId}:${team}`
  let flat = buildingCache.get(key)
  if (!flat) {
    const g = composeBuilding(typeId, team)
    if (!g) return null
    flat = flattenStatic(g)
    flat.rotation.copy(g.rotation)
    buildingCache.set(key, flat)
  }
  return flat.clone()
}

function removeBuildingView(bv: BuildingView) {
  markShadows()
  scene.remove(bv.group)
  bv.bar.dispose()
  bv.spawn.dispose()
  buildingViews.delete(bv.id)
}

function markShadows() { if (renderer) renderer.shadowMap.needsUpdate = true }

function makeBuilding(b: Building): BuildingView | null {
  markShadows()
  const g = flatBuilding(b.typeId, b.team)
  if (!g) return null
  const outer = new THREE.Group()
  outer.add(g)
  outer.position.set(wx(b.x), 0, wz(b.y))
  const bar = new Bar(1.1, 0.1)
  bar.group.position.y = 1.9
  bar.group.visible = false
  const spawn = new Bar(1.1, 0.07, '#ffd35c')
  spawn.group.position.y = 1.77
  const stars = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(1), depthTest: false, transparent: true }))
  stars.scale.set(0.9, 0.3, 1)
  stars.position.y = 2.12
  stars.renderOrder = 12
  outer.add(bar.group, spawn.group, stars)
  scene.add(outer)
  spawnPuff(outer.position, '#d8c7a4', 16)
  return { id: b.id, group: outer, bar, spawn, bornAt: performance.now(), typeId: b.typeId, team: b.team, level: 1, stars, hp: b.hp, hitAt: 0, x: b.x, y: b.y }
}

const starTex = new Map<number, THREE.CanvasTexture>()
function starTexture(level: number) {
  let t = starTex.get(level)
  if (!t) {
    const c = document.createElement('canvas')
    c.width = 192; c.height = 64
    const g = c.getContext('2d')!
    g.font = 'bold 50px sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 6
    g.strokeStyle = 'rgba(20,14,0,.85)'
    const text = '★'.repeat(level) + '☆'.repeat(3 - level)
    g.strokeText(text, 96, 34)
    g.fillStyle = '#ffd35c'
    g.fillText(text, 96, 34)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    starTex.set(level, t)
  }
  return t
}

// выделение здания
let selectedBuildingId: string | null = null
const selectRing = new THREE.Mesh(
  new THREE.RingGeometry(0.78, 0.92, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#ffd35c', transparent: true, opacity: 0.9, depthWrite: false }),
)
selectRing.renderOrder = 6
export function setSelectedBuilding(id: string | null) { selectedBuildingId = id }

/** Здание под курсором: луч по моделям зданий, запасной вариант — близость к точке на земле. */
export function pickBuilding(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null {
  const r = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
  raycaster.setFromCamera(ndc, camera)
  const views = [...buildingViews.values()]
  const hits = raycaster.intersectObjects(views.map(v => v.group.children[0]), true)
  if (hits.length) {
    let o: THREE.Object3D | null = hits[0].object
    while (o) {
      const v = views.find(v => v.group === o)
      if (v) return v.id
      o = o.parent
    }
  }
  const g = unproject(clientX, clientY, canvas)
  let best: string | null = null
  let bd = 40
  for (const v of views) {
    const d = Math.hypot(v.x - g.x, v.y - g.y)
    if (d < bd) { bd = d; best = v.id }
  }
  return best
}

// руины разрушенных зданий
const ruins: { obj: THREE.Object3D; t: number }[] = []

// ── Замки и местность ───────────────────────────────────────────────────────

interface CastleView { group: THREE.Group; ruin: THREE.Object3D | null; bar: Bar; shakeUntil: number; lastHp: number; destroyed: boolean }
const castles: Partial<Record<Team, CastleView>> = {}
let terrainBuilt = false
let decorBuilt = false
const raceDecor: Partial<Record<Team, Race>> = {}
const baseZones: Partial<Record<Team, THREE.Mesh>> = {}

function buildTerrain(): boolean {
  const g = asset('hex_grass')
  if (!g) return false
  // гекс-плитка: одна InstancedMesh на каждую часть модели
  const box = bbox('hex_grass', g.scene)
  const size = box.getSize(new THREE.Vector3())
  const pointy = size.z > size.x
  const k = 1.5 / Math.min(size.x, size.z)
  const hw = size.x * k, hd = size.z * k
  const cells: THREE.Matrix4[] = []
  const rng = mulberry(7)
  const place = (x: number, z: number) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, -box.max.y * k + (rng() - 0.5) * 0.02, z),
      new THREE.Quaternion(),
      new THREE.Vector3(k, k, k))
    cells.push(m)
  }
  if (pointy) {
    const dz = hd * 0.75
    for (let r = -16; r <= 16; r++) for (let c = -19; c <= 19; c++) place(c * hw + (r & 1 ? hw / 2 : 0), r * dz)
  } else {
    const dx = hw * 0.75
    for (let c = -26; c <= 26; c++) for (let r = -12; r <= 12; r++) place(c * dx, r * hd + (c & 1 ? hd / 2 : 0))
  }
  g.scene.updateMatrixWorld(true)
  g.scene.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    // тайлы KayKit жёлто-зелёные: подкрашиваем в сочную траву
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone()
    mat.color.set('#79ad5c')
    const inst = new THREE.InstancedMesh(mesh.geometry, mat, cells.length)
    const local = mesh.matrixWorld
    cells.forEach((m, i) => inst.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, local)))
    inst.receiveShadow = true
    scene.add(inst)
  })
  // линия боя: утоптанная земля
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(31, 5.2), new THREE.MeshStandardMaterial({
    map: dirtTexture(), transparent: true, roughness: 1, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2,
  }))
  lane.rotation.x = -Math.PI / 2
  lane.position.set(0, 0.012, 0)
  lane.renderOrder = 1
  lane.receiveShadow = true
  scene.add(lane)
  // зоны баз: где можно строить
  for (const team of ['west', 'east'] as Team[]) {
    const z = BASE_ZONE[team]
    const w = (z.x1 - z.x0) * S, d = (z.y1 - z.y0) * S
    const zone = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: zoneTexture(TEAM_COLOR[team]), transparent: true, opacity: 0.0, depthWrite: false,
    }))
    zone.position.set(wx((z.x0 + z.x1) / 2), 0.025, wz((z.y0 + z.y1) / 2))
    zone.renderOrder = 2
    scene.add(zone)
    baseZones[team] = zone
  }
  return true
}

function zoneTexture(color: string) {
  const c = document.createElement('canvas')
  c.width = 512; c.height = 560
  const g = c.getContext('2d')!
  g.fillStyle = color
  g.globalAlpha = 0.16
  g.fillRect(0, 0, c.width, c.height)
  g.globalAlpha = 0.95
  g.strokeStyle = color
  g.lineWidth = 10
  g.setLineDash([34, 20])
  g.strokeRect(6, 6, c.width - 12, c.height - 12)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function dirtTexture() {
  const c = document.createElement('canvas')
  c.width = 1024; c.height = 176
  const g = c.getContext('2d')!
  const img = g.createImageData(c.width, c.height)
  const rng = mulberry(3)
  for (let y = 0; y < c.height; y++) {
    const ey = Math.min(y, c.height - 1 - y) / 26
    for (let x = 0; x < c.width; x++) {
      const ex = Math.min(x, c.width - 1 - x) / 20
      const edge = Math.min(1, Math.min(ey, ex))
      const n = rng()
      const i = (y * c.width + x) * 4
      const base = 150 + n * 30
      img.data[i] = base * 0.93
      img.data[i + 1] = base * 0.78
      img.data[i + 2] = base * 0.55
      img.data[i + 3] = 255 * Math.max(0, edge - n * 0.35 * (1 - edge)) * 0.92
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function buildCastle(team: Team): CastleView | null {
  const kit = TEAM_KIT[team]
  const main = prop(`castle_${kit}`, { fit: 2.5 })
  const tower = prop(`tower_A_${kit}`, { height: 1.9 })
  const tower2 = prop(`tower_A_${kit}`, { height: 1.9 })
  const wall = prop('wall_straight', { height: 0.75 })
  const wall2 = prop('wall_straight', { height: 0.75 })
  const flagA = prop(`flag_${kit}`, { height: 1.1 })
  const flagB = prop(`flag_${kit}`, { height: 1.1 })
  if (!main || !tower || !tower2 || !wall || !wall2 || !flagA || !flagB) return null
  const g = new THREE.Group()
  g.add(main)
  tower.position.set(0.2, 0, -2.5); tower2.position.set(0.2, 0, 2.5)
  wall.position.set(0.2, 0, -1.65); wall2.position.set(0.2, 0, 1.65)
  wall.rotation.y = wall2.rotation.y = Math.PI / 2
  wall.scale.set(1, 1, 1.4); wall2.scale.set(1, 1, 1.4)
  flagA.position.set(1.0, 0, -1.25); flagB.position.set(1.0, 0, 1.25)
  g.add(tower, tower2, wall, wall2, flagA, flagB)
  const flat = flattenStatic(g)
  if (team === 'east') flat.rotation.y = Math.PI
  const outer = new THREE.Group()
  outer.add(flat)
  outer.position.set(wx(CASTLE_X[team]) + (team === 'west' ? -0.9 : 0.9), 0, 0)
  const bar = new Bar(2.4, 0.16)
  bar.group.position.y = 3.6
  outer.add(bar.group)
  scene.add(outer)
  return { group: outer, ruin: null, bar, shakeUntil: 0, lastHp: -1, destroyed: false }
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildDecor(): boolean {
  const names = ['trees_A_large', 'trees_A_medium', 'trees_B_large', 'trees_B_medium', 'tree_single_A', 'tree_single_B',
    'mountain_A', 'mountain_B', 'mountain_C', 'hills_A', 'hills_B', 'rock_A', 'rock_B', 'rock_C', 'cloud_big']
  if (names.some(n => !asset(n))) return false
  const rng = mulberry(11)
  // одинаковые модели рисуются одной InstancedMesh: место, поворот и масштаб — в матрице экземпляра
  const batches = new Map<string, THREE.Matrix4[]>()
  const put = (name: string, x: number, z: number, opts: { fit?: number; height?: number }) => {
    const g = asset(name)!
    const box = bbox(name, g.scene)
    const size = box.getSize(new THREE.Vector3())
    const k = opts.height ? opts.height / size.y : (opts.fit ?? 1) / Math.max(size.x, size.z)
    const c = box.getCenter(new THREE.Vector3())
    const m = new THREE.Matrix4().makeRotationY(rng() * Math.PI * 2).setPosition(x, 0, z)
      .multiply(new THREE.Matrix4().makeTranslation(-c.x * k, -box.min.y * k, -c.z * k))
      .multiply(new THREE.Matrix4().makeScale(k, k, k))
    const list = batches.get(name) ?? []
    list.push(m)
    batches.set(name, list)
  }
  const flush = () => {
    for (const [name, list] of batches) {
      const g = asset(name)!
      g.scene.updateMatrixWorld(true)
      g.scene.traverse(o => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length)
        list.forEach((m, i) => inst.setMatrixAt(i, _bm.multiplyMatrices(m, mesh.matrixWorld)))
        inst.castShadow = !name.startsWith('rock')
        inst.receiveShadow = true
        scene.add(inst)
      })
    }
  }
  const inField = (x: number, z: number) => Math.abs(x) < 17.5 && Math.abs(z) < 6.3
  // дальний край: горы и холмы
  for (let i = 0; i < 14; i++) {
    const x = -26 + i * 4 + rng() * 2
    put(['mountain_A', 'mountain_B', 'mountain_C'][i % 3], x, -12.5 - rng() * 3, { fit: 5 + rng() * 2.5 })
  }
  for (let i = 0; i < 10; i++) put(i % 2 ? 'hills_A' : 'hills_B', -24 + i * 5.3 + rng(), -9 - rng() * 1.5, { fit: 3.2 })
  // леса по краям
  for (let i = 0; i < 90; i++) {
    const side = rng()
    let x: number, z: number
    if (side < 0.45) { x = -24 + rng() * 48; z = -6.6 - rng() * 3 }
    else if (side < 0.7) { x = -24 + rng() * 48; z = 7.2 + rng() * 5 }
    else { x = (rng() < 0.5 ? -1 : 1) * (18 + rng() * 6); z = -8 + rng() * 17 }
    if (inField(x, z)) continue
    const tall = z < 0
    put(['trees_A_large', 'trees_B_large', 'trees_A_medium', 'trees_B_medium', 'tree_single_A', 'tree_single_B'][Math.floor(rng() * 6)],
      x, z, { fit: tall ? 1.3 + rng() * 0.6 : 0.9 + rng() * 0.4 })
  }
  for (let i = 0; i < 30; i++) {
    const x = -22 + rng() * 44, z = (rng() < 0.5 ? -1 : 1) * (5.6 + rng() * 5)
    if (inField(x, z)) continue
    put(['rock_A', 'rock_B', 'rock_C'][i % 3], x, z, { fit: 0.4 + rng() * 0.5 })
  }
  // передний план: речка, перелески и камни
  const river = new THREE.Mesh(new THREE.PlaneGeometry(70, 2.2, 60, 1), new THREE.MeshStandardMaterial({
    color: '#4f9bd1', roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.9,
  }))
  river.rotation.x = -Math.PI / 2
  const rp = river.geometry.attributes.position
  for (let i = 0; i < rp.count; i++) rp.setY(i, rp.getY(i) + Math.sin(rp.getX(i) * 0.35) * 0.9)
  river.geometry.computeVertexNormals()
  river.position.set(0, 0.03, 12.5)
  river.receiveShadow = true
  scene.add(river)
  for (let i = 0; i < 70; i++) {
    const x = -26 + rng() * 52
    const z = 7.2 + rng() * 11
    const onRiver = Math.abs(z - (12.5 - Math.sin(x * 0.35) * 0.9)) < 1.6
    if (onRiver) continue
    const r = rng()
    if (r < 0.62) put(['trees_A_medium', 'trees_B_medium', 'tree_single_A', 'tree_single_B', 'trees_A_large'][Math.floor(rng() * 5)], x, z, { fit: 1.0 + rng() * 0.8 })
    else if (r < 0.85) put(['rock_A', 'rock_B', 'rock_C'][Math.floor(rng() * 3)], x, z, { fit: 0.4 + rng() * 0.6 })
    else put(rng() < 0.5 ? 'hills_A' : 'hills_B', x, z, { fit: 2.2 + rng() })
  }
  flush()
  // облака — отдельными объектами: они двигаются
  for (let i = 0; i < 6; i++) {
    const c = prop('cloud_big', { fit: 3 + rng() * 2 })!
    c.position.set(-20 + i * 8, 7 + rng() * 2, -10 + rng() * 12)
    scene.add(c)
    c.userData.drift = 0.15 + rng() * 0.2
    c.traverse(o => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false })
    clouds.push(c)
  }
  return true
}
const clouds: THREE.Object3D[] = []

/** Могилы и мёртвые деревья вокруг базы нежити. */
function decorateRace(team: Team, race: Race) {
  if (raceDecor[team] === race) return
  if (race !== 'undead') { raceDecor[team] = race; return }
  const names = ['grave_A', 'grave_B', 'gravestone', 'tree_dead_large', 'tree_dead_medium', 'lantern']
  if (names.some(n => !asset(n))) return
  raceDecor[team] = race
  const rng = mulberry(team === 'west' ? 21 : 37)
  const sx = team === 'west' ? -1 : 1
  for (let i = 0; i < 16; i++) {
    const x = sx * (11 + rng() * 6.5)
    const z = (rng() < 0.5 ? -1 : 1) * (4.2 + rng() * 2.4)
    const n = names[Math.floor(rng() * names.length)]
    const o = prop(n, { height: n.startsWith('tree') ? 1.2 + rng() * 0.6 : n === 'lantern' ? 0.6 : 0.3 })!
    o.position.set(x, 0, z)
    o.rotation.y = rng() * 6.28
    scene.add(o)
  }
}

// ── Снаряды и частицы ───────────────────────────────────────────────────────

interface Projectile { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; arc: number; kind: ProjKind; team: Team }
const projectiles: Projectile[] = []
const MAX_PARTS = 900
const parts = {
  n: 0,
  pos: new Float32Array(MAX_PARTS * 3), vel: new Float32Array(MAX_PARTS * 3),
  t: new Float32Array(MAX_PARTS), life: new Float32Array(MAX_PARTS), size: new Float32Array(MAX_PARTS),
  grow: new Float32Array(MAX_PARTS), grav: new Float32Array(MAX_PARTS), col: new Float32Array(MAX_PARTS * 3),
}
const partMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }), MAX_PARTS)
partMesh.frustumCulled = false
partMesh.count = 0
partMesh.setColorAt(0, new THREE.Color('#ffffff'))
const beamGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true).rotateX(Math.PI / 2)
const orbGeo = new THREE.SphereGeometry(0.11, 12, 8)
const orbMat = new THREE.MeshBasicMaterial({ color: '#c77dff' })
const beams: { mesh: THREE.Mesh; t: number }[] = []
const _pc = new THREE.Color()

function spawnParticle(pos: THREE.Vector3, color: string, vel: THREE.Vector3, life = 0.6, size = 1, grow = 0, gravity = -4) {
  if (parts.n >= MAX_PARTS || particleBudget <= 0) return
  const i = parts.n++
  parts.pos.set([pos.x, pos.y, pos.z], i * 3)
  parts.vel.set([vel.x, vel.y, vel.z], i * 3)
  parts.t[i] = 0; parts.life[i] = life; parts.size[i] = size; parts.grow[i] = grow; parts.grav[i] = gravity
  _pc.set(color)
  parts.col.set([_pc.r, _pc.g, _pc.b], i * 3)
}

function tickParticles(dt: number) {
  const P = parts
  for (let i = 0; i < P.n; i++) {
    P.t[i] += dt
    if (P.t[i] >= P.life[i]) {
      // на место умершей — последнюю
      const last = --P.n
      if (i !== last) {
        for (const [arr, k] of [[P.pos, 3], [P.vel, 3], [P.col, 3]] as [Float32Array, number][]) arr.copyWithin(i * k, last * k, last * k + k)
        for (const arr of [P.t, P.life, P.size, P.grow, P.grav]) arr[i] = arr[last]
        i--
      }
      continue
    }
    P.vel[i * 3 + 1] += P.grav[i] * dt
    P.pos[i * 3] += P.vel[i * 3] * dt
    P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt
    P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt
    if (P.pos[i * 3 + 1] < 0.02) { P.pos[i * 3 + 1] = 0.02; P.vel[i * 3] *= 0.5; P.vel[i * 3 + 1] = 0; P.vel[i * 3 + 2] *= 0.5 }
  }
  for (let i = 0; i < P.n; i++) {
    const k = P.t[i] / P.life[i]
    const sc = P.size[i] * (1 + P.grow[i] * P.t[i]) * Math.sqrt(1 - k)
    _bm.makeScale(sc, sc, sc).setPosition(P.pos[i * 3], P.pos[i * 3 + 1], P.pos[i * 3 + 2])
    partMesh.setMatrixAt(i, _bm)
    partMesh.setColorAt(i, _pc.setRGB(P.col[i * 3], P.col[i * 3 + 1], P.col[i * 3 + 2]))
  }
  partMesh.count = P.n
  partMesh.instanceMatrix.needsUpdate = true
  if (partMesh.instanceColor) partMesh.instanceColor.needsUpdate = true
}

function spawnPuff(pos: THREE.Vector3, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    spawnParticle(new THREE.Vector3(pos.x + Math.cos(a) * 0.2, 0.1, pos.z + Math.sin(a) * 0.2), color,
      new THREE.Vector3(Math.cos(a) * 0.8, 0.6 + Math.random() * 0.6, Math.sin(a) * 0.8), 0.7, 1.6, 2.5, -0.5)
  }
}
function explode(pos: THREE.Vector3, color: string, n = 18) {
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.3, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 2.5)
    spawnParticle(pos, color, v, 0.5 + Math.random() * 0.4, 1.2 + Math.random(), 1.5, -6)
  }
}

/** Повернуть модель длинной осью вдоль +Z и задать длину (для lookAt). */
function alongZ(o: THREE.Object3D | null, length: number): THREE.Object3D | null {
  if (!o) return null
  const inner = o.children[0]
  const size = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z)
  if (longest === size.y) inner.rotation.x = Math.PI / 2
  else if (longest === size.x) inner.rotation.y = -Math.PI / 2
  o.scale.setScalar(length / longest)
  const g = new THREE.Group()
  g.add(o)
  const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3())
  o.position.sub(c)
  return g
}

function launch(u: UnitView, target: THREE.Vector3 | null) {
  const kind = u.vis.proj
  if (kind === 'none' || !target) return
  const from = u.root.position.clone(); from.y = u.vis.hand
  const to = target.clone(); to.y = 0.55
  if (kind === 'beam') {
    const mesh = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: '#fff6c2', transparent: true, opacity: 0.9, depthWrite: false }))
    mesh.position.copy(from).lerp(to, 0.5)
    mesh.scale.set(1, 1, from.distanceTo(to))
    mesh.lookAt(to)
    scene.add(mesh)
    beams.push({ mesh, t: 0 })
    for (let i = 0; i < 6; i++) spawnParticle(to, '#fff4a8', new THREE.Vector3((Math.random() - 0.5), 1 + Math.random(), (Math.random() - 0.5)), 0.6, 1, 0.5, -1)
    return
  }
  let obj: THREE.Object3D | null = null
  if (kind === 'bolt') obj = alongZ(prop('arrow', { scale: 1 }), 0.55)
  if (kind === 'stone') obj = prop('stone', { fit: 0.3 })
  if (kind === 'orb') {
    obj = new THREE.Mesh(orbGeo, orbMat)
  }
  if (!obj) return
  scene.add(obj)
  const dist = from.distanceTo(to)
  const cfg = kind === 'stone' ? { dur: 1.2, arc: 2.6 } : kind === 'orb' ? { dur: 0.6, arc: 0.6 } : { dur: dist / 14, arc: 0.25 }
  projectiles.push({ obj, from, to, t: 0, dur: cfg.dur, arc: cfg.arc, kind, team: u.team })
}

function tickFx(dt: number) {
  const tmp = new THREE.Vector3()
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i]
    p.t += dt / p.dur
    const t = Math.min(1, p.t)
    const pos = tmp.lerpVectors(p.from, p.to, t)
    pos.y += Math.sin(Math.PI * t) * p.arc
    const prevPos = p.obj.position.clone()
    p.obj.position.copy(pos)
    if (p.kind === 'bolt' || p.kind === 'stone') {
      const ahead = new THREE.Vector3().lerpVectors(p.from, p.to, Math.min(1, t + 0.02))
      ahead.y += Math.sin(Math.PI * Math.min(1, t + 0.02)) * p.arc
      if (p.kind === 'bolt') p.obj.lookAt(ahead)
      else p.obj.rotation.x += dt * 8
    }
    if (p.kind === 'orb' && Math.random() < 0.6) spawnParticle(prevPos, '#b56cff', new THREE.Vector3(0, 0.2, 0), 0.35, 0.8, -1, 0)
    if (p.t >= 1) {
      scene.remove(p.obj)
      projectiles.splice(i, 1)
      if (p.kind === 'stone') { explode(p.to, '#ff9d3b', 22); explode(p.to, '#6d5a47', 10) }
      else if (p.kind === 'orb') explode(p.to, '#c77dff', 12)
      else explode(p.to, '#e9e0c9', 5)
    }
  }
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i]
    b.t += dt
    ;(b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - b.t / 0.3)
    if (b.t >= 0.3) { scene.remove(b.mesh); (b.mesh.material as THREE.Material).dispose(); beams.splice(i, 1) }
  }
  tickParticles(dt)
  for (const c of clouds) {
    c.position.x += c.userData.drift * dt
    if (c.position.x > 30) c.position.x = -30
  }
}

// ── Синхронизация с состоянием сервера ──────────────────────────────────────

let lastState: GameState | null = null
/** Средний интервал между состояниями сервера, мс: по нему юниты плавно доезжают до новой точки. */
let stateGap = 50
let lastStateAt = 0
let lastRound = -1
const castleHp: Record<Team, number> = { west: -1, east: -1 }

/** Оставлена для совместимости с main.ts: вся синхронизация идёт в render(). */
export function updateEffects(_state: GameState) {}

function clearUnits() {
  for (const v of [...unitViews.values()]) removeUnitView(v)
  for (const p of projectiles) scene.remove(p.obj)
  projectiles.length = 0
}

function syncState(state: GameState) {
  const now = performance.now()
  if (lastStateAt) stateGap = THREE.MathUtils.clamp(stateGap * 0.8 + (now - lastStateAt) * 0.2, 30, 250)
  lastStateAt = now
  if (state.round !== lastRound || state.phase === 'lobby') {
    clearUnits()
    for (const b of [...buildingViews.values()]) removeBuildingView(b)
    lastRound = state.round
  }
  for (const p of state.players) decorateRace(p.team, p.race)

  // юниты
  const seen = new Set<string>()
  const byId = new Map(state.units.map(u => [u.id, u]))
  for (const u of state.units) {
    seen.add(u.id)
    let v = unitViews.get(u.id)
    if (!v) {
      const made = makeUnit(u)
      if (!made) continue
      v = made
      unitViews.set(u.id, v)
    }
    // интерполяция: от текущей точки к новой за один тик сервера
    v.prev.copy(v.root.position)
    v.next.set(wx(u.x), 0, wz(u.y))
    v.recvAt = now
    // урон и лечение
    if (u.hp < v.hp) {
      floatText(new THREE.Vector3(v.next.x, v.vis.height * UNIT_SCALE + 0.3, v.next.z), `-${Math.round(v.hp - u.hp)}`, '#ff6b5e')
      if (now > v.busyUntil) { play(v, v.vis.hit, 0.08, true); v.busyUntil = now + 350 }
    } else if (u.hp > v.hp) {
      floatText(new THREE.Vector3(v.next.x, v.vis.height * UNIT_SCALE + 0.3, v.next.z), `+${Math.round(u.hp - v.hp)}`, '#6cf09a')
      for (let i = 0; i < 5; i++) spawnParticle(new THREE.Vector3(v.next.x, 0.3, v.next.z), '#9dffb9', new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.2, (Math.random() - 0.5) * 0.4), 0.8, 1, 0, 0)
    }
    v.hp = u.hp; v.maxHp = u.maxHp
    v.bar.set(u.hp / u.maxHp)
    v.bar.group.visible = u.hp < u.maxHp
    // выстрел: кулдаун только что взведён
    const prevCd = (v.root.userData.cd as number | undefined) ?? 0
    if (prevCd === 0 && u.attackCooldown > 0) {
      const target = pickTarget(u, state)
      const tp = target ? new THREE.Vector3(wx(target.x), 0, wz(target.y)) : null
      if (tp) v.faceYaw = Math.atan2(tp.x - v.next.x, tp.z - v.next.z)
      play(v, v.vis.attack, 0.08, true)
      const clip = v.actions.get(v.vis.attack)?.getClip()
      v.busyUntil = now + (clip ? clip.duration * 1000 * 0.85 : 600)
      const delay = v.vis.proj === 'stone' ? 380 : v.vis.proj === 'beam' || v.vis.proj === 'orb' ? 300 : 180
      setTimeout(() => { if (unitViews.has(v!.id)) launch(v!, tp) }, delay)
    }
    v.root.userData.cd = u.attackCooldown
  }
  // исчезнувшие юниты: смерть (или вход в замок)
  for (const v of [...unitViews.values()]) {
    if (seen.has(v.id) || v.dying) continue
    if (!byId.has(v.id)) {
      v.dying = true
      v.deadAt = now
      v.bar.group.visible = false
      play(v, v.vis.death, 0.1, true)
    }
  }

  // здания
  const bseen = new Set<string>()
  for (const b of state.buildings) {
    bseen.add(b.id)
    let bv = buildingViews.get(b.id)
    if (!bv) {
      const made = makeBuilding(b)
      if (!made) continue
      bv = made
      buildingViews.set(b.id, bv)
    }
    bv.bar.set(b.hp / b.maxHp)
    bv.bar.group.visible = b.hp < b.maxHp
    const interval = (BUILDING_TYPES[b.typeId]?.spawnInterval ?? 1) * spawnMult(b.level ?? 1)
    bv.spawn.set(1 - b.spawnTimer / interval, '#ffd35c')
    if ((b.level ?? 1) !== bv.level) {
      if ((b.level ?? 1) > bv.level) {
        const p = bv.group.position.clone(); p.y = 1.2
        explode(p, '#ffd35c', 20)
        floatText(new THREE.Vector3(p.x, 2.4, p.z), `Уровень ${b.level}!`, '#ffd35c')
      }
      bv.level = b.level ?? 1
      markShadows()
      ;(bv.stars.material as THREE.SpriteMaterial).map = starTexture(bv.level)
      ;(bv.stars.material as THREE.SpriteMaterial).needsUpdate = true
    }
    if (b.hp < bv.hp) {
      bv.hitAt = now
      if (Math.random() < 0.5) {
        const p = bv.group.position.clone(); p.y = 0.6 + Math.random() * 0.6
        p.x += (Math.random() - 0.5) * 0.8; p.z += (Math.random() - 0.5) * 0.8
        explode(p, '#8a7a66', 4)
      }
    }
    bv.hp = b.hp
  }
  for (const [id, bv] of buildingViews) {
    if (bseen.has(id)) continue
    removeBuildingView(bv)
    if (state.phase === 'playing' && state.round === lastRound) {
      // разрушено: взрыв и руины
      const p = bv.group.position.clone()
      explode(new THREE.Vector3(p.x, 1.0, p.z), '#ff9d3b', 26)
      explode(new THREE.Vector3(p.x, 0.6, p.z), '#6d5a47', 20)
      spawnPuff(p, '#9b8f80', 18)
      const ruin = prop('building_destroyed', { fit: 1.3 })
      if (ruin) { ruin.traverse(o => { (o as THREE.Mesh).castShadow = false }); ruin.position.copy(p); ruin.rotation.y = Math.random() * 6; scene.add(ruin); ruins.push({ obj: ruin, t: 0 }) }
    }
  }

  // замки
  for (const t of ['west', 'east'] as Team[]) {
    const c = castles[t]
    if (!c) continue
    const hp = state.castles[t].hp
    if (castleHp[t] >= 0 && hp < castleHp[t]) {
      c.shakeUntil = now + 300
      const p = c.group.position.clone(); p.y = 1.2; p.x += t === 'west' ? 1.2 : -1.2
      explode(p, '#ffcf6b', 14)
      floatText(new THREE.Vector3(p.x, 3.2, p.z), `-${Math.round(castleHp[t] - hp)}`, '#ffb14e')
    }
    castleHp[t] = hp
    c.bar.set(hp / state.castles[t].maxHp)
    const destroyed = hp <= 0
    if (destroyed !== c.destroyed) {
      c.destroyed = destroyed
      markShadows()
      c.group.children[0].visible = !destroyed
      if (destroyed) {
        const ruin = prop('building_destroyed', { fit: 3 })
        if (ruin) { c.group.add(ruin); c.ruin = ruin }
        explode(new THREE.Vector3(c.group.position.x, 1.5, 0), '#ff8a3b', 40)
        explode(new THREE.Vector3(c.group.position.x, 1.0, 0), '#5d5249', 30)
      } else if (c.ruin) {
        c.group.remove(c.ruin); c.ruin = null
      }
    }
  }
  updateHud(state)
}

function pickTarget(u: Unit, state: GameState): Unit | null {
  const type = UNIT_TYPES[u.typeId]
  const healer = u.typeId === 'priest'
  let best: Unit | null = null
  let bd = Infinity
  for (const o of state.units) {
    if (o.id === u.id) continue
    if (healer ? (o.team !== u.team || o.hp >= o.maxHp) : o.team === u.team) continue
    const d = Math.hypot(o.x - u.x, o.y - u.y)
    if (d < bd && d <= type.range * 1.2) { bd = d; best = o }
  }
  if (!best && !healer) {
    // по замку
    const cx = u.team === 'west' ? CASTLE_X.east : CASTLE_X.west
    return { ...u, x: cx, y: 400 }
  }
  return best
}

// ── Кадр ─────────────────────────────────────────────────────────────────────

const noAutoQuality = new URLSearchParams(location.search).has('noauto')
let fpsAvg = 60
let frameMsAvg = 0
let lastFrameAt = 0
let frameNo = 0

// Автокачество: 0 — полное, 1 — ниже разрешение, 2 — без теней, 3 — анимация через кадр и меньше частиц
let quality = 0
let particleBudget = 1
let qualityCheckAt = 0
let goodSince = 0
function applyQuality() {
  const dpr = Math.min(window.devicePixelRatio, 1.5)
  renderer.setPixelRatio(quality >= 1 ? Math.min(dpr, 1) : dpr)
  sun.castShadow = quality < 2
  markShadows()
  particleBudget = quality >= 3 ? 0.5 : 1
  resize()
}
function tuneQuality(now: number) {
  if (now < qualityCheckAt) return
  qualityCheckAt = now + 1500
  if (fpsAvg < 38 && quality < 3) {
    quality++
    goodSince = 0
    applyQuality()
  } else if (fpsAvg > 57 && quality > 0) {
    // повышаем осторожно: только после 8 с стабильной скорости
    if (!goodSince) goodSince = now
    else if (now - goodSince > 8000) { quality--; goodSince = 0; applyQuality() }
  } else {
    goodSince = 0
  }
}

let ghost: { typeId: string; team: Team; group: THREE.Group } | null = null

export function render(
  _canvas: HTMLCanvasElement,
  state: GameState,
  _myId: string,
  myTeam: Team,
  selectedBuilding: string | null,
  hover: { x: number; y: number } | null,
) {
  const dt = Math.min(clock.getDelta(), 0.05)
  const now = performance.now()
  if (lastFrameAt) fpsAvg = fpsAvg * 0.95 + (1000 / Math.max(1, now - lastFrameAt)) * 0.05
  lastFrameAt = now
  frameNo++
  if (!noAutoQuality) tuneQuality(now)
  // в большом бою анимации обновляются через кадр (по очереди у половины юнитов)
  const throttle = quality >= 3 || unitViews.size > 90
  let ui = 0
  if (!terrainBuilt) { terrainBuilt = buildTerrain(); if (terrainBuilt) markShadows() }
  if (!decorBuilt) { decorBuilt = buildDecor(); if (decorBuilt) markShadows() }
  for (const t of ['west', 'east'] as Team[]) if (!castles[t]) { castles[t] = buildCastle(t) ?? undefined; if (castles[t]) markShadows() }
  if (state !== lastState) { syncState(state); lastState = state }

  // юниты: движение, поворот, анимации
  for (const v of [...unitViews.values()]) {
    if (v.dying) {
      const t = (now - v.deadAt) / 1000
      if (t > 1.6) v.root.position.y = -(t - 1.6) * 0.6
      if (t > 3) removeUnitView(v)
      v.mixer.update(dt)
      continue
    }
    const k = Math.min(1, (now - v.recvAt) / stateGap)
    v.root.position.lerpVectors(v.prev, v.next, k)
    const moved = v.next.distanceTo(v.prev)
    const moving = moved > 0.004 * (stateGap / 50)
    if (moving) {
      const dir = new THREE.Vector3().subVectors(v.next, v.prev)
      v.faceYaw = Math.atan2(dir.x, dir.z)
    }
    if (v.faceYaw !== null) {
      let d = v.faceYaw - v.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      v.yaw += d * Math.min(1, dt * 10)
      v.root.rotation.y = v.yaw
    }
    if (now > v.busyUntil) {
      const move = v.actions.get(v.vis.move)
      if (moving && move) {
        play(v, v.vis.move)
        const speed = moved / (stateGap / 1000) / S
        move.timeScale = THREE.MathUtils.clamp(speed / (v.vis.moveBase * 20), 0.6, 1.6)
      } else {
        play(v, v.vis.idle)
      }
    }
    v.mixDt += dt
    if (!throttle || (ui++ + frameNo) % 2 === 0) { v.mixer.update(v.mixDt); v.mixDt = 0 }
  }

  // здания: появление, размер по уровню, дрожь от попаданий
  for (const bv of buildingViews.values()) {
    const t = Math.min(1, (now - bv.bornAt) / 450)
    if (t < 1 || now - bv.bornAt < 600) markShadows()
    const s = t < 1 ? 1 - Math.pow(1 - t, 3) * (1 - 0.2 * Math.sin(t * 9)) : 1
    const inner = bv.group.children[0]
    inner.scale.setScalar(Math.max(0.01, s * (1 + 0.09 * (bv.level - 1))))
    const shake = now - bv.hitAt < 160
    inner.position.x = shake ? (Math.random() - 0.5) * 0.06 : 0
    inner.position.z = shake ? (Math.random() - 0.5) * 0.06 : 0
  }
  const sel = selectedBuildingId ? buildingViews.get(selectedBuildingId) : undefined
  if (sel) {
    if (selectRing.parent !== scene) scene.add(selectRing)
    selectRing.position.set(sel.group.position.x, 0.04, sel.group.position.z)
    const k = 1 + 0.04 * Math.sin(now / 180)
    selectRing.scale.set(k, 1, k)
    ;(selectRing.material as THREE.MeshBasicMaterial).color.set(sel.team === 'west' ? '#9cc3ff' : '#ffb3a8')
  } else if (selectRing.parent) {
    scene.remove(selectRing)
  }
  for (let i = ruins.length - 1; i >= 0; i--) {
    const r = ruins[i]
    r.t += dt
    if (r.t > 4) r.obj.position.y = -(r.t - 4) * 0.5
    if (r.t > 6) { scene.remove(r.obj); ruins.splice(i, 1) }
  }
  // замки: тряска
  for (const t of ['west', 'east'] as Team[]) {
    const c = castles[t]
    if (!c) continue
    const inner = c.group.children[0]
    inner.position.x = now < c.shakeUntil ? (Math.random() - 0.5) * 0.12 : 0
  }

  // зона своей базы и призрак здания под курсором
  const placing = state.phase === 'playing' && !!selectedBuilding
  for (const team of ['west', 'east'] as Team[]) {
    const zone = baseZones[team]
    if (!zone) continue
    const mat = zone.material as THREE.MeshBasicMaterial
    const target = placing && team === myTeam ? 1 : 0
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 8)
    zone.visible = mat.opacity > 0.01
  }
  updateGhost(placing ? selectedBuilding : null, myTeam, hover, state)

  tickFx(dt)
  controls.update()
  updateRings()
  updateBars()
  renderer.render(scene, camera)
  tickFloaters(dt)
  frameMsAvg = frameMsAvg * 0.95 + (performance.now() - now) * 0.05
}

const ghostRingGeo = new THREE.RingGeometry(BUILDING_SPACING * S * 0.42, BUILDING_SPACING * S * 0.5, 40).rotateX(-Math.PI / 2)
const ghostRingMat = new THREE.MeshBasicMaterial({ color: '#6cf09a', transparent: true, opacity: 0.85, depthWrite: false })

function updateGhost(typeId: string | null, team: Team, hover: { x: number; y: number } | null, state: GameState) {
  if (!typeId || !hover) {
    if (ghost) ghost.group.visible = false
    return
  }
  if (!ghost || ghost.typeId !== typeId || ghost.team !== team) {
    if (ghost) scene.remove(ghost.group)
    const g = composeBuilding(typeId, team)
    if (!g) return
    g.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const mat = (m.material as THREE.MeshStandardMaterial).clone()
        mat.transparent = true
        mat.opacity = 0.6
        mat.depthWrite = false
        m.material = mat
        m.castShadow = false
      }
    })
    const outer = new THREE.Group()
    outer.add(g)
    const ring = new THREE.Mesh(ghostRingGeo, ghostRingMat)
    ring.position.y = 0.03
    ring.renderOrder = 6
    outer.add(ring)
    scene.add(outer)
    ghost = { typeId, team, group: outer }
  }
  const ok = canPlace(team, hover.x, hover.y, state.buildings).ok
  ghostRingMat.color.set(ok ? '#6cf09a' : '#ff5a4a')
  ghost.group.children[0].visible = true
  ghost.group.visible = true
  ghost.group.position.set(wx(hover.x), 0.02, wz(hover.y))
}

/** Сбросить сцену при переходе в другую комнату. */
export function resetScene() {
  clearUnits()
  for (const r of ruins) scene.remove(r.obj)
  ruins.length = 0
  selectedBuildingId = null
  for (const b of [...buildingViews.values()]) removeBuildingView(b)
  for (const t of ['west', 'east'] as Team[]) {
    castleHp[t] = -1
    const c = castles[t]
    if (c) {
      c.destroyed = false
      c.group.children[0].visible = true
      if (c.ruin) { c.group.remove(c.ruin); c.ruin = null }
    }
  }
  lastRound = -1
  lastState = null
  banner.hidden = true
}
