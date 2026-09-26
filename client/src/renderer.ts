// 3D-отрисовка «Битвы замков» на Three.js.
// Интерфейс тот же, что у 2D-версии (renderer2d.ts): initRenderer, render, updateEffects, unproject.
// Модели: KayKit (Kay Lousberg, CC0) — собираются скриптом scripts/build-assets.mjs в public/assets.
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeCharacter, flattenStatic } from './merge'
import type { GameState, Unit, Building, Team, Race, Strike } from './types'
import { UNIT_TYPES, BUILDING_TYPES, CASTLE_GUNS } from './data'
import { BASE_ZONE, BUILDING_SPACING, canPlace } from './placement'
import { spawnMult } from './upgrades'
import { STRIKE, canStrike, NUKE, canNuke } from './strike'
import { sfx } from './sound'
import { flyerModel, flap, setFlyerTeam, type FlyerModel } from './procedural'
import { LANE_Y } from './lanes'
import { WORLD_W, WORLD_H, CX, CY, CASTLE_POS } from './world'
import { frame as telemetryFrame, lastHitchInfo, type Sections } from './telemetry'

// ── Мир → сцена ──────────────────────────────────────────────────────────────
// Мир сервера: x 0..WORLD_W, y 0..WORLD_H (y растёт «к зрителю»). Сцена: X вправо, Z к зрителю, Y вверх.

const S = 0.02
const wx = (x: number) => (x - CX) * S
const wz = (y: number) => (y - CY) * S
const CASTLE_X = { west: CASTLE_POS.west.x, east: CASTLE_POS.east.x }
/** Половина поля в единицах сцены и во сколько раз оно больше первой карты (1600×800) — для декора и камеры. */
const FIELD_X = (WORLD_W / 2) * S, FIELD_Z = (WORLD_H / 2) * S
const KX = FIELD_X / 16, KZ = FIELD_Z / 8
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

type ProjKind = 'bolt' | 'stone' | 'beam' | 'orb' | 'ball' | 'rocket' | 'spear' | 'fire' | 'none'
interface UnitVisual {
  model: string
  height: number
  show?: string[]
  attach?: { asset: string; slot: 'handslotr' | 'handslotl' | 'chest' }[]
  idle: string; move: string; attack: string; death: string; hit: string
  moveBase: number
  proj: ProjKind
  hand: number
  /** Летун: своя модель, без скелета и анимаций KayKit. */
  flyer?: 'gryphon' | 'gargoyle'
  /** Бронетехника (модель танка Quaternius, CC0): танк или самоходная артиллерия с длинным стволом. */
  vehicle?: 'tank' | 'spg'
  /** Окраска техники по расе. */
  paint?: Race
  /** Анимации — из самой модели (Quaternius), а не общий набор KayKit. */
  ownAnims?: boolean
  /** Парит над землёй на такой высоте (духи, демоны, дракон). */
  hover?: number
  /** Противотанковое оружие за спиной (если куплено в здании): фаустпатрон или костяное копьё. */
  faust?: 'rocket' | 'spear'
}
/** Высота полёта летунов (сцена). */
const FLY_H = 1.55
const isFlying = (typeId: string) => !!UNIT_TYPES[typeId]?.flying
const VEHICLE = { model: 'tank', height: 0.75, idle: '', move: 'TankArmature|Tank_Forward', attack: '', death: '', hit: '', moveBase: 1.5 }

const UNIT_SCALE = 1.25
const UNIT_VIS: Record<string, UnitVisual> = {
  footman: { faust: 'rocket', model: 'knight', height: 1.08, show: ['1H_Sword', 'Round_Shield'], idle: 'Idle', move: 'Walking_A', attack: '1H_Melee_Attack_Chop', death: 'Death_A', hit: 'Hit_A', moveBase: 2.2, proj: 'none', hand: 0.6 },
  rifleman: { model: 'rogue', height: 1.0, show: ['2H_Crossbow'], idle: '2H_Ranged_Aiming', move: 'Walking_B', attack: '2H_Ranged_Shoot', death: 'Death_B', hit: 'Hit_A', moveBase: 2.0, proj: 'bolt', hand: 0.62 },
  priest: { model: 'mage', height: 1.02, show: ['2H_Staff'], idle: 'Idle', move: 'Walking_A', attack: 'Spellcast_Shoot', death: 'Death_A', hit: 'Hit_A', moveBase: 2.2, proj: 'beam', hand: 0.75 },
  mortar: { model: 'barbarian', height: 1.05, show: [], idle: 'Unarmed_Idle', move: 'Walking_B', attack: 'Throw', death: 'Death_B', hit: 'Hit_A', moveBase: 1.8, proj: 'stone', hand: 0.9 },
  ghoul: { faust: 'spear', model: 'skel_minion', height: 0.95, attach: [{ asset: 'skel_blade', slot: 'handslotr' }], idle: 'Idle', move: 'Running_A', attack: '1H_Melee_Attack_Slice_Diagonal', death: 'Death_A', hit: 'Hit_A', moveBase: 3.4, proj: 'none', hand: 0.55 },
  crypt_fiend: { model: 'skel_rogue', height: 1.0, attach: [{ asset: 'skel_crossbow', slot: 'handslotr' }, { asset: 'skel_quiver', slot: 'chest' }], idle: '2H_Ranged_Aiming', move: 'Walking_A', attack: '2H_Ranged_Shoot', death: 'Death_B', hit: 'Hit_A', moveBase: 2.1, proj: 'bolt', hand: 0.62 },
  necromancer: { model: 'skel_mage', height: 1.02, attach: [{ asset: 'skel_staff', slot: 'handslotr' }], idle: 'Idle', move: 'Walking_A', attack: 'Spellcast_Shoot', death: 'Death_A', hit: 'Hit_A', moveBase: 2.0, proj: 'orb', hand: 0.75 },
  cannon: { ...VEHICLE, proj: 'ball', hand: 0.75, vehicle: 'spg', paint: 'human' },
  bone_catapult: { ...VEHICLE, proj: 'stone', hand: 0.75, vehicle: 'spg', paint: 'undead' },
  steam_tank: { ...VEHICLE, proj: 'ball', hand: 0.6, vehicle: 'tank', paint: 'human' },
  death_tank: { ...VEHICLE, proj: 'ball', hand: 0.6, vehicle: 'tank', paint: 'undead' },
  // Орда: монстры Quaternius (CC0) со своими анимациями
  orc_grunt: { faust: 'spear', model: 'm_orc', ownAnims: true, height: 1.12, idle: 'Idle', move: 'Walk', attack: 'Weapon', death: 'Death', hit: 'HitReact', moveBase: 2.2, proj: 'none', hand: 0.6 },
  totem_spirit: { model: 'm_tribal', ownAnims: true, height: 0.95, hover: 0.35, idle: 'Flying_Idle', move: 'Fast_Flying', attack: 'Punch', death: 'Death', hit: 'HitReact', moveBase: 2.0, proj: 'fire', hand: 0.9 },
  demon: { model: 'm_demon', ownAnims: true, height: 0.95, hover: 0.45, idle: 'Flying_Idle', move: 'Fast_Flying', attack: 'Punch', death: 'Death', hit: 'HitReact', moveBase: 1.9, proj: 'orb', hand: 1.0 },
  yeti: { model: 'm_yeti', ownAnims: true, height: 1.7, idle: 'Idle', move: 'Walk', attack: 'Punch', death: 'Death', hit: 'HitReact', moveBase: 1.6, proj: 'none', hand: 1.0 },
  dragon: { model: 'm_dragon', ownAnims: true, height: 0.95, hover: FLY_H, idle: 'Flying_Idle', move: 'Fast_Flying', attack: 'Headbutt', death: 'Death', hit: 'HitReact', moveBase: 3.0, proj: 'none', hand: FLY_H },
  orc_catapult: { ...VEHICLE, proj: 'fire', hand: 0.75, vehicle: 'spg', paint: 'orc' },
  war_machine: { ...VEHICLE, proj: 'ball', hand: 0.6, vehicle: 'tank', paint: 'orc' },
  gryphon: { model: '', height: 0.9, idle: '', move: '', attack: '', death: '', hit: '', moveBase: 3, proj: 'none', hand: FLY_H, flyer: 'gryphon' },
  gargoyle: { model: '', height: 0.9, idle: '', move: '', attack: '', death: '', hit: '', moveBase: 3, proj: 'none', hand: FLY_H, flyer: 'gargoyle' },
  abomination: { model: 'skel_warrior', height: 1.75, attach: [{ asset: 'skel_axe', slot: 'handslotr' }, { asset: 'skel_shield', slot: 'handslotl' }], idle: 'Idle', move: 'Walking_B', attack: '1H_Melee_Attack_Chop', death: 'Death_A', hit: 'Hit_A', moveBase: 1.6, proj: 'none', hand: 1.0 },
}

