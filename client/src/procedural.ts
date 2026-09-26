// Модели, которых нет в паках KayKit: летуны (грифон, горгулья) и лафеты артиллерии.
// Собираются из простых фигур с цветом в вершинах: одна сетка на тело (+ по сетке на крыло).
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Team } from './types'

const TEAM_CLOTH: Record<Team, string> = { west: '#3f7ee8', east: '#e0483a' }
const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, side: THREE.DoubleSide })

type Part = [THREE.BufferGeometry, string]

/** Детали с цветом → одна геометрия. */
function merge(parts: Part[]): THREE.BufferGeometry {
  const list = parts.map(([geo, color]) => {
    const g = geo.index ? geo.toNonIndexed() : geo
    g.deleteAttribute('uv')
    const c = new THREE.Color(color)
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g
  })
  const out = mergeGeometries(list, false)!
  out.computeVertexNormals()
  return out
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) =>
  g.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)))

/** Крыло в плоскости XZ, растёт вправо (+X) от корня в 0,0. */
function wingGeo(points: [number, number][], color: string): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)))
  const g = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2)
  return merge([[g, color]])
}

export interface FlyerModel {
  group: THREE.Group
  body: THREE.Mesh
  wings: THREE.Object3D[]
}

const flyerCache = new Map<string, { body: THREE.BufferGeometry; wing: THREE.BufferGeometry }>()

function flyerGeometry(kind: 'gryphon' | 'gargoyle', team: Team) {
  const key = `${kind}:${team}`
  let c = flyerCache.get(key)
  if (c) return c
  const cloth = TEAM_CLOTH[team]
  if (kind === 'gryphon') {
    const body = merge([
      [at(new THREE.SphereGeometry(0.22, 8, 6), 0, 0, 0, 1, 0.8, 1.5), '#b8864b'],               // львиное тело
      [at(new THREE.SphereGeometry(0.17, 8, 6), 0, 0.04, 0.24), '#efe6d2'],                     // грудь в перьях
      [at(new THREE.SphereGeometry(0.12, 8, 6), 0, 0.17, 0.42), '#f4efe4'],                     // голова
      [at(new THREE.ConeGeometry(0.05, 0.16, 6), 0, 0.14, 0.56, 1, 1, 1, Math.PI / 2), '#e0a526'], // клюв
      [at(new THREE.ConeGeometry(0.04, 0.12, 5), 0.06, 0.3, 0.38, 1, 1, 1, -0.4), '#f4efe4'],   // уши-перья
      [at(new THREE.ConeGeometry(0.04, 0.12, 5), -0.06, 0.3, 0.38, 1, 1, 1, -0.4), '#f4efe4'],
      [at(new THREE.ConeGeometry(0.05, 0.4, 5), 0, 0.02, -0.46, 1, 1, 1, -Math.PI / 2), '#a8773f'], // хвост
      [at(new THREE.ConeGeometry(0.07, 0.1, 6), 0, 0.02, -0.68, 1, 1, 1, -Math.PI / 2), '#6b4a2b'],
      [at(new THREE.BoxGeometry(0.3, 0.05, 0.3), 0, 0.18, -0.02), cloth],                       // попона цвета команды
      [at(new THREE.BoxGeometry(0.05, 0.16, 0.06), 0.13, 0.06, 0.2), '#d9a441'],                // передние лапы
      [at(new THREE.BoxGeometry(0.05, 0.16, 0.06), -0.13, 0.06, 0.2), '#d9a441'],
      [at(new THREE.BoxGeometry(0.06, 0.14, 0.07), 0.12, -0.14, -0.2), '#a8773f'],              // задние
      [at(new THREE.BoxGeometry(0.06, 0.14, 0.07), -0.12, -0.14, -0.2), '#a8773f'],
    ])
    const wing = wingGeo([[0, 0.12], [0.3, 0.2], [0.62, 0.16], [0.95, 0.02], [0.78, -0.08], [0.55, -0.14], [0.28, -0.16], [0, -0.1]], '#e8dcc0')
    c = { body, wing }
  } else {
    const body = merge([
      [at(new THREE.SphereGeometry(0.2, 7, 5), 0, 0, 0, 1, 0.9, 1.35), '#5b5f66'],               // каменное тело
      [at(new THREE.SphereGeometry(0.12, 7, 5), 0, 0.16, 0.32), '#4a4d53'],                     // голова
      [at(new THREE.ConeGeometry(0.03, 0.16, 5), 0.07, 0.3, 0.3, 1, 1, 1, -0.5, 0, -0.3), '#2c2e33'], // рога
      [at(new THREE.ConeGeometry(0.03, 0.16, 5), -0.07, 0.3, 0.3, 1, 1, 1, -0.5, 0, 0.3), '#2c2e33'],
      [at(new THREE.SphereGeometry(0.025, 5, 4), 0.045, 0.19, 0.43), '#ffd84d'],                // горящие глаза
      [at(new THREE.SphereGeometry(0.025, 5, 4), -0.045, 0.19, 0.43), '#ffd84d'],
      [at(new THREE.ConeGeometry(0.04, 0.5, 5), 0, 0, -0.45, 1, 1, 1, -Math.PI / 2), '#4a4d53'],  // хвост
      [at(new THREE.ConeGeometry(0.06, 0.1, 4), 0, 0, -0.74, 1, 1, 1, -Math.PI / 2), '#2c2e33'],
      [at(new THREE.TorusGeometry(0.16, 0.03, 4, 10), 0, 0.02, 0.05, 1, 1, 1, Math.PI / 2), cloth], // ошейник цвета команды
      [at(new THREE.BoxGeometry(0.05, 0.16, 0.05), 0.12, -0.13, 0.12), '#4a4d53'],              // когтистые лапы
      [at(new THREE.BoxGeometry(0.05, 0.16, 0.05), -0.12, -0.13, 0.12), '#4a4d53'],
    ])
    // перепончатое крыло с зубцами
    const wing = wingGeo([[0, 0.1], [0.35, 0.22], [0.7, 0.2], [0.95, 0.06], [0.8, -0.04], [0.7, -0.16], [0.55, -0.06], [0.42, -0.2], [0.28, -0.08], [0.12, -0.16], [0, -0.06]], '#3f4248')
    c = { body, wing }
  }
  flyerCache.set(key, c)
  return c
}

