// Собирает 3D-ассеты игры из бесплатных наборов KayKit (CC0) в client/public/assets/*.glb.
//   node scripts/build-assets.mjs
// Скачанные исходники кешируются в client/.asset-cache.
import { NodeIO } from '@gltf-transform/core'
import { prune, dedup, simplify, weld } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CACHE = path.join(ROOT, '.asset-cache')
const OUT = path.join(ROOT, 'public', 'assets')
const GH = 'https://raw.githubusercontent.com/KayKit-Game-Assets'

const PACK = {
  adv: `${GH}/KayKit-Character-Pack-Adventures-1.0/main/addons/kaykit_character_pack_adventures`,
  skel: `${GH}/KayKit-Character-Pack-Skeletons-1.0/main/addons/kaykit_character_pack_skeletons`,
  hex: `${GH}/KayKit-Medieval-Hexagon-Pack-1.0/main/addons/kaykit_medieval_hexagon_pack/Assets/gltf`,
  hal: `${GH}/KayKit-Halloween-Bits-1.0/main/addons/kaykit_halloween_bits/Assets/gltf`,
}

// персонажи: анимации вырезаются, клипы берутся из anims.glb
const CHARACTERS = {
  knight: `${PACK.adv}/Characters/gltf/Knight.glb`,
  rogue: `${PACK.adv}/Characters/gltf/Rogue.glb`,
  mage: `${PACK.adv}/Characters/gltf/Mage.glb`,
  barbarian: `${PACK.adv}/Characters/gltf/Barbarian.glb`,
  skel_minion: `${PACK.skel}/Characters/gltf/Skeleton_Minion.glb`,
  skel_warrior: `${PACK.skel}/Characters/gltf/Skeleton_Warrior.glb`,
  skel_rogue: `${PACK.skel}/Characters/gltf/Skeleton_Rogue.glb`,
  skel_mage: `${PACK.skel}/Characters/gltf/Skeleton_Mage.glb`,
}

export const CLIPS = [
  'Idle', 'Walking_A', 'Walking_B', 'Running_A', 'Death_A', 'Death_B', 'Hit_A', 'Cheer',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '2H_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice',
  '2H_Ranged_Shoot', '2H_Ranged_Aiming', 'Spellcast_Shoot', 'Throw', 'Unarmed_Idle',
]

// статичные модели (.gltf + .bin + текстура) -> .glb
const STATIC = {
  // оружие скелетов и снаряды
  skel_blade: `${PACK.skel}/Assets/gltf/Skeleton_Blade.gltf`,
  skel_axe: `${PACK.skel}/Assets/gltf/Skeleton_Axe.gltf`,
  skel_crossbow: `${PACK.skel}/Assets/gltf/Skeleton_Crossbow.gltf`,
  skel_staff: `${PACK.skel}/Assets/gltf/Skeleton_Staff.gltf`,
  skel_shield: `${PACK.skel}/Assets/gltf/Skeleton_Shield_Large_A.gltf`,
  skel_quiver: `${PACK.skel}/Assets/gltf/Skeleton_Quiver.gltf`,
  arrow: `${PACK.adv}/Assets/gltf/arrow.gltf`,
  stone: `${PACK.hex}/buildings/neutral/projectile_catapult.gltf`,
  // местность
  hex_grass: `${PACK.hex}/tiles/base/hex_grass.gltf`,
  hex_road: `${PACK.hex}/tiles/roads/hex_road_A.gltf`,
  hex_dirt: `${PACK.hex}/buildings/neutral/building_dirt.gltf`,
  trees_A_large: `${PACK.hex}/decoration/nature/trees_A_large.gltf`,
  trees_A_medium: `${PACK.hex}/decoration/nature/trees_A_medium.gltf`,
  trees_B_large: `${PACK.hex}/decoration/nature/trees_B_large.gltf`,
  trees_B_medium: `${PACK.hex}/decoration/nature/trees_B_medium.gltf`,
  tree_single_A: `${PACK.hex}/decoration/nature/tree_single_A.gltf`,
  tree_single_B: `${PACK.hex}/decoration/nature/tree_single_B.gltf`,
  mountain_A: `${PACK.hex}/decoration/nature/mountain_A_grass_trees.gltf`,
  mountain_B: `${PACK.hex}/decoration/nature/mountain_B_grass_trees.gltf`,
  mountain_C: `${PACK.hex}/decoration/nature/mountain_C_grass.gltf`,
  hills_A: `${PACK.hex}/decoration/nature/hills_A_trees.gltf`,
  hills_B: `${PACK.hex}/decoration/nature/hills_B_trees.gltf`,
  rock_A: `${PACK.hex}/decoration/nature/rock_single_A.gltf`,
  rock_B: `${PACK.hex}/decoration/nature/rock_single_B.gltf`,
  rock_C: `${PACK.hex}/decoration/nature/rock_single_C.gltf`,
  cloud_big: `${PACK.hex}/decoration/nature/cloud_big.gltf`,
  // реквизит
  flag_blue: `${PACK.hex}/decoration/props/flag_blue.gltf`,
  flag_red: `${PACK.hex}/decoration/props/flag_red.gltf`,
  target: `${PACK.hex}/decoration/props/target.gltf`,
  weaponrack: `${PACK.hex}/decoration/props/weaponrack.gltf`,
  barrel: `${PACK.hex}/decoration/props/barrel.gltf`,
  crate: `${PACK.hex}/decoration/props/crate_A_big.gltf`,
  tent: `${PACK.hex}/decoration/props/tent.gltf`,
  wall_straight: `${PACK.hex}/buildings/neutral/wall_straight.gltf`,
  building_destroyed: `${PACK.hex}/buildings/neutral/building_destroyed.gltf`,
  // нежить
  crypt: `${PACK.hal}/crypt.gltf`,
  arch_gate: `${PACK.hal}/arch_gate.gltf`,
  shrine_candles: `${PACK.hal}/shrine_candles.gltf`,
  grave_A: `${PACK.hal}/grave_A.gltf`,
  grave_B: `${PACK.hal}/grave_B.gltf`,
  gravestone: `${PACK.hal}/gravestone.gltf`,
  tree_dead_large: `${PACK.hal}/tree_dead_large.gltf`,
  tree_dead_medium: `${PACK.hal}/tree_dead_medium.gltf`,
  coffin: `${PACK.hal}/coffin_decorated.gltf`,
  ribcage: `${PACK.hal}/ribcage.gltf`,
  bone_A: `${PACK.hal}/bone_A.gltf`,
  post_skull: `${PACK.hal}/post_skull.gltf`,
  lantern: `${PACK.hal}/lantern_standing.gltf`,
  skull_candle: `${PACK.hal}/skull_candle.gltf`,
  floor_grave: `${PACK.hal}/floor_dirt_grave.gltf`,
}
for (const team of ['blue', 'red']) {
  for (const b of ['castle', 'barracks', 'archeryrange', 'church', 'tower_catapult', 'tower_A', 'tower_B', 'blacksmith']) {
    STATIC[`${b}_${team}`] = `${PACK.hex}/buildings/${team}/building_${b}_${team}.gltf`
  }
}