// ── Сцена ────────────────────────────────────────────────────────────────────

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let sun: THREE.DirectionalLight
let hemi: THREE.HemisphereLight
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
  scene.fog = new THREE.Fog('#c9dcea', 38 * KX, 80 * KX)

  camera = new THREE.PerspectiveCamera(34, 2, 0.1, 300)
  controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
  controls.minDistance = 8
  controls.maxDistance = 40 * KX
  controls.minPolarAngle = 0.35
  controls.maxPolarAngle = 1.2
  controls.screenSpacePanning = false
  canvas.addEventListener('contextmenu', e => e.preventDefault())

  scene.add(barBg, barFill, rings.west, rings.east, blobs, partMesh)
  hemi = new THREE.HemisphereLight('#dfe9ff', '#46522c', 1.0)
  scene.add(hemi)
  scene.add(rain)
  sun = new THREE.DirectionalLight('#fff0d6', 2.1)
  sun.position.set(-9, 18, 10)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -24 * KX, right: 24 * KX, top: 16 * KZ, bottom: -16 * KZ, near: 1, far: 90 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.03
  scene.add(sun)

  makeOverlay(canvas)
  makePerfOverlay()
  // отладка/тесты: мир сервера -> координаты экрана
  ;(window as unknown as { __castle: unknown }).__castle = {
    perf() {
      const kinds: Record<string, number> = {}
      scene.traverse(o => { const k = (o as THREE.InstancedMesh).isInstancedMesh ? 'InstancedMesh' : o.type; kinds[k] = (kinds[k] || 0) + 1 })
      return { quality, sceneChildren: scene.children.length, kinds, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, fps: Math.round(fpsAvg), frameMs: +frameMsAvg.toFixed(2), units: unitViews.size, buildings: buildingViews.size, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }
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
    ...new Set(Object.values(UNIT_VIS).map(v => v.model).filter(Boolean)),
    ...Object.values(UNIT_VIS).flatMap(v => (v.attach ?? []).map(a => a.asset)),
    'arrow', 'stone', 'trees_A_large', 'trees_A_medium', 'trees_B_large', 'trees_B_medium', 'tree_single_A', 'tree_single_B',
    'mountain_A', 'mountain_B', 'mountain_C', 'hills_A', 'hills_B', 'rock_A', 'rock_B', 'rock_C', 'cloud_big',
    'barracks_blue', 'barracks_red', 'archeryrange_blue', 'archeryrange_red', 'church_blue', 'church_red',
    'tower_catapult_blue', 'tower_catapult_red', 'tower_B_blue', 'tower_B_red', 'blacksmith_blue', 'blacksmith_red',
    'crypt', 'arch_gate', 'grave_A', 'grave_B', 'gravestone', 'tree_dead_large', 'tree_dead_medium', 'coffin', 'ribcage',
    'bone_A', 'post_skull', 'skull_candle', 'lantern', 'weaponrack', 'target', 'barrel', 'crate', 'tent', 'floor_grave', 'shrine_candles', 'tank']
  Promise.all(first.map(load)).then(() => {
    clips = assets.get('anims')!.animations
    return Promise.all(rest.map(load))
  }).then(() => requestAnimationFrame(warmUp)).catch(() => { /* ошибки загрузки уже в консоли */ })
}

/**
 * Прогрев: шейдеры всех моделей компилируются заранее (пока игрок в меню),
 * а в запас кладётся по несколько юнитов каждого типа — в бою нет рывков
 * при первом появлении нового юнита, здания или снаряда.
 */
let warmedUp = false
function warmUp() {
  if (warmedUp || !clips.length) return
  warmedUp = true
  const tmp = new THREE.Group()
  for (const [typeId, vis] of Object.entries(UNIT_VIS)) {
    if (vis.vehicle && !asset('tank')) continue
    const g = vis.flyer || vis.vehicle ? undefined : asset(vis.model)
    if (!g && !vis.flyer && !vis.vehicle) continue
    const pool = unitPool.get(typeId) ?? []
    for (let i = 0; i < 6; i++) pool.push(createUnitView(typeId, vis, g!))
    unitPool.set(typeId, pool)
    tmp.add(pool[0].root)
  }
  for (const typeId of Object.keys(BUILDING_TYPES)) {
    for (const team of ['west', 'east'] as Team[]) {
      const b = flatBuilding(typeId, team)
      if (b) tmp.add(b)
    }
  }
  const arrow = alongZ(prop('arrow', { scale: 1 }), 0.55)
  const stone = prop('stone', { fit: 0.3 })
  const ruin = prop('building_destroyed', { fit: 1.3 })
  for (const o of [arrow, stone, ruin]) if (o) tmp.add(o)
  tmp.add(new THREE.Mesh(orbGeo, orbMat), new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ transparent: true })))
  tmp.position.set(0, -30, 0)
  scene.add(tmp)
  renderer.compile(scene, camera)
  scene.remove(tmp)
  // корни юнитов из запаса больше не нужны во временной группе
  for (const pool of unitPool.values()) for (const v of pool) tmp.remove(v.root)
}

function skyTexture(stops: [string, string, string] = ['#6f9fd6', '#b9d3ea', '#dfe9ef']) {
  const c = document.createElement('canvas')
  c.width = 4; c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, stops[0])
  grad.addColorStop(0.55, stops[1])
  grad.addColorStop(1, stops[2])
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
  const halfW = FIELD_X + 2.2
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const dist = Math.max(20 * KZ, halfW / (tanH * camera.aspect))
  const elev = THREE.MathUtils.degToRad(40)
  const target = new THREE.Vector3(0, 0, 1.2)
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
  return { x: hit.x / S + CX, y: hit.z / S + CY }
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

// ── Счётчик производительности (F3 или ` / ё) ───────────────────────────────

let perfEl: HTMLDivElement | null = null
let perfAt = 0
function makePerfOverlay() {
  perfEl = document.createElement('div')
  perfEl.style.cssText = 'position:absolute;left:10px;top:10px;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.72);color:#c8f7c5;font:12px/1.45 Consolas,monospace;white-space:pre;pointer-events:none;z-index:4'
  let on = false
  try { on = localStorage.getItem('cf.perf') === '1' } catch { /* нет хранилища */ }
  perfEl.hidden = !on
  overlay.appendChild(perfEl)
  window.addEventListener('keydown', e => {
    if (e.code !== 'F3' && e.code !== 'Backquote') return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    e.preventDefault()
    perfEl!.hidden = !perfEl!.hidden
    try { localStorage.setItem('cf.perf', perfEl!.hidden ? '0' : '1') } catch { /* нет хранилища */ }
  })
}
function hitchLine() {
  const h = lastHitchInfo()
  if (!h) return 'рывков не было'
  const top = Object.entries(h.sections).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ')
  const ago = Math.round((performance.now() - h.at) / 1000)
  return `последний рывок ${ago} с назад: ${h.interval} мс, код ${h.work} мс (${top})${h.outside ? ' — вне кода: видеокарта/сборка мусора' : ''}`
}

function updatePerfOverlay(now: number) {
  if (!perfEl || perfEl.hidden || now < perfAt) return
  perfAt = now + 250
  const net = (window as unknown as { __castle?: { net?: () => { worker: boolean; dropped: number } } }).__castle?.net?.()
  const qNames = ['полное', 'ниже разрешение', 'без теней', 'экономия']
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  perfEl.textContent = [
    `FPS ${Math.round(fpsAvg)}   кадр ${frameMsAvg.toFixed(1)} мс`,
    `отрисовок ${renderer.info.render.calls}   треуг. ${(renderer.info.render.triangles / 1000).toFixed(0)}k`,
    `юнитов ${unitViews.size}   зданий ${buildingViews.size}   частиц ${parts.n}`,
    `качество: ${qNames[quality]}${noAutoQuality ? ' (авто выкл.)' : ''}   разрешение ×${renderer.getPixelRatio().toFixed(2)}`,
    net ? `сеть: ${net.worker ? 'воркер' : 'главный поток'}, пропущено ${net.dropped}   обновл. ${Math.round(1000 / stateGap)}/с` : '',
    mem ? `память JS ${(mem.usedJSHeapSize / 1048576).toFixed(0)} МБ` : '',
    hitchLine(),
  ].filter(Boolean).join('\n')
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
    hudTop.querySelector(`[data-roster="${t}"]`)!.textContent = roster.length > 1 || roster.some(p => !p.connected) ? roster.map(p => p.name + (p.connected ? '' : ' (нет связи)')).join(', ') : ''
  }
  const cond = state.conditions
  const icons = `${cond?.night ? ' 🌙' : ''}${cond?.rain ? ' 🌧' : ''}`
  hudTop.querySelector('[data-mid]')!.innerHTML = `Раунд ${state.round} из ${state.maxRounds}${icons}<br><b>${state.wins.west} : ${state.wins.east}</b>`
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
  flyer?: FlyerModel; tank?: { recoil: THREE.Object3D; base: THREE.Vector3 }; faust?: THREE.Object3D; phase: number
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
  // у моделей Quaternius металличность 1 — без карты окружения они выходят почти чёрными
  if (vis.ownAnims) t.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const fix = (mat: THREE.Material) => {
      const c = (mat as THREE.MeshStandardMaterial).clone()
      c.metalness = 0
      c.roughness = Math.max(0.6, c.roughness)
      return c
    }
    m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material)
  })
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

/** Готовые юниты по типам: погибшие возвращаются сюда и выходят снова без копирования модели. */
const unitPool = new Map<string, UnitView[]>()
const POOL_MAX = 60

/** Окраска техники: у людей — сталь, у нежити — чёрное железо с костяной отделкой. */
const PAINT: Record<Race, Record<string, string>> = {
  human: { Main: '#5f6e7c', Main_Light: '#7f8e9b', Main_Dark: '#3a444e', Main_Details: '#2e3439', Wheels: '#383d42' },
  undead: { Main: '#3c4037', Main_Light: '#565a4b', Main_Dark: '#23261f', Main_Details: '#cfc7ae', Wheels: '#2a2a26' },
  orc: { Main: '#6b4a2b', Main_Light: '#8a6a3a', Main_Dark: '#3b2a1a', Main_Details: '#c9a24a', Wheels: '#2a2420' },
}
const paintCache = new Map<string, THREE.Material>()
function paint(m: THREE.Material, race: Race): THREE.Material {
  const key = `${race}:${m.name}`
  let c = paintCache.get(key)
  if (!c) {
    const mm = (m as THREE.MeshStandardMaterial).clone()
    mm.color.set(PAINT[race][m.name] ?? '#666666')
    mm.roughness = 0.65
    mm.metalness = 0.35
    c = mm
    paintCache.set(key, c)
  }
  return c
}

