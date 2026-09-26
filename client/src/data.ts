import type { UnitTypeDef, BuildingTypeDef, Race } from './types'

export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  footman:      { id: 'footman',      name: 'Пехотинец',        hp: 160, damage: 18, speed: 2.5, range: 55,  attackInterval: 25, radius: 14, color: '#4488ff' },
  rifleman:     { id: 'rifleman',     name: 'Стрелок',          hp: 75,  damage: 24, speed: 2.0, range: 260, attackInterval: 28, radius: 12, color: '#66aaff' },
  priest:       { id: 'priest',       name: 'Жрец',             hp: 65,  damage: 8,  speed: 2.2, range: 220, attackInterval: 20, radius: 11, color: '#ddeeff' },
  mortar:       { id: 'mortar',       name: 'Миномёт',          hp: 85,  damage: 70, speed: 1.5, range: 440, attackInterval: 60, radius: 13, color: '#99ccff' },
  ghoul:        { id: 'ghoul',        name: 'Гуль',             hp: 150, damage: 24, speed: 3.5, range: 50,  attackInterval: 18, radius: 13, color: '#88ff44' },
  crypt_fiend:  { id: 'crypt_fiend',  name: 'Крипт Фенд',       hp: 105, damage: 26, speed: 2.1, range: 240, attackInterval: 26, radius: 12, color: '#44cc44' },
  necromancer:  { id: 'necromancer',  name: 'Некромант',        hp: 55,  damage: 38, speed: 1.8, range: 200, attackInterval: 45, radius: 11, color: '#cc88ff' },
  abomination:  { id: 'abomination',  name: 'Мерзость',         hp: 450, damage: 30, speed: 1.5, range: 65,  attackInterval: 28, radius: 18, color: '#336633' },
  // артиллерия и летуны — числа как на сервере
  cannon:        { id: 'cannon',        name: 'Пушка',            hp: 120, damage: 75, speed: 1.2, range: 470, attackInterval: 80, radius: 16, color: '#333333', splash: 70 },
  bone_catapult: { id: 'bone_catapult', name: 'Костяная катапульта', hp: 130, damage: 70, speed: 1.3, range: 460, attackInterval: 76, radius: 16, color: '#bbbb99', splash: 75 },
  steam_tank:    { id: 'steam_tank',    name: 'Паровой танк',     hp: 750, damage: 60, speed: 1.5, range: 320, attackInterval: 50, radius: 22, color: '#556677', splash: 45, armored: true },
  death_tank:    { id: 'death_tank',    name: 'Танк смерти',      hp: 750, damage: 60, speed: 1.5, range: 320, attackInterval: 50, radius: 22, color: '#334433', splash: 45, armored: true },
  orc_grunt:     { id: 'orc_grunt',     name: 'Орк',              hp: 160, damage: 18, speed: 2.6, range: 55,  attackInterval: 24, radius: 14, color: '#6a8f3a' },
  totem_spirit:  { id: 'totem_spirit',  name: 'Дух-тотем',        hp: 80,  damage: 24, speed: 2.1, range: 250, attackInterval: 27, radius: 12, color: '#c0502a' },
  demon:         { id: 'demon',         name: 'Демон',            hp: 60,  damage: 36, speed: 1.9, range: 210, attackInterval: 44, radius: 12, color: '#9a1f2a' },
  yeti:          { id: 'yeti',          name: 'Йети',             hp: 440, damage: 30, speed: 1.5, range: 65,  attackInterval: 30, radius: 18, color: '#cfe3f0' },
  orc_catapult:  { id: 'orc_catapult',  name: 'Огненная катапульта', hp: 125, damage: 72, speed: 1.25, range: 465, attackInterval: 78, radius: 16, color: '#8a5a2a', splash: 72 },
  war_machine:   { id: 'war_machine',   name: 'Боевая махина',    hp: 750, damage: 60, speed: 1.5, range: 320, attackInterval: 50, radius: 22, color: '#6b4a2b', splash: 45, armored: true },
  dragon:        { id: 'dragon',        name: 'Дракон',           hp: 200, damage: 26, speed: 3.2, range: 70,  attackInterval: 22, radius: 16, color: '#d9782a', flying: true },
  gryphon:       { id: 'gryphon',       name: 'Грифон',           hp: 230, damage: 28, speed: 3.0, range: 70,  attackInterval: 24, radius: 16, color: '#ccaa66', flying: true },
  gargoyle:      { id: 'gargoyle',      name: 'Горгулья',         hp: 190, damage: 24, speed: 3.5, range: 65,  attackInterval: 20, radius: 15, color: '#666677', flying: true },
}

