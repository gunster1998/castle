import type { UnitTypeDef, BuildingTypeDef, Race, Team } from './types'

export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  footman: {
    id: 'footman', name: 'Footman',
    hp: 160, damage: 18, speed: 2.5, range: 55, attackInterval: 25, radius: 14,
    color: '#4488ff',
  },
  rifleman: {
    id: 'rifleman', name: 'Rifleman',
    hp: 75, damage: 24, speed: 2.0, range: 260, attackInterval: 28, radius: 12,
    color: '#66aaff',
  },
  priest: {
    id: 'priest', name: 'Priest',
    hp: 65, damage: 8, speed: 2.2, range: 220, attackInterval: 20, radius: 11,
    color: '#ddeeff',
  },
  mortar: {
    id: 'mortar', name: 'Mortar Team',
    hp: 85, damage: 70, speed: 1.5, range: 440, attackInterval: 60, radius: 13,
    color: '#99ccff',
  },
  ghoul: {
    id: 'ghoul', name: 'Ghoul',
    hp: 150, damage: 24, speed: 3.5, range: 50, attackInterval: 18, radius: 13,
    color: '#88ff44',
  },
  crypt_fiend: {
    id: 'crypt_fiend', name: 'Crypt Fiend',
    hp: 105, damage: 26, speed: 2.1, range: 240, attackInterval: 26, radius: 12,
    color: '#44cc44',
  },
  necromancer: {
    id: 'necromancer', name: 'Necromancer',
    hp: 55, damage: 38, speed: 1.8, range: 200, attackInterval: 45, radius: 11,
    color: '#cc88ff',
  },
  abomination: {
    id: 'abomination', name: 'Abomination',
    hp: 450, damage: 30, speed: 1.5, range: 65, attackInterval: 28, radius: 18,
    color: '#336633',
  },
  // артиллерия: далеко и по площади, но медленная и хрупкая
  cannon: {
    id: 'cannon', name: 'Cannon',
    hp: 120, damage: 75, speed: 1.2, range: 470, attackInterval: 80, radius: 16,
    color: '#333333', splash: 70,
  },
  bone_catapult: {
    id: 'bone_catapult', name: 'Bone Catapult',
    hp: 130, damage: 70, speed: 1.3, range: 460, attackInterval: 76, radius: 16,
    color: '#bbbb99', splash: 75,
  },
  // танки: толстая броня, пушка по площади; по летунам не стреляют
  steam_tank: {
    id: 'steam_tank', name: 'Steam Tank',
    hp: 750, damage: 60, speed: 1.5, range: 320, attackInterval: 50, radius: 22,
    color: '#556677', splash: 45, armored: true,
  },
  death_tank: {
    id: 'death_tank', name: 'Death Tank',
    hp: 750, damage: 60, speed: 1.5, range: 320, attackInterval: 50, radius: 22,
    color: '#334433', splash: 45, armored: true,
  },
  // Орда (модели Quaternius, CC0)
  orc_grunt: {
    id: 'orc_grunt', name: 'Orc Grunt',
    hp: 160, damage: 18, speed: 2.6, range: 55, attackInterval: 24, radius: 14, color: '#6a8f3a',
  },
  totem_spirit: {
    id: 'totem_spirit', name: 'Totem Spirit',
    hp: 80, damage: 24, speed: 2.1, range: 250, attackInterval: 27, radius: 12, color: '#c0502a',
  },
  demon: {
    id: 'demon', name: 'Demon',
    hp: 60, damage: 36, speed: 1.9, range: 210, attackInterval: 44, radius: 12, color: '#9a1f2a',
  },
  yeti: {
    id: 'yeti', name: 'Yeti',
    hp: 440, damage: 30, speed: 1.5, range: 65, attackInterval: 30, radius: 18, color: '#cfe3f0',
  },
  orc_catapult: {
    id: 'orc_catapult', name: 'Fire Catapult',
    hp: 125, damage: 72, speed: 1.25, range: 465, attackInterval: 78, radius: 16, color: '#8a5a2a', splash: 72,
  },
  war_machine: {
    id: 'war_machine', name: 'War Machine',
    hp: 750, damage: 60, speed: 1.5, range: 320, attackInterval: 50, radius: 22, color: '#6b4a2b', splash: 45, armored: true,
  },
  dragon: {
    id: 'dragon', name: 'Dragon',
    hp: 200, damage: 26, speed: 3.2, range: 70, attackInterval: 22, radius: 16, color: '#d9782a', flying: true,
  },
  // летуны
  gryphon: {
    id: 'gryphon', name: 'Gryphon',
    hp: 230, damage: 28, speed: 3.0, range: 70, attackInterval: 24, radius: 16,
    color: '#ccaa66', flying: true,
  },
  gargoyle: {
    id: 'gargoyle', name: 'Gargoyle',
    hp: 190, damage: 24, speed: 3.5, range: 65, attackInterval: 20, radius: 15,
    color: '#666677', flying: true,
  },
}