/** Танк или самоходка: модель Quaternius (гусеницы анимированы), ствол откатывается при выстреле. */
function createVehicleView(typeId: string, vis: UnitVisual): UnitView {
  const g = asset('tank')!
  const model = SkeletonUtils.clone(g.scene)
  model.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = false
    m.material = paint(m.material as THREE.Material, vis.paint ?? 'human')
  })
  // ствол: для отката (и у самоходки — длиннее и задран вверх, как у гаубицы)
  const gun = model.getObjectByName('Tank_Gun')!
  const pivot = new THREE.Group()
  pivot.position.set(-0.52, 3.9, -0.07)
  model.add(pivot)
  model.updateMatrixWorld(true)
  pivot.attach(gun)
  if (vis.vehicle === 'spg') {
    pivot.scale.set(1.6, 1.25, 1.25)
    pivot.rotation.z = -0.42
    model.getObjectByName('Tank_Turret')?.scale.multiplyScalar(1.12)
  }
  // модель смотрит вдоль −X — поворачиваем носом вперёд (+Z)
  const holder = new THREE.Group()
  model.rotation.y = Math.PI / 2
  holder.add(model)
  const root = new THREE.Group()
  root.add(holder)
  const bar = new Bar(0.9, 0.09)
  bar.dispose()
  bar.group.position.y = 1.15
  root.add(bar.group)
  const mixer = new THREE.AnimationMixer(model)
  const actions = new Map<string, THREE.AnimationAction>()
  const clip = g.animations.find(a => a.name === vis.move)
  if (clip) actions.set(vis.move, mixer.clipAction(clip))
  return {
    id: '', typeId, team: 'west', vis, root, body: holder, mixer, actions, current: null,
    prev: new THREE.Vector3(), next: new THREE.Vector3(), recvAt: 0, yaw: 0, faceYaw: null, busyUntil: 0,
    bar, ringScale: 1.9 * UNIT_SCALE, mixDt: 0, hp: 0, maxHp: 0, dying: false, deadAt: 0,
    tank: { recoil: pivot, base: pivot.position.clone() }, phase: Math.random() * 6,
  }
}

/** Летун: своя модель из простых фигур, машет крыльями. */
function createFlyerView(typeId: string, vis: UnitVisual): UnitView {
  const model = flyerModel(vis.flyer!, 'west')
  const root = new THREE.Group()
  root.add(model.group)
  const bar = new Bar(0.6, 0.085)
  bar.dispose()
  bar.group.position.y = FLY_H + 0.55
  root.add(bar.group)
  return {
    id: '', typeId, team: 'west', vis, root, body: model.group, mixer: new THREE.AnimationMixer(model.group), actions: new Map(), current: null,
    prev: new THREE.Vector3(), next: new THREE.Vector3(), recvAt: 0, yaw: 0, faceYaw: null, busyUntil: 0,
    bar, ringScale: 1.1 * UNIT_SCALE, mixDt: 0, hp: 0, maxHp: 0, dying: false, deadAt: 0, flyer: model, phase: Math.random() * 6,
  }
}

/** Новый юнит без привязки к серверному: модель, скелет, анимации, полоска здоровья. */
function createUnitView(typeId: string, vis: UnitVisual, g: GLTF): UnitView {
  if (vis.flyer) return createFlyerView(typeId, vis)
  if (vis.vehicle) return createVehicleView(typeId, vis)
  const body = SkeletonUtils.clone(unitTemplate(typeId, vis, g))
  const root = new THREE.Group()
  root.add(body)
  const bar = new Bar(vis.height > 1.5 ? 0.9 : 0.6, 0.085)
  bar.dispose()
  bar.group.position.y = vis.height * UNIT_SCALE + 0.2 + (vis.hover ?? 0)
  root.add(bar.group)
  const mixer = new THREE.AnimationMixer(body)
  const actions = new Map<string, THREE.AnimationAction>()
  // у моделей Quaternius анимации свои и называются «Armature|Walk»
  const source = vis.ownAnims ? g.animations : clips
  for (const name of new Set([vis.idle, vis.move, vis.attack, vis.death, vis.hit])) {
    const clip = source.find(c => c.name === name || c.name.endsWith(`|${name}`))
    if (clip) actions.set(name, mixer.clipAction(clip))
  }
  const death = actions.get(vis.death)
  if (death) { death.setLoop(THREE.LoopOnce, 1); death.clampWhenFinished = true }
  for (const n of [vis.attack, vis.hit]) actions.get(n)?.setLoop(THREE.LoopOnce, 1)
  let faust: THREE.Object3D | undefined
  if (vis.faust) {
    // труба (или копьё) наискосок за спиной
    faust = new THREE.Mesh(vis.faust === 'rocket' ? faustGeo : spearGeo, vis.faust === 'rocket' ? faustMat : spearMat)
    faust.position.set(0.14, 0.85, -0.2)
    faust.rotation.set(0.5, 0, -0.5)
    faust.visible = false
    root.add(faust)
  }
  return {
    id: '', typeId, team: 'west', vis, root, body, mixer, actions, current: null,
    prev: new THREE.Vector3(), next: new THREE.Vector3(), recvAt: 0, yaw: 0, faceYaw: null, busyUntil: 0,
    bar, ringScale: (vis.height > 1.5 ? 1.6 : 1) * UNIT_SCALE, mixDt: 0, hp: 0, maxHp: 0, dying: false, deadAt: 0,
    faust, phase: 0,
  }
}
const faustGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.6, 8)
const faustMat = new THREE.MeshStandardMaterial({ color: '#56632f', roughness: 0.7 })
const spearGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.8, 6)
const spearMat = new THREE.MeshStandardMaterial({ color: '#e3dcc6', roughness: 0.6 })

function makeUnit(u: Unit): UnitView | null {
  const vis = UNIT_VIS[u.typeId]
  if (!vis || !clips.length) return null
  const procedural = !!vis.flyer
  if (vis.vehicle && !asset('tank')) return null
  const g = procedural || vis.vehicle ? undefined : asset(vis.model)
  if (!g && !procedural && !vis.vehicle) return null
  for (const a of vis.attach ?? []) if (!asset(a.asset)) return null
  const pooled = unitPool.get(u.typeId)?.pop()
  if (pooled) frameReused++
  else frameCreated++
  const v = pooled ?? createUnitView(u.typeId, vis, g!)
  const lvl = 1 + 0.07 * ((u.level ?? 1) - 1)
  if (v.flyer) {
    v.body.scale.setScalar(0.72 * UNIT_SCALE * lvl)
    v.body.position.y = FLY_H
    v.body.rotation.set(0, 0, 0)
    setFlyerTeam(v.flyer, u.team)
  } else if (v.tank) {
    // модель ~15 единиц в длину → ~1,5 на поле
    v.body.scale.setScalar(0.085 * UNIT_SCALE * lvl)
    v.body.rotation.set(0, 0, 0)
    v.body.position.y = 0
    v.tank.recoil.position.copy(v.tank.base)
  } else {
    const box = bbox(vis.model, g!.scene)
    v.body.scale.setScalar(vis.height * UNIT_SCALE * lvl / (box.max.y - box.min.y))
    v.body.position.y = vis.hover ?? 0
    v.body.rotation.set(0, 0, 0)
  }
  if (v.faust) v.faust.visible = !!u.at
  v.root.userData.at = u.at ?? 0
  const p = new THREE.Vector3(wx(u.x), 0, wz(u.y))
  v.id = u.id
  v.team = u.team
  v.root.position.copy(p)
  v.prev.copy(p)
  v.next.copy(p)
  v.recvAt = performance.now()
  v.yaw = u.team === 'west' ? Math.PI / 2 : -Math.PI / 2
  v.root.rotation.y = v.yaw
  v.faceYaw = null
  v.busyUntil = 0
  v.hp = u.hp
  v.maxHp = u.maxHp
  v.dying = false
  v.deadAt = 0
  v.mixDt = 0
  v.root.userData.cd = 0
  v.bar.set(1)
  v.bar.group.visible = false
  bars.add(v.bar)
  v.mixer.stopAllAction()
  v.current = null
  play(v, vis.idle, 0)
  v.mixer.update(Math.random() * 2)
  scene.add(v.root)
  spawnPuff(p, u.team === 'west' ? '#cfe0ff' : '#ffd5cc', 8)
  return v
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
  v.root.position.y = 0
  const pool = unitPool.get(v.typeId) ?? []
  if (pool.length < POOL_MAX) { pool.push(v); unitPool.set(v.typeId, pool) }
}

// ── Здания ───────────────────────────────────────────────────────────────────

