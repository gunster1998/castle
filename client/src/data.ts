import type { UnitTypeDef, BuildingTypeDef, Race } from './types'

export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  footman:      { id: 'footman',      name: 'Пехотинец',        hp: 160, damage: 18, speed: 2.5, range: 55,  attackInterval: 25, radius: 14, color: '#4488ff' },
  rifleman:     { id: 'rifleman',     name: 'Стрелок',          hp: 75,  damage: 24, speed: 2.0, range: 260, attackInterval: 28, radius: 12, color: '#66aaff' },
  priest:       { id: 'priest',       name: 'Жрец',             hp: 65,  damage: 8,  speed: 2.2, range: 220, attackInterval: 20, radius: 11, color: '#ddeeff' },
  mortar:       { id: 'mortar',       name: 'Миномёт',          hp: 85,  damage: 70, speed: 1.5, range: 440, attackInterval: 60, radius: 13, color: '#99ccff' },
  ghoul:        { id: 'ghoul',        name: 'Гуль',             hp: 130, damage: 22, speed: 3.5, range: 50,  attackInterval: 18, radius: 13, color: '#88ff44' },
  crypt_fiend:  { id: 'crypt_fiend',  name: 'Крипт Фенд',       hp: 95,  damage: 26, speed: 2.1, range: 240, attackInterval: 26, radius: 12, color: '#44cc44' },
  necromancer:  { id: 'necromancer',  name: 'Некромант',        hp: 55,  damage: 38, speed: 1.8, range: 200, attackInterval: 45, radius: 11, color: '#cc88ff' },
  abomination:  { id: 'abomination',  name: 'Мерзость',         hp: 450, damage: 30, speed: 1.5, range: 65,  attackInterval: 28, radius: 18, color: '#336633' },
}

export const BUILDING_TYPES: Record<string, BuildingTypeDef> = {
  barracks:          { id: 'barracks',          name: 'Казармы',            race: 'human',  cost: 100, hp: 500, spawnInterval: 200, unitTypeId: 'footman',     color: '#2244aa', description: 'Обучает пехотинцев — ближний бой' },
  rifle_range:       { id: 'rifle_range',       name: 'Стрельбище',         race: 'human',  cost: 120, hp: 400, spawnInterval: 240, unitTypeId: 'rifleman',    color: '#335599', description: 'Обучает стрелков — дальний бой' },
  church:            { id: 'church',            name: 'Церковь',            race: 'human',  cost: 140, hp: 350, spawnInterval: 300, unitTypeId: 'priest',      color: '#8888ff', description: 'Обучает жрецов — лечение союзников' },
  mortar_battery:    { id: 'mortar_battery',    name: 'Батарея',            race: 'human',  cost: 180, hp: 400, spawnInterval: 420, unitTypeId: 'mortar',      color: '#116688', description: 'Обучает миномётчиков — осада' },
  crypt:             { id: 'crypt',             name: 'Склеп',              race: 'undead', cost: 100, hp: 450, spawnInterval: 180, unitTypeId: 'ghoul',       color: '#224422', description: 'Поднимает гулей — быстрый ближний бой' },
  spider_lair:       { id: 'spider_lair',       name: 'Логово пауков',      race: 'undead', cost: 120, hp: 380, spawnInterval: 240, unitTypeId: 'crypt_fiend', color: '#334433', description: 'Спавнит крипт фендов — дальний бой' },
  necromancer_tower: { id: 'necromancer_tower', name: 'Башня некромантов',  race: 'undead', cost: 140, hp: 320, spawnInterval: 380, unitTypeId: 'necromancer', color: '#442255', description: 'Обучает некромантов — мощные маги' },
  slaughterhouse:    { id: 'slaughterhouse',    name: 'Бойня',              race: 'undead', cost: 200, hp: 500, spawnInterval: 520, unitTypeId: 'abomination', color: '#112211', description: 'Создаёт мерзостей — огромные танки' },
}

export const BUILDINGS_BY_RACE: Record<Race, string[]> = {
  human:  ['barracks', 'rifle_range', 'church', 'mortar_battery'],
  undead: ['crypt', 'spider_lair', 'necromancer_tower', 'slaughterhouse'],
}

// World constants (must match server)
export const WORLD_W = 1600
export const WORLD_H = 800