export const BUILDING_TYPES: Record<string, BuildingTypeDef> = {
  // Human
  barracks: {
    id: 'barracks', name: 'Barracks', race: 'human',
    cost: 100, hp: 500, spawnInterval: 200, unitTypeId: 'footman',
    color: '#2244aa', description: 'Trains Footmen — melee tanks',
    antiTank: { name: 'Panzerfaust', cost: 150 },
  },
  rifle_range: {
    id: 'rifle_range', name: 'Rifle Range', race: 'human',
    cost: 120, hp: 400, spawnInterval: 240, unitTypeId: 'rifleman',
    color: '#335599', description: 'Trains Riflemen — ranged DPS',
  },
  church: {
    id: 'church', name: 'Church', race: 'human',
    cost: 140, hp: 350, spawnInterval: 300, unitTypeId: 'priest',
    color: '#8888ff', description: 'Trains Priests — healers',
  },
  mortar_battery: {
    id: 'mortar_battery', name: 'Mortar Battery', race: 'human',
    cost: 180, hp: 400, spawnInterval: 420, unitTypeId: 'mortar',
    color: '#116688', description: 'Trains Mortar Teams — long-range siege',
  },
  // Undead
  crypt: {
    id: 'crypt', name: 'Crypt', race: 'undead',
    cost: 100, hp: 450, spawnInterval: 180, unitTypeId: 'ghoul',
    color: '#224422', description: 'Raises Ghouls — fast melee',
    antiTank: { name: 'Bone Spear', cost: 150 },
  },
  spider_lair: {
    id: 'spider_lair', name: 'Spider Lair', race: 'undead',
    cost: 120, hp: 380, spawnInterval: 240, unitTypeId: 'crypt_fiend',
    color: '#334433', description: 'Spawns Crypt Fiends — ranged',
  },
  necromancer_tower: {
    id: 'necromancer_tower', name: 'Necromancer Tower', race: 'undead',
    cost: 140, hp: 320, spawnInterval: 380, unitTypeId: 'necromancer',
    color: '#442255', description: 'Trains Necromancers — powerful casters',
  },
  slaughterhouse: {
    id: 'slaughterhouse', name: 'Slaughterhouse', race: 'undead',
    cost: 200, hp: 500, spawnInterval: 520, unitTypeId: 'abomination',
    color: '#112211', description: 'Creates Abominations — massive tanks',
  },
  foundry: {
    id: 'foundry', name: 'Foundry', race: 'human',
    cost: 220, hp: 500, spawnInterval: 560, unitTypeId: 'cannon',
    color: '#444444', description: 'Casts Cannons — long-range splash artillery',
  },
  aviary: {
    id: 'aviary', name: 'Gryphon Aviary', race: 'human',
    cost: 240, hp: 450, spawnInterval: 460, unitTypeId: 'gryphon',
    color: '#aa8844', description: 'Trains Gryphons — flying',
  },
  workshop: {
    id: 'workshop', name: 'Workshop', race: 'human',
    cost: 300, hp: 600, spawnInterval: 720, unitTypeId: 'steam_tank',
    color: '#667788', description: 'Builds Steam Tanks — heavy armor',
  },
  death_forge: {
    id: 'death_forge', name: 'Death Forge', race: 'undead',
    cost: 300, hp: 600, spawnInterval: 720, unitTypeId: 'death_tank',
    color: '#334433', description: 'Forges Death Tanks — heavy armor',
  },
  bone_yard: {
    id: 'bone_yard', name: 'Bone Yard', race: 'undead',
    cost: 220, hp: 500, spawnInterval: 540, unitTypeId: 'bone_catapult',
    color: '#999977', description: 'Builds Bone Catapults — long-range splash artillery',
  },
  gargoyle_spire: {
    id: 'gargoyle_spire', name: 'Gargoyle Spire', race: 'undead',
    cost: 240, hp: 450, spawnInterval: 440, unitTypeId: 'gargoyle',
    color: '#555566', description: 'Raises Gargoyles — flying',
  },
  // Башни: не нанимают, а стреляют. spawnInterval — тиков между выстрелами
  guard_tower: {
    id: 'guard_tower', name: 'Guard Tower', race: 'human',
    // уязвима: её атакуют все воины; числа подобраны симуляцией — окупается в 1,5–3 раза,
    // но артиллерия и танки бьют дальше и сносят её почти без потерь
    cost: 180, hp: 2400, spawnInterval: 15, unitTypeId: '',
    color: '#556688', description: 'Shoots enemies near the base; can be destroyed',
    tower: { damage: 55, range: 280, proj: 'bolt' },
  },
  // Орда
  war_camp: {
    id: 'war_camp', name: 'War Camp', race: 'orc',
    cost: 100, hp: 500, spawnInterval: 200, unitTypeId: 'orc_grunt',
    color: '#6a8f3a', description: 'Trains Orc Grunts — melee',
    antiTank: { name: 'Blast Spears', cost: 150 },
  },
  spirit_lodge: {
    id: 'spirit_lodge', name: 'Spirit Lodge', race: 'orc',
    cost: 120, hp: 400, spawnInterval: 240, unitTypeId: 'totem_spirit',
    color: '#c0502a', description: 'Summons Totem Spirits — ranged',
  },
  demon_gate: {
    id: 'demon_gate', name: 'Demon Gate', race: 'orc',
    cost: 150, hp: 350, spawnInterval: 380, unitTypeId: 'demon',
    color: '#9a1f2a', description: 'Summons Demons — casters',
  },
  yeti_den: {
    id: 'yeti_den', name: 'Yeti Den', race: 'orc',
    cost: 200, hp: 500, spawnInterval: 520, unitTypeId: 'yeti',
    color: '#cfe3f0', description: 'Yetis — heavy melee',
  },
  siege_yard: {
    id: 'siege_yard', name: 'Siege Yard', race: 'orc',
    cost: 220, hp: 500, spawnInterval: 550, unitTypeId: 'orc_catapult',
    color: '#8a5a2a', description: 'Fire Catapults — splash artillery',
  },
  dragon_roost: {
    id: 'dragon_roost', name: 'Dragon Roost', race: 'orc',
    cost: 240, hp: 450, spawnInterval: 450, unitTypeId: 'dragon',
    color: '#d9782a', description: 'Dragons — flying',
  },
  war_forge: {
    id: 'war_forge', name: 'War Forge', race: 'orc',
    cost: 300, hp: 600, spawnInterval: 720, unitTypeId: 'war_machine',
    color: '#6b4a2b', description: 'War Machines — heavy armor',
  },
  orc_tower: {
    id: 'orc_tower', name: 'Orc Tower', race: 'orc',
    cost: 180, hp: 2400, spawnInterval: 15, unitTypeId: '',
    color: '#6b4a2b', description: 'Shoots enemies near the base; can be destroyed',
    tower: { damage: 55, range: 280, proj: 'bolt' },
  },
  orc_flak: {
    id: 'orc_flak', name: 'Harpy Nest', race: 'orc',
    cost: 400, hp: 1600, spawnInterval: 20, unitTypeId: '',
    color: '#6b4a2b', description: 'Shoots down nukes and flyers',
    tower: { damage: 45, range: 320, proj: 'bolt', airOnly: true, antiNuke: { range: 500, cooldown: 60 * 20 } },
  },
  orc_market: {
    id: 'orc_market', name: 'Bazaar', race: 'orc',
    cost: 200, hp: 500, spawnInterval: 0, unitTypeId: '',
    color: '#c8a040', description: 'Earns gold', income: 9,
  },
  // Рынки: доход без воинов. Первый окупается за ~56 с, каждый следующий приносит на 20% меньше
  market: {
    id: 'market', name: 'Market', race: 'human',
    cost: 200, hp: 500, spawnInterval: 0, unitTypeId: '',
    color: '#c8a040', description: 'Earns gold', income: 9,
  },
  black_market: {
    id: 'black_market', name: 'Black Market', race: 'undead',
    cost: 200, hp: 500, spawnInterval: 0, unitTypeId: '',
    color: '#7a6a40', description: 'Earns gold', income: 9,
  },
  // ПВО: сбивает ракеты и стреляет по летунам; по наземным не стреляет. Уязвима, как башни
  flak_tower: {
    id: 'flak_tower', name: 'Flak Tower', race: 'human',
    cost: 400, hp: 1600, spawnInterval: 20, unitTypeId: '',
    color: '#667788', description: 'Shoots down nukes and flyers',
    tower: { damage: 45, range: 320, proj: 'bolt', airOnly: true, antiNuke: { range: 500, cooldown: 60 * 20 } },
  },
  harpy_spire: {
    id: 'harpy_spire', name: 'Interceptor Spire', race: 'undead',
    cost: 400, hp: 1600, spawnInterval: 20, unitTypeId: '',
    color: '#556655', description: 'Shoots down nukes and flyers',
    tower: { damage: 45, range: 320, proj: 'orb', airOnly: true, antiNuke: { range: 500, cooldown: 60 * 20 } },
  },
  bone_tower: {
    id: 'bone_tower', name: 'Bone Tower', race: 'undead',
    cost: 180, hp: 2300, spawnInterval: 16, unitTypeId: '',
    color: '#445544', description: 'Shoots enemies near the base; can be destroyed',
    tower: { damage: 60, range: 270, proj: 'orb' },
  },
}