interface BuildingView { id: string; group: THREE.Group; bar: Bar; spawn: Bar; bornAt: number; typeId: string; team: Team; level: number; stars: THREE.Sprite; hp: number; hitAt: number; x: number; y: number; timer: number; ownRing: THREE.Mesh }
/** Свои здания: золотое кольцо под ними (общий материал — пульсирует у всех разом). */
const ownRingGeo = new THREE.RingGeometry(0.66, 0.78, 40).rotateX(-Math.PI / 2)
const ownRingMat = new THREE.MeshBasicMaterial({ color: '#ffd35c', transparent: true, opacity: 0.85, depthWrite: false })
let currentMyId = ''
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
      case 'foundry':
        add(prop(`blacksmith_${kit}`, { fit: 1.3 }))
        add(prop('barrel', { height: 0.28 }), -0.55, 0.5)
        add(prop('crate', { height: 0.25 }), 0.5, 0.55, 0.4)
        break
      case 'workshop':
        add(prop(`barracks_${kit}`, { fit: 1.2 }))
        add(prop('crate', { height: 0.25 }), -0.55, 0.5)
        add(prop('barrel', { height: 0.28 }), 0.5, 0.55)
        add(prop('weaponrack', { height: 0.35 }), -0.5, -0.5, 0.4)
        break
      case 'death_forge':
        add(prop(`blacksmith_${kit}`, { fit: 1.2 }))
        add(prop('skull_candle', { height: 0.22 }), -0.5, 0.55)
        add(prop('coffin', { height: 0.28 }), 0.5, 0.5, 0.5)
        flag(); break
      case 'aviary':
        add(prop('tent', { fit: 1.1 }), 0, 0.05)
        add(prop('tree_single_A', { height: 1.2 }), -0.45, -0.45)
        add(prop('crate', { height: 0.22 }), 0.5, 0.5, 0.3)
        flag(); break
      case 'bone_yard':
        add(prop('floor_grave', { fit: 1.25 }))
        add(prop('coffin', { height: 0.3 }), -0.25, -0.2, 0.3)
        add(prop('ribcage', { height: 0.35 }), 0.3, 0.1, -0.5)
        add(prop('post_skull', { height: 0.55 }), -0.55, 0.5)
        add(prop('bone_A', { height: 0.1 }), 0.45, 0.55, 1.2)
        flag(); break
      case 'gargoyle_spire':
        add(prop('shrine_candles', { fit: 0.9 }))
        add(prop('tree_dead_large', { height: 1.35 }), -0.45, -0.4)
        add(prop('gravestone', { height: 0.3 }), 0.45, 0.5, -0.3)
        flag(); break
      case 'war_camp':
        add(prop('tent', { fit: 1.15 }), 0, 0.05)
        add(prop('weaponrack', { height: 0.35 }), -0.55, 0.5, 0.4)
        add(prop('barrel', { height: 0.26 }), 0.5, 0.5)
        flag(); break
      case 'spirit_lodge':
        add(prop('tent', { fit: 1.0 }), 0, 0.05)
        add(prop('post_skull', { height: 0.55 }), -0.5, 0.5)
        add(prop('lantern', { height: 0.5 }), 0.5, 0.5)
        flag(); break
      case 'demon_gate':
        add(prop('arch_gate', { fit: 1.1 }), 0, -0.1)
        add(prop('skull_candle', { height: 0.22 }), -0.5, 0.5)
        add(prop('skull_candle', { height: 0.22 }), 0.5, 0.5)
        flag(); break
      case 'yeti_den':
        add(prop('rock_A', { fit: 1.25 }), 0, -0.05)
        add(prop('bone_A', { height: 0.1 }), 0.45, 0.55, 1.2)
        add(prop('ribcage', { height: 0.3 }), -0.5, 0.5, 0.6)
        flag(); break
      case 'siege_yard':
        add(prop(`blacksmith_${kit}`, { fit: 1.2 }))
        add(prop('barrel', { height: 0.28 }), -0.55, 0.5)
        add(prop('crate', { height: 0.24 }), 0.5, 0.5, 0.4)
        break
      case 'dragon_roost':
        add(prop(`tower_catapult_${kit}`, { fit: 1.15 }))
        add(prop('bone_A', { height: 0.1 }), -0.45, 0.55, 0.8)
        flag(); break
      case 'war_forge':
        add(prop(`blacksmith_${kit}`, { fit: 1.25 }))
        add(prop('weaponrack', { height: 0.35 }), -0.5, 0.5, 0.4)
        add(prop('barrel', { height: 0.28 }), 0.5, 0.5)
        break
      case 'orc_tower':
        add(prop(`tower_A_${kit}`, { fit: 0.95 }))
        add(prop('post_skull', { height: 0.55 }), -0.5, 0.45)
        flag(); break
      case 'orc_flak':
        add(prop(`tower_B_${kit}`, { fit: 0.95 }))
        add(prop('weaponrack', { height: 0.35 }), -0.5, 0.45, 0.4)
        flag(); break
      case 'orc_market':
        add(prop('tent', { fit: 1.0 }), 0, 0.05)
        add(prop('crate', { height: 0.25 }), -0.5, 0.5, 0.3)
        add(prop('barrel', { height: 0.28 }), 0.5, 0.5)
        add(prop('lantern', { height: 0.5 }), 0.45, -0.45)
        flag(); break
      case 'market':
        add(prop('tent', { fit: 1.0 }), 0, 0.05)
        add(prop('crate', { height: 0.25 }), -0.5, 0.5, 0.3)
        add(prop('barrel', { height: 0.28 }), 0.5, 0.5)
        add(prop('crate', { height: 0.22 }), 0.45, -0.45, -0.5)
        flag(); break
      case 'black_market':
        add(prop('tent', { fit: 1.0 }), 0, 0.05)
        add(prop('coffin', { height: 0.28 }), -0.5, 0.5, 0.4)
        add(prop('lantern', { height: 0.5 }), 0.5, 0.5)
        add(prop('skull_candle', { height: 0.2 }), 0.45, -0.45)
        flag(); break
      case 'flak_tower':
        add(prop(`tower_B_${kit}`, { fit: 0.95 }))
        add(prop('weaponrack', { height: 0.35 }), -0.5, 0.45, 0.4)
        add(prop('crate', { height: 0.22 }), 0.45, 0.5)
        flag(); break
      case 'harpy_spire':
        add(prop(`tower_B_${kit}`, { fit: 0.95 }))
        add(prop('bone_A', { height: 0.1 }), -0.45, 0.5, 0.8)
        add(prop('gravestone', { height: 0.3 }), 0.45, 0.5, -0.3)
        flag(); break
      case 'guard_tower':
        add(prop(`tower_A_${kit}`, { fit: 0.95 }))
        add(prop('barrel', { height: 0.25 }), -0.5, 0.45)
        flag(); break
      case 'bone_tower':
        add(prop(`tower_A_${kit}`, { fit: 0.95 }))
        add(prop('post_skull', { height: 0.55 }), -0.5, 0.45)
        add(prop('ribcage', { height: 0.25 }), 0.45, 0.5, 0.8)
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
  const ownRing = new THREE.Mesh(ownRingGeo, ownRingMat)
  ownRing.position.y = 0.035
  ownRing.renderOrder = 3
  ownRing.visible = b.ownerId === currentMyId
  outer.add(bar.group, spawn.group, stars, ownRing)
  scene.add(outer)
  spawnPuff(outer.position, '#d8c7a4', 16)
  sfxAt('build', outer.position)
  if (BUILDING_TYPES[b.typeId]?.tower || BUILDING_TYPES[b.typeId]?.income) spawn.group.visible = false
  return { id: b.id, group: outer, bar, spawn, bornAt: performance.now(), typeId: b.typeId, team: b.team, level: 1, stars, hp: b.hp, hitAt: 0, x: b.x, y: b.y, timer: b.spawnTimer, ownRing }
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
/** Могилы и мёртвые деревья у базы команды, где есть нежить: одна группа на команду. */
const undeadDecor: Partial<Record<Team, THREE.Group>> = {}
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
    const R = Math.ceil(16 * KZ), C = Math.ceil(19 * KX)
    for (let r = -R; r <= R; r++) for (let c = -C; c <= C; c++) place(c * hw + (r & 1 ? hw / 2 : 0), r * dz)
  } else {
    const dx = hw * 0.75
    const C = Math.ceil(26 * KX), R = Math.ceil(12 * KZ)
    for (let c = -C; c <= C; c++) for (let r = -R; r <= R; r++) place(c * dx, r * hd + (c & 1 ? hd / 2 : 0))
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
  // три линии боя: утоптанные дороги. Центральная — прямо от замка к замку,
  // верхняя и нижняя уходят от баз к краям поля (точки — как в lanes.ts)
  const dirt = new THREE.MeshStandardMaterial({
    map: dirtTexture(), transparent: true, roughness: 1, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2,
  })
  const road = (x0: number, y0: number, x1: number, y1: number, width: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0) + width * 0.6
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len * S, width * S).rotateX(-Math.PI / 2), dirt)
    m.position.set(wx((x0 + x1) / 2), 0.012, wz((y0 + y1) / 2))
    m.rotation.y = -Math.atan2(y1 - y0, x1 - x0)
    m.renderOrder = 1
    m.receiveShadow = true
    scene.add(m)
  }
  road(40, CY, WORLD_W - 40, CY, 180)
  for (const y of [LANE_Y[0], LANE_Y[2]]) {
    const inner = y < CY ? CY - 150 : CY + 150
    const bend = BASE_ZONE.west.x1 + 60
    road(bend - 180, inner, bend, y, 120)
    road(bend, y, WORLD_W - bend, y, 120)
    road(WORLD_W - bend, y, WORLD_W - bend + 180, inner, 120)
  }
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
  // расстановка задана для первой карты 16×8 — растягиваем на нынешнее поле
  const put = (name: string, x0: number, z0: number, opts: { fit?: number; height?: number }) => {
    const x = x0 * KX, z = z0 * KZ
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
  const inField = (x: number, z: number) => Math.abs(x) < 17.5 && Math.abs(z) < 7.4
  // дальний край: горы и холмы
  for (let i = 0; i < 20; i++) {
    const x = -26 + i * 2.8 + rng() * 2
    put(['mountain_A', 'mountain_B', 'mountain_C'][i % 3], x, -12.5 - rng() * 3, { fit: 5 + rng() * 2.5 })
  }
  for (let i = 0; i < 10; i++) put(i % 2 ? 'hills_A' : 'hills_B', -24 + i * 5.3 + rng(), -9 - rng() * 1.5, { fit: 3.2 })
  // леса по краям
  for (let i = 0; i < 220; i++) {
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
  for (let i = 0; i < 60; i++) {
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
  river.scale.set(KX, KZ, 1)
  river.position.set(0, 0.03, 12.5 * KZ)
  river.receiveShadow = true
  scene.add(river)
  for (let i = 0; i < 150; i++) {
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
    c.position.set((-20 + i * 8) * KX, 7 + rng() * 2, (-10 + rng() * 12) * KZ)
    scene.add(c)
    c.userData.drift = 0.15 + rng() * 0.2
    c.traverse(o => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false })
    clouds.push(c)
  }
  return true
}
const clouds: THREE.Object3D[] = []

/** Могилы и мёртвые деревья вокруг базы нежити. */
function decorateTeam(team: Team, hasUndead: boolean) {
  const current = undeadDecor[team]
  if (!hasUndead) {
    if (current) { scene.remove(current); delete undeadDecor[team]; markShadows() }
    return
  }
  if (current) return
  const names = ['grave_A', 'grave_B', 'gravestone', 'tree_dead_large', 'tree_dead_medium', 'lantern']
  if (names.some(n => !asset(n))) return
  const g = new THREE.Group()
  const rng = mulberry(team === 'west' ? 21 : 37)
  const sx = team === 'west' ? -1 : 1
  for (let i = 0; i < 16; i++) {
    const x = sx * (FIELD_X - 17 + rng() * 15)
    const z = (rng() < 0.5 ? -1 : 1) * (FIELD_Z - 1.7 + rng() * 1.4)
    const n = names[Math.floor(rng() * names.length)]
    const o = prop(n, { height: n.startsWith('tree') ? 1.2 + rng() * 0.6 : n === 'lantern' ? 0.6 : 0.3 })!
    o.position.set(x, 0, z)
    o.rotation.y = rng() * 6.28
    g.add(o)
  }
  // одна склеенная сетка вместо 16 моделей
  const flat = flattenStatic(g)
  scene.add(flat)
  undeadDecor[team] = flat
  markShadows()
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
const fireMat = new THREE.MeshBasicMaterial({ color: '#ff7a1f' })
const ballGeo = new THREE.SphereGeometry(0.09, 10, 8)
const ballMat = new THREE.MeshStandardMaterial({ color: '#222326', roughness: 0.4, metalness: 0.6 })
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

/** Звук в точке сцены: за краем экрана тише, стерео — по положению на экране. */
const _snd = new THREE.Vector3()
function sfxAt(name: string, pos: THREE.Vector3, rate?: number) {
  if (!camera) return
  _snd.copy(pos).project(camera)
  const off = Math.max(Math.abs(_snd.x), Math.abs(_snd.y))
  if (off > 1.4 || _snd.z > 1) return
  sfx(name, { gain: 1 - 0.45 * Math.min(1, off), pan: _snd.x * 0.6, rate })
}
const LAUNCH_SFX: Partial<Record<ProjKind, [string, number?]>> = { fire: ['dark', 1.6], bolt: ['bow'], stone: ['bow', 0.55], beam: ['magic'], orb: ['dark', 1.3], ball: ['boom', 1.6], rocket: ['bow', 0.4], spear: ['bow', 0.7] }
const MELEE_SFX: Record<string, string> = { ghoul: 'hit_punch', abomination: 'hit_punch', gryphon: 'hit_punch', gargoyle: 'hit_punch', yeti: 'hit_punch', dragon: 'hit_punch' }

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
  if (!target) return
  const from = u.root.position.clone(); from.y = u.vis.hand
  launchFrom(from, target, u.vis.proj, u.team)
}

function launchFrom(from: THREE.Vector3, target: THREE.Vector3, kind: ProjKind, team: Team) {
  if (kind === 'none') return
  const snd = LAUNCH_SFX[kind]
  if (snd) sfxAt(snd[0], from, snd[1])
  const to = target.clone(); to.y = target.y > 0.1 ? target.y : 0.55
  if (kind === 'ball') spawnPuff(from, '#bdb5a8', 6)
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
  if (kind === 'ball') obj = new THREE.Mesh(ballGeo, ballMat)
  if (kind === 'fire') obj = new THREE.Mesh(orbGeo, fireMat)
  if (kind === 'rocket') { obj = missileProto.clone(); obj.scale.setScalar(0.45) }
  if (kind === 'spear') { const m = new THREE.Mesh(spearGeo, spearMat); m.rotation.x = Math.PI / 2; obj = new THREE.Group(); obj.add(m) }
  if (kind === 'orb') {
    obj = new THREE.Mesh(orbGeo, orbMat)
  }
  if (!obj) return
  scene.add(obj)
  const dist = from.distanceTo(to)
  const cfg = kind === 'stone' ? { dur: 1.2, arc: 2.6 } : kind === 'ball' ? { dur: 0.85, arc: 1.3 }
    : kind === 'rocket' ? { dur: Math.max(0.3, dist / 10), arc: 0.2 } : kind === 'spear' ? { dur: Math.max(0.3, dist / 13), arc: 0.6 } : kind === 'orb' ? { dur: 0.6, arc: 0.6 } : { dur: dist / 14, arc: 0.25 }
  projectiles.push({ obj, from, to, t: 0, dur: cfg.dur, arc: cfg.arc, kind, team })
}

const _fxTmp = new THREE.Vector3(), _fxAhead = new THREE.Vector3(), _fxPrev = new THREE.Vector3(), _fxUp = new THREE.Vector3(0, 0.2, 0)
function tickFx(dt: number) {
  const tmp = _fxTmp
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i]
    p.t += dt / p.dur
    const t = Math.min(1, p.t)
    const pos = tmp.lerpVectors(p.from, p.to, t)
    pos.y += Math.sin(Math.PI * t) * p.arc
    const prevPos = _fxPrev.copy(p.obj.position)
    p.obj.position.copy(pos)
    if (p.kind === 'rocket' && Math.random() < 0.9) spawnParticle(prevPos, '#cfc8bc', _fxUp, 0.6, 1, 1.5, 0)
    if (p.kind === 'bolt' || p.kind === 'stone' || p.kind === 'rocket' || p.kind === 'spear') {
      const ahead = _fxAhead.lerpVectors(p.from, p.to, Math.min(1, t + 0.02))
      ahead.y += Math.sin(Math.PI * Math.min(1, t + 0.02)) * p.arc
      if (p.kind !== 'stone') p.obj.lookAt(ahead)
      else p.obj.rotation.x += dt * 8
    }
    if (p.kind === 'orb' && Math.random() < 0.6) spawnParticle(prevPos, '#b56cff', _fxUp, 0.35, 0.8, -1, 0)
    if (p.kind === 'fire' && Math.random() < 0.8) spawnParticle(prevPos, Math.random() < 0.5 ? '#ffb347' : '#ff5a1f', _fxUp, 0.35, 0.9, -1, 0)
    if (p.t >= 1) {
      scene.remove(p.obj)
      projectiles.splice(i, 1)
      if (p.kind === 'rocket' || p.kind === 'spear') {
        // противотанковое попадание: танк взрывается
        explode(p.to, '#ff9d3b', 30); explode(p.to, '#3a3a3a', 16); sfxAt('boom', p.to)
      } else if (p.kind === 'stone' || p.kind === 'ball') {
        // артиллерия бьёт по площади — и взрыв пошире
        explode(p.to, '#ff9d3b', 28); explode(p.to, '#6d5a47', 14); spawnPuff(p.to, '#8a7c6e', 10); sfxAt('boom', p.to)
      }
      else if (p.kind === 'orb') { explode(p.to, '#c77dff', 12); sfxAt('hit_soft', p.to, 0.8) }
      else if (p.kind === 'fire') { explode(p.to, '#ff8a3b', 14); sfxAt('hit_soft', p.to, 0.7) }
      else { explode(p.to, '#e9e0c9', 5); sfxAt('hit_soft', p.to) }
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
    if (c.position.x > 30 * KX) c.position.x = -30 * KX
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
  for (const t of ['west', 'east'] as Team[]) decorateTeam(t, state.players.some(p => p.team === t && p.race === 'undead'))

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
    // выстрел фаустпатроном: патрон был — и пропал
    if ((v.root.userData.at ?? 0) > 0 && !u.at) fireAntiTank(v)
    v.root.userData.at = u.at ?? 0
    if (v.faust) v.faust.visible = !!u.at
    v.hp = u.hp; v.maxHp = u.maxHp
    v.bar.set(u.hp / u.maxHp)
    v.bar.group.visible = u.hp < u.maxHp
    // выстрел: кулдаун только что взведён
    const prevCd = (v.root.userData.cd as number | undefined) ?? 0
    if (prevCd === 0 && u.attackCooldown > 0) {
      const target = pickTarget(u, state)
      const tp = target ? new THREE.Vector3(wx(target.x), isFlying(target.typeId) ? FLY_H : 0, wz(target.y)) : null
      if (tp) v.faceYaw = Math.atan2(tp.x - v.next.x, tp.z - v.next.z)
      play(v, v.vis.attack, 0.08, true)
      if (v.tank) v.tank.recoil.position.x = v.tank.base.x + 1.2 // ствол назад
      const clip = v.actions.get(v.vis.attack)?.getClip()
      v.busyUntil = now + (clip ? clip.duration * 1000 * 0.85 : v.flyer ? 350 : 600)
      const delay = v.vis.proj === 'stone' ? 380 : v.vis.proj === 'beam' || v.vis.proj === 'orb' ? 300 : 180
      setTimeout(() => {
        if (!unitViews.has(v!.id)) return
        if (v!.vis.proj === 'none') sfxAt(MELEE_SFX[v!.typeId] ?? 'hit_metal', v!.root.position)
        else launch(v!, tp)
      }, delay)
    }
    v.root.userData.cd = u.attackCooldown
  }
  // исчезнувшие юниты: смерть (или вход в замок)
  for (const v of [...unitViews.values()]) {
    if (seen.has(v.id) || v.dying) continue
    if (!byId.has(v.id)) {
      v.dying = true
      v.deadAt = now
      // у вражеского замка воин не гибнет, а врезается в стены — там свой звук
      const enemyCastle = wx(v.team === 'west' ? CASTLE_X.east : CASTLE_X.west)
      if (Math.abs(v.root.position.x - enemyCastle) > 2.2) sfxAt(v.tank ? 'boom' : 'death', v.root.position)
      if (v.tank) explode(v.root.position.clone().setY(0.5), '#ff9d3b', 20)
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
    bv.ownRing.visible = b.ownerId === currentMyId
    const btype = BUILDING_TYPES[b.typeId]
    const interval = (btype?.spawnInterval ?? 1) * spawnMult(b.level ?? 1)
    if (btype?.income) {
      // рынок: без найма
    } else if (btype?.tower) {
      // башня: перезарядка взведена заново — значит, только что выстрелила
      if (b.spawnTimer > bv.timer) towerShot(bv, btype.tower.range, btype.tower.proj, state)
    } else {
      bv.spawn.set(1 - b.spawnTimer / interval, '#ffd35c')
    }
    bv.timer = b.spawnTimer
    if ((b.level ?? 1) !== bv.level) {
      if ((b.level ?? 1) > bv.level) {
        const p = bv.group.position.clone(); p.y = 1.2
        explode(p, '#ffd35c', 20)
        floatText(new THREE.Vector3(p.x, 2.4, p.z), `Уровень ${b.level}!`, '#ffd35c')
        sfxAt('upgrade', p)
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
      sfxAt('castle', p)
    }
    castleHp[t] = hp
    // стрелки замка: перезарядка взвелась — только что выстрелили
    const cd = state.castles[t].gunCd ?? 0
    if (cd > (castleGun[t] ?? 0)) castleShots(t, state)
    castleGun[t] = cd
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
        sfx('bigboom')
        explode(new THREE.Vector3(c.group.position.x, 1.0, 0), '#5d5249', 30)
      } else if (c.ruin) {
        c.group.remove(c.ruin); c.ruin = null
      }
    }
  }
  syncStrikes(state)
  updateHud(state)
}