export function flyerModel(kind: 'gryphon' | 'gargoyle', team: Team): FlyerModel {
  const { body, wing } = flyerGeometry(kind, team)
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(body, material)
  mesh.userData.kind = kind
  group.add(mesh)
  const wings: THREE.Object3D[] = []
  for (const side of [1, -1]) {
    const pivot = new THREE.Group()
    pivot.position.set(0.14 * side, 0.1, 0.04)
    const w = new THREE.Mesh(wing, material)
    w.scale.x = side
    pivot.add(w)
    group.add(pivot)
    wings.push(pivot)
  }
  return { group, body: mesh, wings }
}

/** Запас моделей общий для обеих команд: перекрасить под нужную. */
export function setFlyerTeam(m: FlyerModel, team: Team) {
  m.body.geometry = flyerGeometry(m.body.userData.kind, team).body
}
export function setCartTeam(cart: THREE.Mesh, team: Team) {
  cart.geometry = cartGeometry(cart.userData.kind, team)
}

/** Взмах крыльев: t — секунды, phase — сдвиг, чтобы стая не махала в такт. */
export function flap(m: { wings: THREE.Object3D[] }, t: number, phase: number) {
  const a = Math.sin(t * 8 + phase) * 0.55 + 0.1
  m.wings[0].rotation.z = a
  m.wings[1].rotation.z = -a
}

const cartCache = new Map<string, THREE.BufferGeometry>()

/** Лафет артиллерии: пушка у людей, костяная катапульта у нежити. Смотрит вперёд (+Z). */
export function cartModel(kind: 'cannon' | 'catapult', team: Team): THREE.Mesh {
  const mesh = new THREE.Mesh(cartGeometry(kind, team), material)
  mesh.userData.kind = kind
  return mesh
}

function cartGeometry(kind: 'cannon' | 'catapult', team: Team): THREE.BufferGeometry {
  const key = `${kind}:${team}`
  let geo = cartCache.get(key)
  if (!geo) {
    const cloth = TEAM_CLOTH[team]
    const wheel = (x: number, z: number, r: number) => at(new THREE.CylinderGeometry(r, r, 0.05, 10), x, r, z, 1, 1, 1, 0, 0, Math.PI / 2)
    geo = kind === 'cannon'
      ? merge([
        [at(new THREE.BoxGeometry(0.26, 0.1, 0.5), 0, 0.2, -0.02), '#6b4a2b'],                   // лафет
        [at(new THREE.CylinderGeometry(0.075, 0.095, 0.62, 10), 0, 0.32, 0.12, 1, 1, 1, Math.PI / 2 - 0.25), '#2e3035'], // ствол
        [at(new THREE.TorusGeometry(0.085, 0.02, 5, 10), 0, 0.39, 0.4, 1, 1, 1, 0.25), '#b08d3c'], // бронзовое кольцо на жерле
        [at(new THREE.SphereGeometry(0.07, 6, 5), 0, 0.26, -0.2), '#2e3035'],
        [wheel(0.17, 0.02, 0.15), '#4a3420'], [wheel(-0.17, 0.02, 0.15), '#4a3420'],
        [at(new THREE.BoxGeometry(0.2, 0.03, 0.12), 0, 0.26, -0.18), cloth],                      // флажок цвета команды
      ])
      : merge([
        [at(new THREE.BoxGeometry(0.3, 0.07, 0.56), 0, 0.14, 0), '#5a4a35'],                    // рама
        [at(new THREE.BoxGeometry(0.04, 0.34, 0.04), 0.12, 0.3, 0.05), '#5a4a35'],               // стойки
        [at(new THREE.BoxGeometry(0.04, 0.34, 0.04), -0.12, 0.3, 0.05), '#5a4a35'],
        [at(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 6), 0, 0.44, 0.05, 1, 1, 1, 0, 0, Math.PI / 2), '#3d3226'],
        [at(new THREE.BoxGeometry(0.05, 0.05, 0.6), 0, 0.38, -0.05, 1, 1, 1, 0.55), '#d9d2bd'],  // рычаг из кости
        [at(new THREE.SphereGeometry(0.075, 7, 5), 0, 0.23, -0.3), '#ece6d4'],                   // черепа в ковше
        [at(new THREE.SphereGeometry(0.06, 7, 5), 0.07, 0.2, -0.26), '#e3dcc6'],
        [wheel(0.18, 0.18, 0.11), '#3d3226'], [wheel(-0.18, 0.18, 0.11), '#3d3226'],
        [wheel(0.18, -0.2, 0.11), '#3d3226'], [wheel(-0.18, -0.2, 0.11), '#3d3226'],
        [at(new THREE.BoxGeometry(0.03, 0.18, 0.12), 0.16, 0.3, -0.18), cloth],
      ])
    cartCache.set(key, geo)
  }
  return geo
}