export const BUILDING_TYPES: Record<string, BuildingTypeDef> = {
  barracks:          { id: 'barracks',          name: 'Казармы',            race: 'human',  cost: 100, hp: 500, spawnInterval: 200, unitTypeId: 'footman',     color: '#2244aa', description: 'Обучает пехотинцев — ближний бой', antiTank: { name: 'Фаустпатроны', cost: 150 } },
  rifle_range:       { id: 'rifle_range',       name: 'Стрельбище',         race: 'human',  cost: 120, hp: 400, spawnInterval: 240, unitTypeId: 'rifleman',    color: '#335599', description: 'Обучает стрелков — дальний бой' },
  church:            { id: 'church',            name: 'Церковь',            race: 'human',  cost: 140, hp: 350, spawnInterval: 300, unitTypeId: 'priest',      color: '#8888ff', description: 'Обучает жрецов — лечение союзников' },
  mortar_battery:    { id: 'mortar_battery',    name: 'Батарея',            race: 'human',  cost: 180, hp: 400, spawnInterval: 420, unitTypeId: 'mortar',      color: '#116688', description: 'Обучает миномётчиков — осада' },
  crypt:             { id: 'crypt',             name: 'Склеп',              race: 'undead', cost: 100, hp: 450, spawnInterval: 180, unitTypeId: 'ghoul',       color: '#224422', description: 'Поднимает гулей — быстрый ближний бой', antiTank: { name: 'Костяные копья', cost: 150 } },
  spider_lair:       { id: 'spider_lair',       name: 'Логово пауков',      race: 'undead', cost: 120, hp: 380, spawnInterval: 240, unitTypeId: 'crypt_fiend', color: '#334433', description: 'Спавнит крипт фендов — дальний бой' },
  necromancer_tower: { id: 'necromancer_tower', name: 'Башня некромантов',  race: 'undead', cost: 140, hp: 320, spawnInterval: 380, unitTypeId: 'necromancer', color: '#442255', description: 'Обучает некромантов — мощные маги' },
  slaughterhouse:    { id: 'slaughterhouse',    name: 'Бойня',              race: 'undead', cost: 200, hp: 500, spawnInterval: 520, unitTypeId: 'abomination', color: '#112211', description: 'Создаёт мерзостей — огромные танки' },
  foundry:           { id: 'foundry',           name: 'Литейная',           race: 'human',  cost: 220, hp: 500, spawnInterval: 560, unitTypeId: 'cannon',        color: '#444444', description: 'Льёт пушки — дальний удар по площади' },
  aviary:            { id: 'aviary',            name: 'Гнездо грифонов',    race: 'human',  cost: 240, hp: 450, spawnInterval: 460, unitTypeId: 'gryphon',       color: '#aa8844', description: 'Грифоны — летают над полем' },
  workshop:          { id: 'workshop',          name: 'Мастерская',         race: 'human',  cost: 300, hp: 600, spawnInterval: 720, unitTypeId: 'steam_tank',    color: '#667788', description: 'Паровые танки — броня и пушка' },
  death_forge:       { id: 'death_forge',       name: 'Кузня смерти',       race: 'undead', cost: 300, hp: 600, spawnInterval: 720, unitTypeId: 'death_tank',    color: '#334433', description: 'Танки смерти — броня и пушка' },
  bone_yard:         { id: 'bone_yard',         name: 'Костедробильня',     race: 'undead', cost: 220, hp: 500, spawnInterval: 540, unitTypeId: 'bone_catapult', color: '#999977', description: 'Костяные катапульты — удар по площади' },
  gargoyle_spire:    { id: 'gargoyle_spire',    name: 'Шпиль горгулий',     race: 'undead', cost: 240, hp: 450, spawnInterval: 440, unitTypeId: 'gargoyle',      color: '#555566', description: 'Горгульи — летают над полем' },
  // башни: не нанимают, а стреляют (spawnInterval — тиков между выстрелами); числа — как на сервере
  guard_tower:       { id: 'guard_tower',       name: 'Сторожевая башня',   race: 'human',  cost: 180, hp: 2400, spawnInterval: 15, unitTypeId: '',            color: '#556688', description: 'Стреляет по врагам; её можно разрушить', tower: { damage: 55, range: 280, proj: 'bolt' } },
  war_camp:          { id: 'war_camp',          name: 'Военный лагерь',     race: 'orc',    cost: 100, hp: 500, spawnInterval: 200, unitTypeId: 'orc_grunt',     color: '#6a8f3a', description: 'Орки — ближний бой', antiTank: { name: 'Взрывные копья', cost: 150 } },
  spirit_lodge:      { id: 'spirit_lodge',      name: 'Хижина духов',       race: 'orc',    cost: 120, hp: 400, spawnInterval: 240, unitTypeId: 'totem_spirit',  color: '#c0502a', description: 'Духи-тотемы — огонь издалека' },
  demon_gate:        { id: 'demon_gate',        name: 'Врата демонов',      race: 'orc',    cost: 150, hp: 350, spawnInterval: 380, unitTypeId: 'demon',         color: '#9a1f2a', description: 'Демоны — сильная магия' },
  yeti_den:          { id: 'yeti_den',          name: 'Логово йети',        race: 'orc',    cost: 200, hp: 500, spawnInterval: 520, unitTypeId: 'yeti',          color: '#cfe3f0', description: 'Йети — тяжёлый ближний бой' },
  siege_yard:        { id: 'siege_yard',        name: 'Осадный двор',       race: 'orc',    cost: 220, hp: 500, spawnInterval: 550, unitTypeId: 'orc_catapult',  color: '#8a5a2a', description: 'Огненные катапульты — удар по площади' },
  dragon_roost:      { id: 'dragon_roost',      name: 'Гнездо драконов',    race: 'orc',    cost: 240, hp: 450, spawnInterval: 450, unitTypeId: 'dragon',        color: '#d9782a', description: 'Драконы — летают над полем' },
  war_forge:         { id: 'war_forge',         name: 'Кузня махин',        race: 'orc',    cost: 300, hp: 600, spawnInterval: 720, unitTypeId: 'war_machine',   color: '#6b4a2b', description: 'Боевые махины — броня и пушка' },
  orc_tower:         { id: 'orc_tower',         name: 'Башня орков',        race: 'orc',    cost: 180, hp: 2400, spawnInterval: 15, unitTypeId: '',            color: '#6b4a2b', description: 'Стреляет по врагам; её можно разрушить', tower: { damage: 55, range: 280, proj: 'bolt' } },
  orc_flak:          { id: 'orc_flak',          name: 'Гнездо гарпий',      race: 'orc',    cost: 400, hp: 1600, spawnInterval: 20, unitTypeId: '',            color: '#6b4a2b', description: 'ПВО: сбивает ракеты, бьёт летунов', tower: { damage: 45, range: 320, proj: 'bolt', airOnly: true, antiNuke: { range: 500, cooldown: 1200 } } },
  orc_market:        { id: 'orc_market',        name: 'Базар',              race: 'orc',    cost: 200, hp: 500, spawnInterval: 0,   unitTypeId: '',            color: '#c8a040', description: 'Приносит золото (без воинов)', income: 9 },
  market:            { id: 'market',            name: 'Рынок',              race: 'human',  cost: 200, hp: 500, spawnInterval: 0,   unitTypeId: '',            color: '#c8a040', description: 'Приносит золото (без воинов)', income: 9 },
  black_market:      { id: 'black_market',      name: 'Чёрный рынок',       race: 'undead', cost: 200, hp: 500, spawnInterval: 0,   unitTypeId: '',            color: '#7a6a40', description: 'Приносит золото (без воинов)', income: 9 },
  flak_tower:        { id: 'flak_tower',        name: 'Зенитная башня',     race: 'human',  cost: 400, hp: 1600, spawnInterval: 20, unitTypeId: '',            color: '#667788', description: 'ПВО: сбивает ракеты, бьёт летунов', tower: { damage: 45, range: 320, proj: 'bolt', airOnly: true, antiNuke: { range: 500, cooldown: 1200 } } },
  harpy_spire:       { id: 'harpy_spire',       name: 'Шпиль-перехватчик',  race: 'undead', cost: 400, hp: 1600, spawnInterval: 20, unitTypeId: '',            color: '#556655', description: 'ПВО: сбивает ракеты, бьёт летунов', tower: { damage: 45, range: 320, proj: 'orb', airOnly: true, antiNuke: { range: 500, cooldown: 1200 } } },
  bone_tower:        { id: 'bone_tower',        name: 'Костяная башня',     race: 'undead', cost: 180, hp: 2300, spawnInterval: 16, unitTypeId: '',            color: '#445544', description: 'Стреляет по врагам; её можно разрушить', tower: { damage: 60, range: 270, proj: 'orb' } },
}

export const BUILDINGS_BY_RACE: Record<Race, string[]> = {
  human:  ['barracks', 'rifle_range', 'church', 'mortar_battery', 'foundry', 'aviary', 'workshop', 'guard_tower', 'flak_tower', 'market'],
  undead: ['crypt', 'spider_lair', 'necromancer_tower', 'slaughterhouse', 'bone_yard', 'gargoyle_spire', 'death_forge', 'bone_tower', 'harpy_spire', 'black_market'],
  orc:    ['war_camp', 'spirit_lodge', 'demon_gate', 'yeti_den', 'siege_yard', 'dragon_roost', 'war_forge', 'orc_tower', 'orc_flak', 'orc_market'],
}

// World constants (must match server)
export { WORLD_W, WORLD_H } from './world'

/** Замок отстреливается (как на сервере). */
export const CASTLE_GUNS = { range: 300, damage: 35, interval: 30, targets: 2 }

/** Фаустпатрон: дальность выстрела по танку (как на сервере). */
export const ANTITANK_RANGE = 220

/** Лечение жреца за раз (как на сервере). */
export const PRIEST_HEAL = 18