function fireAntiTank(v: UnitView) {
  let best: UnitView | null = null
  let bd = Infinity
  for (const o of unitViews.values()) {
    if (o.team === v.team || !UNIT_TYPES[o.typeId]?.armored) continue
    const d = o.root.position.distanceTo(v.root.position)
    if (d < bd) { bd = d; best = o }
  }
  if (!best) return
  const from = v.root.position.clone(); from.y = 0.95
  const to = best.root.position.clone(); to.y = 0.4
  if (v.vis.faust === 'rocket') spawnPuff(from.clone().setY(0.2), '#d9d2c6', 6) // выхлоп назад
  launchFrom(from, to, v.vis.faust ?? 'rocket', v.team)
}

const castleGun: Partial<Record<Team, number>> = {}
function castleShots(team: Team, state: GameState) {
  const cx = CASTLE_X[team]
  const near = state.units
    .filter(u => u.team !== team && Math.hypot(u.x - cx, u.y - CY) <= CASTLE_GUNS.range * 1.2)
    .sort((a, b) => Math.hypot(a.x - cx, a.y - CY) - Math.hypot(b.x - cx, b.y - CY))
    .slice(0, CASTLE_GUNS.targets)
  near.forEach((u, i) => {
    const from = new THREE.Vector3(wx(cx) + (team === 'west' ? 0.6 : -0.6), 2.4, (i ? 0.7 : -0.7))
    launchFrom(from, new THREE.Vector3(wx(u.x), isFlying(u.typeId) ? FLY_H : 0, wz(u.y)), 'bolt', team)
  })
}