export const BUILDINGS_BY_RACE: Record<Race, string[]> = {
  human: ['barracks', 'rifle_range', 'church', 'mortar_battery', 'foundry', 'aviary', 'workshop', 'guard_tower', 'flak_tower', 'market'],
  undead: ['crypt', 'spider_lair', 'necromancer_tower', 'slaughterhouse', 'bone_yard', 'gargoyle_spire', 'death_forge', 'bone_tower', 'harpy_spire', 'black_market'],
  orc: ['war_camp', 'spirit_lodge', 'demon_gate', 'yeti_den', 'siege_yard', 'dragon_roost', 'war_forge', 'orc_tower', 'orc_flak', 'orc_market'],
}

// World constants
export { WORLD_W, WORLD_H } from './world'
import { CASTLE_POS } from './world'
export const CASTLE_HP = 3000
/** Лечение жреца за раз (уровень здания умножает). Баланс рас: было 25 — люди выигрывали 3 раунда из 4. */
export const PRIEST_HEAL = 18
/** Фаустпатрон: дальность выстрела по танку. */
export const ANTITANK_RANGE = 220
/** Замок отстреливается: по стольким ближайшим врагам в радиусе, раз в столько тиков. */
export const CASTLE_GUNS = { range: 300, damage: 35, interval: 30, targets: 2 }

// Castle centers
export const CASTLE_WEST = CASTLE_POS.west
export const CASTLE_EAST = CASTLE_POS.east

// доход: раз в 2,5 с — базовый плюс доля от стоимости своих зданий
export const INCOME_INTERVAL = 50  // тиков
export const STARTING_GOLD = 300
export const BASE_INCOME = 8
export const BUILDING_INCOME_RATE = 0.02  // 2% of building cost per cycle