const tankCache = new Map<string, { hull: THREE.BufferGeometry; turret: THREE.BufferGeometry }>()

function tankGeometry(kind: 'steam' | 'death', team: Team) {
  const key = `${kind}:${team}`
  let c = tankCache.get(key)
  if (c) return c
  const cloth = TEAM_CLOTH[team]
  const steam = kind === 'steam'
  const metal = steam ? '#7d8a96' : '#3b3f38'
  const dark = steam ? '#4d565f' : '#23261f'
  const trim = steam ? '#b08d3c' : '#d9d2bd'
  const hullParts: Part[] = [
    [at(new THREE.BoxGeometry(0.62, 0.2, 0.9), 0, 0.2, 0), metal],                      // корпус
    [at(new THREE.BoxGeometry(0.5, 0.08, 0.6), 0, 0.34, -0.05), dark],                  // крыша
    [at(new THREE.BoxGeometry(0.16, 0.16, 0.98), 0.36, 0.1, 0), '#2a2a2a'],             // гусеницы
    [at(new THREE.BoxGeometry(0.16, 0.16, 0.98), -0.36, 0.1, 0), '#2a2a2a'],
    [at(new THREE.BoxGeometry(0.3, 0.04, 0.22), 0, 0.39, -0.3), cloth],                  // знак команды
  ]
  for (let i = -2; i <= 2; i++) {
    hullParts.push([wheelGeo(0.36, 0.08, i * 0.2), dark], [wheelGeo(-0.36, 0.08, i * 0.2), dark])
  }
  if (steam) {
    hullParts.push([at(new THREE.CylinderGeometry(0.05, 0.06, 0.34, 8), -0.18, 0.5, -0.32), dark]) // паровая труба
    hullParts.push([at(new THREE.TorusGeometry(0.055, 0.015, 4, 8), -0.18, 0.67, -0.32, 1, 1, 1, Math.PI / 2), trim])
  } else {
    // костяные шипы по бортам
    for (let i = -1; i <= 1; i++) {
      hullParts.push([at(new THREE.ConeGeometry(0.035, 0.18, 5), 0.32, 0.3, i * 0.28, 1, 1, 1, 0, 0, -1.1), trim])
      hullParts.push([at(new THREE.ConeGeometry(0.035, 0.18, 5), -0.32, 0.3, i * 0.28, 1, 1, 1, 0, 0, 1.1), trim])
    }
  }
  const turretParts: Part[] = [
    [at(new THREE.CylinderGeometry(0.2, 0.22, 0.16, 10), 0, 0, 0), metal],
    [at(new THREE.CylinderGeometry(0.045, 0.055, 0.55, 8), 0, 0.02, 0.36, 1, 1, 1, Math.PI / 2), dark], // ствол
    [at(new THREE.TorusGeometry(0.05, 0.015, 4, 8), 0, 0.02, 0.63), trim],
  ]
  if (!steam) turretParts.push([at(new THREE.SphereGeometry(0.08, 7, 5), 0, 0.1, -0.06), '#ece6d4']) // череп на башне
  c = { hull: merge(hullParts), turret: merge(turretParts) }
  tankCache.set(key, c)
  return c
}
const wheelGeo = (x: number, y: number, z: number) => at(new THREE.CylinderGeometry(0.07, 0.07, 0.17, 8), x, y, z, 1, 1, 1, 0, 0, Math.PI / 2)

export interface TankModel { group: THREE.Group; hull: THREE.Mesh; turret: THREE.Mesh }

/** Танк смотрит вперёд (+Z); башня — отдельной сеткой (откат при выстреле). */
export function tankModel(kind: 'steam' | 'death', team: Team): TankModel {
  const g = tankGeometry(kind, team)
  const group = new THREE.Group()
  const hull = new THREE.Mesh(g.hull, material)
  const turret = new THREE.Mesh(g.turret, material)
  turret.position.y = 0.46
  hull.userData.kind = kind
  group.add(hull, turret)
  return { group, hull, turret }
}
export function setTankTeam(m: TankModel, team: Team) {
  const g = tankGeometry(m.hull.userData.kind, team)
  m.hull.geometry = g.hull
  m.turret.geometry = g.turret
}