function towerShot(bv: BuildingView, range: number, proj: ProjKind, state: GameState) {
  let best: Unit | null = null
  let bd = range * 1.2
  for (const u of state.units) {
    if (u.team === bv.team) continue
    const d = Math.hypot(u.x - bv.x, u.y - bv.y)
    if (d < bd) { bd = d; best = u }
  }
  if (!best) return
  const from = bv.group.position.clone(); from.y = 1.45
  launchFrom(from, new THREE.Vector3(wx(best.x), isFlying(best.typeId) ? FLY_H : 0, wz(best.y)), proj, bv.team)
}

function pickTarget(u: Unit, state: GameState): Unit | null {
  const type = UNIT_TYPES[u.typeId]
  const healer = u.typeId === 'priest'
  let best: Unit | null = null
  let bd = Infinity
  const canAir = !!type.flying || (type.range >= 100 && !type.splash)
  // вражеские башни — тоже цель
  if (!healer) for (const b of state.buildings) {
    if (b.team === u.team || !BUILDING_TYPES[b.typeId]?.tower) continue
    const d = Math.hypot(b.x - u.x, b.y - u.y) - 30
    if (d < bd && d <= type.range * 1.2) { bd = d; best = { ...u, id: b.id, x: b.x, y: b.y, typeId: b.typeId, team: b.team } }
  }
  for (const o of state.units) {
    if (o.id === u.id) continue
    if (healer ? (o.team !== u.team || o.hp >= o.maxHp) : o.team === u.team) continue
    if (!healer && !canAir && isFlying(o.typeId)) continue
    const d = Math.hypot(o.x - u.x, o.y - u.y)
    if (d < bd && d <= type.range * 1.2) { bd = d; best = o }
  }
  if (!best && !healer) {
    // по замку
    const cx = u.team === 'west' ? CASTLE_X.east : CASTLE_X.west
    return { ...u, x: cx, y: CY }
  }
  return best
}

// ── Кадр ─────────────────────────────────────────────────────────────────────

const noAutoQuality = new URLSearchParams(location.search).has('noauto')
let fpsAvg = 60
let frameMsAvg = 0
let lastFrameAt = 0
let frameNo = 0
let frameCreated = 0
let frameReused = 0
const sections: Sections = { sync: 0, units: 0, world: 0, fx: 0, overlay: 0, render: 0 }
const _frustum = new THREE.Frustum()
const _pm = new THREE.Matrix4()
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1.4)

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
  aiming: false | 'strike' | 'nuke' = false,
) {
  const dt = Math.min(clock.getDelta(), 0.05)
  const now = performance.now()
  currentMyId = _myId
  ownRingMat.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(now / 420))
  const interval = lastFrameAt ? now - lastFrameAt : 16
  for (const k in sections) sections[k as keyof Sections] = 0
  frameCreated = frameReused = 0
  let mark = now
  const lap = (k: keyof Sections) => { const t = performance.now(); sections[k] += t - mark; mark = t }
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
  const stateArrived = state !== lastState
  lap('world')
  if (stateArrived) { syncState(state); lastState = state }
  lap('sync')

  // юниты: движение, поворот, анимации (за краем экрана анимация не считается)
  _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  for (const v of [...unitViews.values()]) {
    if (v.dying) {
      const t = (now - v.deadAt) / 1000
      if (v.vis.hover) v.body.position.y = Math.max(0, v.vis.hover - t * t * 3)
      if (v.tank && Math.random() < 0.3) spawnParticle(v.root.position.clone().setY(0.6), '#3a3a3a', _fxUp, 1.2, 2, 1.5, 0)
      if (v.tank) v.body.rotation.x = Math.min(0.25, t * 0.2)
      if (v.flyer) {
        // летун камнем падает, кувыркаясь
        v.body.position.y = Math.max(0.15, FLY_H - t * t * 3.2)
        v.body.rotation.z += dt * 5
        flap(v.flyer, now / 1000 * 0.3, v.phase)
      }
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
      v.faceYaw = Math.atan2(v.next.x - v.prev.x, v.next.z - v.prev.z)
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
    if (v.vis.hover) v.body.position.y = v.vis.hover + Math.sin(now / 350 + v.id.length) * 0.06
    if (v.tank) {
      // ствол возвращается после отката, гусеницы крутятся только на ходу, корпус чуть трясётся
      v.tank.recoil.position.lerp(v.tank.base, Math.min(1, dt * 5))
      const move = v.actions.get(v.vis.move)
      if (move) move.timeScale = moving ? 1.4 : 0
      v.body.position.y = moving ? Math.abs(Math.sin(now / 70 + v.phase)) * 0.012 : 0
    }
    if (v.flyer) {
      // парит: покачивается и машет крыльями, в атаке — ныряет
      const dive = now < v.busyUntil ? 0.25 : 0
      v.body.position.y += (FLY_H - dive + Math.sin(now / 320 + v.phase) * 0.08 - v.body.position.y) * Math.min(1, dt * 6)
      flap(v.flyer, now / 1000, v.phase)
    }
    v.mixDt = Math.min(v.mixDt + dt, 0.5)
    _sphere.center.set(v.root.position.x, v.flyer ? FLY_H : 0.6, v.root.position.z)
    if (!_frustum.intersectsSphere(_sphere)) continue
    if (!throttle || (ui++ + frameNo) % 2 === 0) { v.mixer.update(v.mixDt); v.mixDt = 0 }
  }

  lap('units')
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
  const aimingNow = state.phase === 'playing' ? aiming : false
  for (const team of ['west', 'east'] as Team[]) {
    const zone = baseZones[team]
    if (!zone) continue
    const mat = zone.material as THREE.MeshBasicMaterial
    const target = (placing || aimingNow === 'strike') && team === myTeam ? 1 : 0
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 8)
    zone.visible = mat.opacity > 0.01
  }
  updateGhost(placing ? selectedBuilding : null, myTeam, hover, state)
  updateAim(aimingNow ? hover : null, myTeam, aimingNow || 'strike')
  // ауры: кольца под воинами команды светятся (Сила — огненно, Ярость — золотом, обе — белым)
  for (const t of ['west', 'east'] as Team[]) {
    const a = state.auras?.[t]
    const dmg = !!a && a.damage > state.tick, spd = !!a && a.speed > state.tick
    const mat = rings[t].material as THREE.MeshBasicMaterial
    mat.color.set(dmg && spd ? '#fff4d6' : dmg ? '#ff5a1f' : spd ? '#ffd23a' : TEAM_COLOR[t])
    mat.opacity = dmg || spd ? 0.7 + 0.3 * Math.sin(now / 90) : 0.75
  }
  updateStrikes(now, dt)
  updatePings(now)
  updateWeather(state.conditions, dt)

  lap('world')
  tickFx(dt)
  lap('fx')
  controls.update()
  updateRings()
  updateBars()
  lap('overlay')
  renderer.render(scene, camera)
  lap('render')
  updatePerfOverlay(now)
  tickFloaters(dt)
  lap('overlay')
  const work = performance.now() - now
  frameMsAvg = frameMsAvg * 0.95 + work * 0.05
  telemetryFrame(interval, work, sections, {
    units: unitViews.size, buildings: buildingViews.size, particles: parts.n, calls: renderer.info.render.calls,
    quality, created: frameCreated, reused: frameReused, stateArrived,
  })
}

