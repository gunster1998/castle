// Склейка моделей для производительности: меньше отдельных сеток — меньше команд отрисовки.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

type Attrs = 'position' | 'normal' | 'uv'

/** Геометрия с одинаковым набором атрибутов (float, без нормализации) и индексом — чтобы её можно было склеить. */
function normalized(src: THREE.BufferGeometry, skin: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const n = src.attributes.position.count
  const f32 = (name: Attrs, size: number) => {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined
    const out = new Float32Array(n * size)
    if (a) for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k)
    return new THREE.BufferAttribute(out, size)
  }
  g.setAttribute('position', f32('position', 3))
  g.setAttribute('normal', src.getAttribute('normal') ? f32('normal', 3) : new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('uv', f32('uv', 2))
  if (skin) {
    const si = src.getAttribute('skinIndex') as THREE.BufferAttribute | undefined
    const sw = src.getAttribute('skinWeight') as THREE.BufferAttribute | undefined
    const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = si ? si.getComponent(i, k) : 0
      w[i * 4 + k] = sw ? sw.getComponent(i, k) : (k === 0 ? 1 : 0)
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4))
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4))
  }
  const index = src.index
    ? Array.from(src.index.array as ArrayLike<number>)
    : Array.from({ length: n }, (_, i) => i)
  g.setIndex(index)
  return g
}

/** Отпечаток текстуры: одинаковые картинки из разных файлов считаем одной. */
const imageKeys = new WeakMap<object, string>()
function imageKey(img: unknown): string {
  if (!img || typeof img !== 'object') return 'none'
  const cached = imageKeys.get(img)
  if (cached) return cached
  let key = 'img'
  try {
    const src = img as CanvasImageSource & { width: number; height: number }
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(src, 0, 0, 16, 16)
    const d = g.getImageData(0, 0, 16, 16).data
    let h = 2166136261
    for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619) }
    key = `${src.width}x${src.height}:${(h >>> 0).toString(16)}`
  } catch { /* не удалось прочитать — считаем уникальной */ key = Math.random().toString(36) }
  imageKeys.set(img, key)
  return key
}

/** Материалы с одинаковыми параметрами и текстурой объединяются в один. */
const canonical = new Map<string, THREE.Material>()
export function materialKey(m: THREE.Material): string {
  const sm = m as THREE.MeshStandardMaterial
  return [m.type, m.name, sm.color?.getHexString(), sm.emissive?.getHexString(), sm.roughness, sm.metalness,
    m.transparent, m.side, imageKey(sm.map?.image), imageKey(sm.emissiveMap?.image)].join('|')
}
function canonicalMaterial(m: THREE.Material): THREE.Material {
  const key = materialKey(m)
  let c = canonical.get(key)
  if (!c) { c = m; canonical.set(key, m) }
  return c
}

function visibleInTree(o: THREE.Object3D, root: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p && p !== root.parent; p = p.parent) if (!p.visible) return false
  return true
}

/**
 * Персонаж: все видимые части (скиннинговые и жёсткие — оружие, шлем) склеиваются
 * в одну SkinnedMesh на каждый материал, на общем скелете.
 */
export function mergeCharacter(root: THREE.Object3D): void {
  root.updateMatrixWorld(true)
  const skinned: THREE.SkinnedMesh[] = []
  const rigid: THREE.Mesh[] = []
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !visibleInTree(m, root)) return
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(m as THREE.SkinnedMesh)
    else rigid.push(m)
  })
  if (!skinned.length) return
  const first = skinned[0]
  const skeleton = first.skeleton
  const bindInv = first.bindMatrix.clone().invert()
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>()
  const push = (mat: THREE.Material, geo: THREE.BufferGeometry) => {
    const key = canonicalMaterial(mat)
    const list = groups.get(key) ?? []
    list.push(geo)
    groups.set(key, list)
  }
  for (const sm of skinned) {
    if (Array.isArray(sm.material)) return
    const geo = normalized(sm.geometry, true)
    // индексы костей этой сетки -> индексы общего скелета
    const remap = sm.skeleton.bones.map(b => skeleton.bones.indexOf(b))
    if (remap.some(i => i < 0)) return
    const si = geo.getAttribute('skinIndex') as THREE.BufferAttribute
    for (let i = 0; i < si.array.length; i++) (si.array as Uint16Array)[i] = remap[(si.array as Uint16Array)[i]]
    geo.applyMatrix4(bindInv.clone().multiply(sm.bindMatrix))
    push(sm.material, geo)
  }
  for (const m of rigid) {
    if (Array.isArray(m.material)) continue
    let bone: THREE.Object3D | null = m.parent
    while (bone && !(bone as THREE.Bone).isBone) bone = bone.parent
    const bi = bone ? skeleton.bones.indexOf(bone as THREE.Bone) : -1
    if (bi < 0) continue
    // вершины жёсткой части -> пространство привязки, вся часть висит на одной кости
    const boneBind = skeleton.boneInverses[bi].clone().invert()
    const rel = bone!.matrixWorld.clone().invert().multiply(m.matrixWorld)
    const geo = normalized(m.geometry, true)
    const si = geo.getAttribute('skinIndex') as THREE.BufferAttribute
    const sw = geo.getAttribute('skinWeight') as THREE.BufferAttribute
    for (let i = 0; i < si.count; i++) {
      si.setXYZW(i, bi, 0, 0, 0)
      sw.setXYZW(i, 1, 0, 0, 0)
    }
    geo.applyMatrix4(bindInv.clone().multiply(boneBind).multiply(rel))
    push(m.material, geo)
  }
  const parent = first.parent!
  const bindMatrix = first.bindMatrix.clone()
  for (const m of [...skinned, ...rigid]) m.parent?.remove(m)
  for (const [mat, geos] of groups) {
    const merged = mergeGeometries(geos, false)
    if (!merged) continue
    const mesh = new THREE.SkinnedMesh(merged, mat)
    mesh.castShadow = true
    mesh.receiveShadow = false
    parent.add(mesh)
    mesh.bind(skeleton, bindMatrix)
  }
}

/** Статичная группа (здание, замок): сетки склеиваются по материалам. */
export function flattenStatic(group: THREE.Object3D): THREE.Group {
  group.updateMatrixWorld(true)
  const inv = group.matrixWorld.clone().invert()
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>()
  group.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh || Array.isArray(m.material) || !visibleInTree(m, group)) return
    const geo = normalized(m.geometry, false)
    geo.applyMatrix4(inv.clone().multiply(m.matrixWorld))
    const key = canonicalMaterial(m.material)
    const list = groups.get(key) ?? []
    list.push(geo)
    groups.set(key, list)
  })
  const out = new THREE.Group()
  for (const [mat, geos] of groups) {
    const merged = mergeGeometries(geos, false)
    if (!merged) continue
    const mesh = new THREE.Mesh(merged, mat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    out.add(mesh)
  }
  return out
}
