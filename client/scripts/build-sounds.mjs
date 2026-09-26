// Звуки игры: паки Kenney (CC0, kenney.nl) → public/sfx/*.mp3 (моно, 64 кбит/с — mp3 играет во всех браузерах).
// Запуск: npm run sounds (нужен ffmpeg). Готовые mp3 лежат в репозитории, пересобирать не обязательно.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CACHE = path.resolve('.asset-cache/audio')
const OUT = path.resolve('public/sfx')
const PACKS = {
  impact: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip',
  ui: 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',
  jingles: 'https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip',
  rpg: 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip',
  scifi: 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip',
}
// имя в игре → [пак, файл]
const SOUNDS = {
  hit_metal_0: ['impact', 'impactMetal_light_000'], hit_metal_1: ['impact', 'impactMetal_light_001'], hit_metal_2: ['impact', 'impactMetal_light_002'],
  hit_punch_0: ['impact', 'impactPunch_medium_000'], hit_punch_1: ['impact', 'impactPunch_medium_001'], hit_punch_2: ['impact', 'impactPunch_medium_002'],
  hit_soft_0: ['impact', 'impactSoft_medium_000'], hit_soft_1: ['impact', 'impactSoft_medium_001'], hit_soft_2: ['impact', 'impactSoft_medium_002'],
  death_0: ['impact', 'impactSoft_heavy_000'], death_1: ['impact', 'impactSoft_heavy_001'], death_2: ['impact', 'impactSoft_heavy_002'],
  magic_0: ['ui', 'glass_001'], magic_1: ['ui', 'glass_003'],
  dark_0: ['scifi', 'forceField_000'],
  boom_0: ['scifi', 'explosionCrunch_000'], boom_1: ['scifi', 'explosionCrunch_001'], boom_2: ['scifi', 'explosionCrunch_002'],
  bigboom_0: ['scifi', 'lowFrequency_explosion_000'],
  charge_0: ['scifi', 'forceField_002'],
  build_0: ['impact', 'impactWood_heavy_000'], build_1: ['impact', 'impactWood_heavy_001'],
  upgrade_0: ['rpg', 'handleCoins'],
  castle_0: ['impact', 'impactMining_000'], castle_1: ['impact', 'impactMining_001'],
  click_0: ['ui', 'click_002'], select_0: ['ui', 'select_002'], error_0: ['ui', 'error_004'],
  ok_0: ['ui', 'confirmation_001'], chat_0: ['ui', 'pluck_001'], back_0: ['ui', 'back_001'],
  start_0: ['jingles', 'jingles_HIT03'], win_0: ['jingles', 'jingles_STEEL01'], lose_0: ['jingles', 'jingles_PIZZI03'],
}

fs.mkdirSync(CACHE, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
const dirs = {}
for (const [key, url] of Object.entries(PACKS)) {
  const zip = path.join(CACHE, path.basename(url))
  const dir = zip.replace(/\.zip$/, '')
  if (!fs.existsSync(zip)) execFileSync('curl', ['-sL', '--max-time', '180', '-o', zip, url])
  if (!fs.existsSync(dir)) execFileSync('unzip', ['-q', '-o', zip, '-d', dir])
  dirs[key] = dir
}
const find = (dir, name) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const r = find(p, name); if (r) return r }
    else if (e.name === `${name}.ogg`) return p
  }
  return null
}
let total = 0
for (const [name, [pack, file]] of Object.entries(SOUNDS)) {
  const src = find(dirs[pack], file)
  if (!src) throw new Error(`нет ${file} в ${pack}`)
  const out = path.join(OUT, `${name}.mp3`)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ac', '1', '-ar', '44100', '-b:a', '64k', out])
  total += fs.statSync(out).size
}
fs.copyFileSync(path.join(dirs.impact, 'License.txt'), path.join(OUT, 'LICENSE-kenney.txt'))
console.log(`${Object.keys(SOUNDS).length} звуков, ${(total / 1024).toFixed(0)} КБ → public/sfx`)