const ghostRingGeo = new THREE.RingGeometry(BUILDING_SPACING * S * 0.42, BUILDING_SPACING * S * 0.5, 40).rotateX(-Math.PI / 2)
const ghostRingMat = new THREE.MeshBasicMaterial({ color: '#6cf09a', transparent: true, opacity: 0.85, depthWrite: false })
const towerRange = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.6, depthWrite: false }))
towerRange.position.y = 0.035
towerRange.renderOrder = 6

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
  // башня: круг, докуда она достаёт
  const tw = BUILDING_TYPES[typeId]?.tower
  if (tw) {
    if (towerRange.parent !== ghost.group) ghost.group.add(towerRange)
    towerRange.scale.setScalar(tw.range * S)
  } else if (towerRange.parent) towerRange.parent.remove(towerRange)
  ghost.group.children[0].visible = true
  ghost.group.visible = true
  ghost.group.position.set(wx(hover.x), 0.02, wz(hover.y))
}

// ── Суперудар ────────────────────────────────────────────────────────────────

const strikeRingGeo = new THREE.RingGeometry(STRIKE.radius * S * 0.94, STRIKE.radius * S, 64).rotateX(-Math.PI / 2)
const strikeDiscGeo = new THREE.CircleGeometry(STRIKE.radius * S, 64).rotateX(-Math.PI / 2)
const aimRingMat = new THREE.MeshBasicMaterial({ color: '#ffd35c', transparent: true, opacity: 0.9, depthWrite: false })
const aimDiscMat = new THREE.MeshBasicMaterial({ color: '#ffd35c', transparent: true, opacity: 0.12, depthWrite: false })
const aim = new THREE.Group()
{
  const ring = new THREE.Mesh(strikeRingGeo, aimRingMat); ring.renderOrder = 6
  const disc = new THREE.Mesh(strikeDiscGeo, aimDiscMat); disc.renderOrder = 5
  aim.add(ring, disc)
  aim.position.y = 0.04
}

function updateAim(hover: { x: number; y: number } | null, team: Team, kind: 'strike' | 'nuke') {
  if (!hover) { if (aim.parent) scene.remove(aim); return }
  if (!aim.parent) scene.add(aim)
  const nuke = kind === 'nuke'
  const ok = nuke ? canNuke(hover.x, hover.y).ok : canStrike(team, hover.x, hover.y).ok
  const color = !ok ? '#ff5a4a' : nuke ? '#ff7a2f' : '#ffd35c'
  aimRingMat.color.set(color)
  aimDiscMat.color.set(color)
  aim.position.set(wx(hover.x), 0.04, wz(hover.y))
  const k = (1 + 0.03 * Math.sin(performance.now() / 120)) * (nuke ? NUKE.radius / STRIKE.radius : 1)
  aim.scale.set(k, 1, k)
}

interface StrikeView {
  group: THREE.Group; ring: THREE.Mesh; fill: THREE.Mesh; column: THREE.Mesh | null
  bornAt: number; hitAt: number; boomAt: number; seenAt: number
  nuke: boolean; missile: THREE.Object3D | null; from: THREE.Vector3; to: THREE.Vector3; wave: THREE.Mesh | null
  /** Сбита ПВО: местное время перехвата (0 — нет). */
  interceptAt: number
  interceptBy?: string
}
// ракета: корпус, боеголовка, стабилизаторы — смотрит вдоль +Z
const missileProto = (() => {
  const g = new THREE.Group()
  const white = new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.5 })
  const red = new THREE.MeshStandardMaterial({ color: '#c8281e', roughness: 0.5 })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.8, 10).rotateX(Math.PI / 2), white)
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 10).rotateX(Math.PI / 2), red)
  tip.position.z = 0.54
  g.add(body, tip)
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.2), red)
    fin.position.set(Math.cos(i * Math.PI / 2) * 0.1, Math.sin(i * Math.PI / 2) * 0.1, -0.32)
    fin.rotation.z = i * Math.PI / 2
    g.add(fin)
  }
  return g
})()
const _mNext = new THREE.Vector3()
function missilePos(v: StrikeView, k: number, out: THREE.Vector3) {
  out.lerpVectors(v.from, v.to, k)
  out.y = v.from.y + (v.to.y - v.from.y) * k + Math.sin(Math.PI * k) * 7
  return out
}
const strikeViews = new Map<string, StrikeView>()
const columnGeo = new THREE.CylinderGeometry(STRIKE.radius * S * 0.55, STRIKE.radius * S * 0.9, 9, 32, 1, true).translate(0, 4.5, 0)

function syncStrikes(state: GameState) {
  const now = performance.now()
  for (const st of state.strikes ?? []) {
    let v = strikeViews.get(st.id)
    if (!v) {
      // метка: противник видит, куда прилетит — у него секунда, чтобы понять, что сейчас будет
      const nuke = !!st.nuke
      const color = nuke ? '#ff3b1f' : TEAM_COLOR[st.team]
      const ring = new THREE.Mesh(strikeRingGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }))
      const fill = new THREE.Mesh(strikeDiscGeo, new THREE.MeshBasicMaterial({ color: nuke ? '#ff5a2a' : '#ffb347', transparent: true, opacity: 0.35, depthWrite: false }))
      ring.renderOrder = 6; fill.renderOrder = 5
      const group = new THREE.Group()
      const inner = new THREE.Group()
      inner.add(ring, fill)
      inner.scale.setScalar(nuke ? NUKE.radius / STRIKE.radius : 1)
      group.add(inner)
      group.position.set(wx(st.x), 0.05, wz(st.y))
      scene.add(group)
      const left = Math.max(0, st.hitTick - state.tick) * 50
      // ракета взлетает от своего замка
      const from = new THREE.Vector3(wx(CASTLE_X[st.team]), 2.2, 0)
      const to = new THREE.Vector3(wx(st.x), 0, wz(st.y))
      let missile: THREE.Object3D | null = null
      if (nuke && left > 0) { missile = missileProto.clone(); missile.position.copy(from); scene.add(missile) }
      const interceptAt = st.interceptAt !== undefined ? now + Math.max(0, st.interceptAt - state.tick) * 50 : 0
      v = { group, ring, fill, column: null, bornAt: now, hitAt: now + left, boomAt: 0, seenAt: now, nuke, missile, from, to, wave: null, interceptAt }
      strikeViews.set(st.id, v)
      if (left > 0) {
        sfx('charge', { gain: 0.8, rate: nuke ? 0.6 : 1 })
        if (nuke) { sfx('boom', { gain: 0.6, rate: 0.7 }); spawnPuff(from, '#d9d2c6', 20) }
      }
    }
    v.seenAt = now
    // перехват назначен позже запуска (сбили своей ракетой) — запомнить время и пустить ракету-перехватчик
    if (st.interceptAt !== undefined && !v.interceptAt && !v.boomAt) {
      v.interceptAt = now + Math.max(0, st.interceptAt - state.tick) * 50
      if (st.interceptBy?.startsWith('nuke:')) {
        const own: Team = st.team === 'west' ? 'east' : 'west'
        // перехватчик взлетает со стороны своего замка и за ~0,7 с долетает до точки встречи
        const k = THREE.MathUtils.clamp((v.interceptAt - v.bornAt) / Math.max(1, v.hitAt - v.bornAt), 0, 1)
        const meet = missilePos(v, k, new THREE.Vector3())
        const castle = new THREE.Vector3(wx(CASTLE_X[own]), 2.2, 0)
        const from = meet.clone().add(castle.sub(meet).setLength(7))
        launchFrom(from, meet, 'rocket', own)
      }
    }
    v.interceptBy = st.interceptBy
    if (st.killed !== undefined && !v.boomAt && !v.interceptAt) boom(v, st)
  }
}

function boom(v: StrikeView, st: Strike) {
  const now = performance.now()
  v.boomAt = now
  if (v.missile) { scene.remove(v.missile); v.missile = null }
  const c = v.group.position
  const k = v.nuke ? NUKE.radius / STRIKE.radius : 1
  const mat = new THREE.MeshBasicMaterial({ color: v.nuke ? '#ffd9a0' : '#fff1b8', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })
  v.column = new THREE.Mesh(columnGeo, mat)
  v.column.scale.setScalar(k)
  v.group.add(v.column)
  const R = STRIKE.radius * S * k
  for (let i = 0; i < (v.nuke ? 18 : 9); i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R * 0.85
    explode(new THREE.Vector3(c.x + Math.cos(a) * r, 0.3, c.z + Math.sin(a) * r), i % 2 ? '#ffcf6b' : '#ff7a2f', 16)
  }
  spawnPuff(new THREE.Vector3(c.x, 0, c.z), '#8a7c6e', v.nuke ? 40 : 26)
  if (v.nuke) {
    // гриб: огненный шар над землёй и ударная волна по земле
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2
      spawnParticle(new THREE.Vector3(c.x + Math.cos(a) * 0.4, 2.8 + Math.random() * 1.2, c.z + Math.sin(a) * 0.4), i % 3 ? '#ff8a3b' : '#5d5249',
        new THREE.Vector3(Math.cos(a) * 1.4, 0.6 + Math.random(), Math.sin(a) * 1.4), 1.6, 3.2, 1.2, -0.3)
    }
    const wave = new THREE.Mesh(strikeRingGeo, new THREE.MeshBasicMaterial({ color: '#fff0c8', transparent: true, opacity: 0.9, depthWrite: false }))
    wave.renderOrder = 7
    v.group.add(wave)
    v.wave = wave
  }
  for (const t of ['west', 'east'] as Team[]) { const cv = castles[t]; if (cv) cv.shakeUntil = now + (v.nuke ? 900 : 350) }
  sfx('bigboom')
  if (v.nuke) setTimeout(() => sfx('bigboom', { rate: 0.6 }), 120)
  const title = v.nuke ? 'Ядерный удар!' : 'Суперудар!'
  const parts = [st.killed ? `−${st.killed} воинов` : '', st.razed ? `−${st.razed} зданий` : '', st.castleHit ? `замок −${st.castleHit}` : ''].filter(Boolean)
  floatText(new THREE.Vector3(c.x, 2.6, c.z), parts.length ? `${title} ${parts.join(', ')}` : title, v.nuke ? '#ff9a5c' : '#ffd35c')
}

