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
    hp: 130, damage: 22, speed: 3.5, range: 50, attackInterval: 18, radius: 13,
    color: '#88ff44',
  },
  crypt_fiend: {
    id: 'crypt_fiend', name: 'Crypt Fiend',
    hp: 95, damage: 26, speed: 2.1, range: 240, attackInterval: 26, radius: 12,
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
}

export const BUILDING_TYPES: Record<string, BuildingTypeDef> = {
  // Human
  barracks: {
    id: 'barracks', name: 'Barracks', race: 'human',
    cost: 100, hp: 500, spawnInterval: 200, unitTypeId: 'footman',
    color: '#2244aa', description: 'Trains Footmen — melee tanks',
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
}

export const BUILDINGS_BY_RACE: Record<Race, string[]> = {
  human: ['barracks', 'rifle_range', 'church', 'mortar_battery'],
  undead: ['crypt', 'spider_lair', 'necromancer_tower', 'slaughterhouse'],
}

// World constants
export const WORLD_W = 1600
export const WORLD_H = 800
export const CASTLE_HP = 3000
export const LANE_Y_MIN = 300
export const LANE_Y_MAX = 500
export const LANE_CENTER_Y = 400

// Castle centers
export const CASTLE_WEST = { x: 60, y: LANE_CENTER_Y }
export const CASTLE_EAST = { x: 1540, y: LANE_CENTER_Y }

// Unit spawn X
export const SPAWN_X = { west: 165, east: 1435 }

export const INCOME_INTERVAL = 100  // ticks (5 seconds at 20 tps)
export const STARTING_GOLD = 200
export const BASE_INCOME = 5
export const BUILDING_INCOME_RATE = 0.02  // 2% of building cost per cycle