async function fetchCached(url) {
  const file = path.join(CACHE, url.replace(/^https:\/\/raw\.githubusercontent\.com\//, '').replace(/[^\w.-]+/g, '_'))
  try {
    return await fs.readFile(file)
  } catch {}
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.mkdir(CACHE, { recursive: true })
  await fs.writeFile(file, buf)
  return buf
}

// .gltf + внешние ресурсы -> Document
async function readGltf(io, url) {
  const json = JSON.parse((await fetchCached(url)).toString('utf8'))
  const base = url.slice(0, url.lastIndexOf('/') + 1)
  const resources = {}
  for (const item of [...(json.buffers || []), ...(json.images || [])]) {
    if (item.uri && !item.uri.startsWith('data:')) {
      resources[item.uri] = new Uint8Array(await fetchCached(base + decodeURIComponent(item.uri)))
    }
  }
  return io.readJSON({ json, resources })
}

function dropAnimation(a) {
  for (const c of a.listChannels()) c.dispose()
  // аксессоры не трогаем: их делят клипы, лишние уберёт prune()
  for (const smp of a.listSamplers()) smp.dispose()
  a.dispose()
}

async function main() {
  const io = new NodeIO()
  await fs.mkdir(OUT, { recursive: true })
  let total = 0
  const save = async (name, doc) => {
    await doc.transform(dedup(), prune())
    const glb = await io.writeBinary(doc)
    await fs.writeFile(path.join(OUT, `${name}.glb`), glb)
    total += glb.byteLength
    console.log(`${name}.glb`.padEnd(28), (glb.byteLength / 1024).toFixed(0).padStart(6), 'KB')
  }

  // анимации: из рыцаря, только нужные клипы, без сеток
  {
    const doc = await io.readBinary(new Uint8Array(await fetchCached(CHARACTERS.knight)))
    const root = doc.getRoot()
    for (const a of root.listAnimations()) if (!CLIPS.includes(a.getName())) dropAnimation(a)
    for (const n of root.listNodes()) if (n.getMesh()) { n.setMesh(null); n.setSkin(null) }
    for (const m of root.listMeshes()) m.dispose()
    for (const s of root.listSkins()) s.dispose()
    await save('anims', doc)
  }
  // персонажи: без анимаций и упрощённые (с высоты RTS-камеры разницы не видно, а треугольников вдвое меньше)
  await MeshoptSimplifier.ready
  for (const [name, url] of Object.entries(CHARACTERS)) {
    const doc = await io.readBinary(new Uint8Array(await fetchCached(url)))
    for (const a of doc.getRoot().listAnimations()) dropAnimation(a)
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.45, error: 0.02 }))
    await save(name, doc)
  }
  for (const [name, url] of Object.entries(STATIC)) {
    await save(name, await readGltf(io, url))
  }
  console.log('total', (total / 1024 / 1024).toFixed(1), 'MB')
}

main().catch(e => { console.error(e); process.exit(1) })