function updateStrikes(now: number, _dt: number) {
  for (const [id, v] of strikeViews) {
    const ringMat = v.ring.material as THREE.MeshBasicMaterial
    const fillMat = v.fill.material as THREE.MeshBasicMaterial
    if (!v.boomAt) {
      // заполняется к моменту удара и мигает всё чаще
      const k = THREE.MathUtils.clamp((now - v.bornAt) / Math.max(1, v.hitAt - v.bornAt), 0, 1)
      if (v.interceptAt && now >= v.interceptAt) {
        // ПВО сбила ракету: взрыв в воздухе, метка на земле гаснет
        const p = v.missile ? v.missile.position.clone() : missilePos(v, 0.55, new THREE.Vector3())
        explode(p, '#ffcf6b', 30); explode(p, '#8a8a8a', 16)
        sfx('boom', { rate: 1.3 })
        floatText(p.clone().setY(p.y + 0.5), v.interceptBy?.startsWith('nuke:') ? 'Ракета сбита ракетой!' : 'Ракета сбита ПВО!', '#8fe3ff')
        v.boomAt = now
        v.interceptAt = 0
        if (v.missile) { scene.remove(v.missile); v.missile = null }
        v.ring.visible = false
        v.fill.visible = false
        continue
      }
      if (v.missile) {
        // ракета летит дугой и оставляет дымный след
        missilePos(v, k, v.missile.position)
        v.missile.lookAt(missilePos(v, Math.min(1, k + 0.01), _mNext))
        if (Math.random() < 0.8) spawnParticle(v.missile.position, '#cfc8bc', _fxUp, 0.9, 1.4, 1.5, 0)
      }
      v.fill.scale.setScalar(Math.max(0.02, k))
      ringMat.opacity = 0.55 + 0.4 * Math.abs(Math.sin(now / (160 - 110 * k)))
      // сервер ушёл дальше, а удара мы так и не увидели — метку убираем
      if (now - v.seenAt > 3000) { disposeStrike(id, v) }
      continue
    }
    const t = (now - v.boomAt) / 1000
    if (v.wave) {
      v.wave.scale.setScalar(1 + t * 5)
      ;(v.wave.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - t * 1.1)
    }
    if (v.column) {
      v.column.scale.set(1 + t * 0.6, Math.max(0.01, 1 - t * 0.8), 1 + t * 0.6)
      ;(v.column.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - t * 1.4)
    }
    v.fill.scale.setScalar(1)
    fillMat.color.set('#2a1d14'); fillMat.opacity = Math.max(0, 0.55 - t * 0.25)
    ringMat.opacity = Math.max(0, 0.9 - t * 0.9)
    if (t > (v.nuke ? 3.5 : 2.2)) disposeStrike(id, v)
  }
}

function disposeStrike(id: string, v: StrikeView) {
  scene.remove(v.group)
  if (v.missile) scene.remove(v.missile)
  ;(v.ring.material as THREE.Material).dispose()
  ;(v.fill.material as THREE.Material).dispose()
  if (v.column) (v.column.material as THREE.Material).dispose()
  if (v.wave) (v.wave.material as THREE.Material).dispose()
  strikeViews.delete(id)
}

// ── Погода и время суток ─────────────────────────────────────────────────────

const RAIN_N = 1600
const rainPos = new Float32Array(RAIN_N * 6)
const rain = new THREE.LineSegments(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(rainPos, 3)),
  new THREE.LineBasicMaterial({ color: '#b8c7d9', transparent: true, opacity: 0.45, depthWrite: false }),
)
rain.frustumCulled = false
rain.visible = false
for (let i = 0; i < RAIN_N; i++) {
  const x = (Math.random() * 2 - 1) * (FIELD_X + 4), z = (Math.random() * 2 - 1) * (FIELD_Z + 4), y = Math.random() * 14
  rainPos.set([x, y, z, x + 0.05, y + 0.45, z + 0.02], i * 6)
}
let skyKey = ''
const skies: Record<string, THREE.Texture> = {}
const LOOK = {
  day: { hemi: 1.0, hemiSky: '#dfe9ff', hemiGround: '#46522c', sun: 2.1, sunColor: '#fff0d6', fog: '#c9dcea', sky: ['#6f9fd6', '#b9d3ea', '#dfe9ef'] as [string, string, string] },
  night: { hemi: 0.42, hemiSky: '#7f93c8', hemiGround: '#1d2433', sun: 0.6, sunColor: '#a9bcff', fog: '#1b2334', sky: ['#070b18', '#16223c', '#26324a'] as [string, string, string] },
}
const _c1 = new THREE.Color(), _c2 = new THREE.Color()
/** Плавно подвести свет, небо и туман к условиям раунда; дождь — падающие струи. */
function updateWeather(c: { night: boolean; rain: boolean } | undefined, dt: number) {
  const L = c?.night ? LOOK.night : LOOK.day
  const wet = c?.rain ? 0.7 : 1
  const k = Math.min(1, dt * 1.5)
  hemi.intensity += (L.hemi * wet - hemi.intensity) * k
  sun.intensity += (L.sun * wet - sun.intensity) * k
  hemi.color.lerp(_c1.set(L.hemiSky), k)
  hemi.groundColor.lerp(_c1.set(L.hemiGround), k)
  sun.color.lerp(_c1.set(L.sunColor), k)
  const fog = scene.fog as THREE.Fog
  fog.color.lerp(_c2.set(c?.rain ? (c.night ? '#141a26' : '#8f9aa6') : L.fog), k)
  fog.near += ((c?.rain ? 26 : 38) * KX - fog.near) * k
  const key = `${c?.night ? 'n' : 'd'}${c?.rain ? 'r' : ''}`
  if (key !== skyKey) {
    skyKey = key
    const stops: [string, string, string] = c?.rain ? (c.night ? ['#05070c', '#101520', '#1a2130'] : ['#6d7986', '#98a3ae', '#b9c1c8']) : L.sky
    skies[key] ??= skyTexture(stops)
    scene.background = skies[key]
  }
  rain.visible = !!c?.rain
  if (rain.visible) {
    const fall = dt * 22
    for (let i = 0; i < RAIN_N; i++) {
      const o = i * 6
      rainPos[o + 1] -= fall; rainPos[o + 4] -= fall
      if (rainPos[o + 1] < 0) { rainPos[o + 1] += 14; rainPos[o + 4] += 14 }
    }
    rain.geometry.attributes.position.needsUpdate = true
  }
}

// ── Метки союзников ─────────────────────────────────────────────────────────

const pings: { group: THREE.Group; ring: THREE.Mesh; at: number }[] = []
const pingRingGeo = new THREE.RingGeometry(0.55, 0.75, 32).rotateX(-Math.PI / 2)
const pingBeamGeo = new THREE.CylinderGeometry(0.06, 0.06, 4, 8, 1, true).translate(0, 2, 0)

/** Метка на поле: красная — «атакуем здесь», жёлтая — «нужна помощь». */
export function showPing(x: number, y: number, kind: 'attack' | 'help') {
  const color = kind === 'attack' ? '#ff4a3a' : '#ffd23a'
  const group = new THREE.Group()
  const ring = new THREE.Mesh(pingRingGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }))
  ring.position.y = 0.06
  ring.renderOrder = 8
  const beam = new THREE.Mesh(pingBeamGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }))
  group.add(ring, beam)
  group.position.set(wx(x), 0, wz(y))
  scene.add(group)
  pings.push({ group, ring, at: performance.now() })
  if (pings.length > 8) disposePing(0)
}
function disposePing(i: number) {
  const p = pings[i]
  scene.remove(p.group)
  p.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.Material).dispose() })
  pings.splice(i, 1)
}
function updatePings(now: number) {
  for (let i = pings.length - 1; i >= 0; i--) {
    const p = pings[i]
    const t = (now - p.at) / 1000
    if (t > 5) { disposePing(i); continue }
    // пульсирует: три волны, потом гаснет
    const k = (t * 1.5) % 1
    p.ring.scale.setScalar(1 + k * 1.2)
    ;(p.ring.material as THREE.MeshBasicMaterial).opacity = (1 - k) * (t < 4 ? 0.95 : (5 - t) * 0.95)
    ;(p.group.children[1] as THREE.Mesh).scale.set(1, 1, 1)
    ;((p.group.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = t < 4 ? 0.55 : (5 - t) * 0.55
  }
}

/** Сбросить сцену при переходе в другую комнату. */
export function resetScene() {
  while (pings.length) disposePing(0)
  for (const [id, v] of [...strikeViews]) disposeStrike(id, v)
  if (aim.parent) scene.remove(aim)
  clearUnits()
  for (const t of ['west', 'east'] as Team[]) decorateTeam(t, false)
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
