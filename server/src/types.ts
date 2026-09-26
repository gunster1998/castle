// Общие типы клиента и сервера. Файл одинаковый в client/src и server/src — меняйте оба.

export type Team = 'west' | 'east'
export type Race = 'human' | 'undead' | 'orc'
export type GamePhase = 'lobby' | 'playing' | 'round_end' | 'game_end'
export type BotLevel = 'easy' | 'normal' | 'hard'
/** Игроков в команде в режимах быстрого поиска и игры с ботами. */
export type TeamSize = 1 | 2 | 4
/** Максимум игроков в одной команде. */
export const TEAM_MAX = 4

export interface UnitTypeDef {
  id: string
  name: string
  hp: number
  damage: number
  speed: number          // пикселей мира за тик
  range: number          // дальность атаки
  attackInterval: number // тиков между атаками
  radius: number
  color: string
  /** Летает: пешие бойцы ближнего боя его не достают, линии ему не нужны. */
  flying?: boolean
  /** Артиллерия: урон по площади вокруг цели (радиус); по летунам не стреляет. */
  splash?: number
  /** Бронетехника: её с одного выстрела убивает фаустпатрон. */
  armored?: boolean
}

export interface BuildingTypeDef {
  id: string
  name: string
  race: Race
  cost: number
  hp: number
  spawnInterval: number  // тиков между выходом юнитов (у башни — между выстрелами)
  unitTypeId: string     // у башни пусто
  color: string
  description: string
  /** Башня: не нанимает воинов, а сама стреляет по врагам в радиусе. */
  tower?: TowerDef
  /** Можно купить противотанковое оружие для воинов этого здания. */
  antiTank?: { name: string; cost: number }
  /** Рынок: воинов не нанимает, приносит столько золота за каждый шаг дохода. */
  income?: number
}

export interface TowerDef {
  damage: number
  range: number
  /** Чем стреляет — для отрисовки. */
  proj: 'bolt' | 'orb'
  /** ПВО: стреляет только по летунам. */
  airOnly?: boolean
  /** ПВО: сбивает вражеские ракеты, летящие в этот радиус (раз в cooldown тиков). */
  antiNuke?: { range: number; cooldown: number }
}

export interface Unit {
  id: string
  typeId: string
  team: Team
  x: number
  y: number
  hp: number
  maxHp: number
  attackCooldown: number
  /** Уровень здания, из которого вышел воин (1–3). */
  level: number
  /** Чей воин: для статистики. */
  ownerId: string
  /** Линия (0 — верхняя, 1 — центральная, 2 — нижняя) и сколько её точек уже пройдено. */
  lane: number
  wp: number
  /** Фаустпатрон за спиной (1 — есть, выстрел убивает танк). */
  at?: number
}

export interface Building {
  id: string
  typeId: string
  race: Race
  team: Team
  ownerId: string
  x: number
  y: number
  hp: number
  maxHp: number
  spawnTimer: number
  /** Уровень улучшения, 1–3. */
  level: number
  /** Куплены фаустпатроны: воины выходят с противотанковым выстрелом. */
  antiTank?: boolean
  /** ПВО: с какого тика снова может сбить ракету. */
  interceptReady?: number
}

export type AuraKind = 'damage' | 'speed'
export type PingKind = 'attack' | 'help'
/** До какого тика действует каждая аура (0 — не включена). */
export type Auras = Record<AuraKind, number>

export interface Castle {
  hp: number
  maxHp: number
  /** Перезарядка стрелков замка, тиков (взвелась — значит, только что выстрелили). */
  gunCd?: number
}

export interface PlayerState {
  id: string
  name: string
  team: Team
  race: Race
  gold: number
  lumber: number
  ready: boolean
  connected: boolean
  bot?: BotLevel
  /** Суперудар уже использован (один на раунд). */
  strikeUsed: boolean
  /** Ядерных ракет в запасе: одна даётся в начале раунда, ещё можно купить за золото. */
  nukes: number
  /** Ополчение уже вызвано в этом раунде. */
  militiaUsed?: boolean
  /** Итоги за всю игру (все раунды). */
  stats: PlayerStats
}

export interface PlayerStats {
  /** Убито вражеских воинов (воинами, башнями и суперударом). */
  kills: number
  /** Потеряно своих воинов. */
  lost: number
  /** Урон по вражескому замку. */
  castleDmg: number
  /** Нанято воинов. */
  trained: number
  /** Построено зданий. */
  built: number
  /** Потрачено золота (здания и улучшения). */
  spent: number
  /** Убито суперударом и ракетой. */
  strikeKills: number
  /** Убито башнями. */
  towerKills: number
}

/** Суперудар: метка на земле, в тик hitTick — удар. */
export interface Strike {
  id: string
  team: Team
  ownerId: string
  x: number
  y: number
  hitTick: number
  /** Сколько воинов погибло (после удара). */
  killed?: number
  /** Ядерная ракета (иначе — суперудар). */
  nuke?: boolean
  /** Урон по замку (ракета). */
  castleHit?: number
  /** Сколько вражеских зданий снесла ракета. */
  razed?: number
  /** Ракету сбила ПВО: в этот тик (в воздухе), ничего не разрушено. */
  interceptAt?: number
  /** Какая ПВО сбила (id здания). */
  interceptBy?: string
}

export interface GameState {
  roomId: string
  roomName: string
  tick: number
  phase: GamePhase
  round: number
  maxRounds: number
  wins: { west: number; east: number }
  castles: { west: Castle; east: Castle }
  units: Unit[]
  buildings: Building[]
  players: PlayerState[]
  /** Суперудары: ожидающие и только что прошедшие (для эффекта). */
  strikes: Strike[]
  /** Ауры замка на все войска команды: до какого тика действуют. */
  auras: Record<Team, Auras>
  /** Погода и время суток этого раунда. */
  conditions?: { night: boolean; rain: boolean }
  /** «Последний шанс» уже выдан команде в этом раунде (всем по ракете, когда сильно проигрывает). */
  comeback?: Record<Team, boolean>
  roundEndTimer: number
  /** Причина конца матча, если он закончился досрочно (соперник вышел). */
  notice?: string
}

export interface RoomInfo {
  id: string
  name: string
  phase: GamePhase
  players: { name: string; race: Race; team: Team; bot?: BotLevel }[]
  open: boolean
  maxPlayers: number
}

/** Строка чата. team — цвет имени в комнате; в общем чате не задан. */
export interface ChatLine {
  from: string
  team?: Team
  text: string
  /** Время отправки, мс (Date.now на сервере). */
  at: number
}
export type ChatScope = 'lobby' | 'room'

export type ServerMsg =
  /** build — имя собранного скрипта клиента на сервере: не совпало со своим — вкладка устарела. */
  | { type: 'init'; playerId: string; build?: string }
  | { type: 'lobby'; online: number; searching: number; rooms: RoomInfo[] }
  | { type: 'queue'; searching: boolean; size?: TeamSize }
  | { type: 'room'; roomId: string | null; team: Team | null }
  | { type: 'state'; state: GameState }
  | { type: 'error'; message: string }
  /** Метка союзника на поле: «атакуем здесь» или «нужна помощь». */
  | { type: 'ping'; x: number; y: number; kind: PingKind; from: string }
  /** reset — это вся история (при входе в комнату или меню), иначе — новые строки. */
  | { type: 'chat'; scope: ChatScope; lines: ChatLine[]; reset?: boolean }

export type ClientMsg =
  /** session — ключ вкладки: по нему сервер возвращает игрока в его партию после обновления страницы. */
  | { type: 'hello'; name: string; race: Race; session?: string }
  | { type: 'quick_match'; race: Race; size: TeamSize }
  | { type: 'cancel_queue' }
  | { type: 'create_room'; name: string; race: Race }
  | { type: 'join_room'; roomId: string; race: Race }
  | { type: 'play_bot'; race: Race; level: BotLevel; size: TeamSize }
  | { type: 'leave_room' }
  | { type: 'set_race'; race: Race }
  | { type: 'switch_team'; team: Team }
  | { type: 'add_bot'; team: Team; level: BotLevel }
  | { type: 'remove_bot'; botId: string }
  | { type: 'ready' }
  | { type: 'place_building'; buildingTypeId: string; x: number; y: number }
  | { type: 'upgrade_building'; buildingId: string }
  | { type: 'buy_antitank'; buildingId: string }
  /** Аура замка на все войска команды. */
  | { type: 'buy_aura'; aura: AuraKind }
  /** Ещё одна ядерная ракета за золото. */
  | { type: 'buy_nuke' }
  /** Ополчение: 15 защитников у замка, когда он почти разрушен. */
  | { type: 'militia' }
  /** Метка для своей команды. */
  | { type: 'ping'; x: number; y: number; kind: PingKind }
  /** Сбить летящую вражескую ракету своей. */
  | { type: 'counter_nuke'; strikeId: string }
  | { type: 'super_strike'; x: number; y: number }
  | { type: 'nuke'; x: number; y: number }
  /** Чат: в комнате — всем в комнате, в меню — всем в меню. */
  | { type: 'chat'; text: string }
  /** Отчёт о производительности клиента (см. client/src/telemetry.ts). */
  | { type: 'telemetry'; data: unknown }

// ── Сжатая передача воинов ───────────────────────────────────────────────────
// Воинов в большом бою сотни, и объект с именами полей весит в 4–5 раз больше самих чисел.
// В сети воин — массив; клиенту не нужны владелец и линия.
/** [id, тип, команда (0 — запад, 1 — восток), x, y, здоровье, макс. здоровье, перезарядка, уровень, фаустпатрон] */
export type WireUnit = [string, string, 0 | 1, number, number, number, number, number, number, number]

export function packUnit(u: Unit): WireUnit {
  return [u.id, u.typeId, u.team === 'west' ? 0 : 1, Math.round(u.x * 10) / 10, Math.round(u.y * 10) / 10,
    Math.round(u.hp), u.maxHp, u.attackCooldown, u.level, u.at ?? 0]
}

/** Состояние из сети → обычные объекты (воины приходят массивами). */
export function unpackState(state: GameState): GameState {
  const raw = state.units as unknown as (Unit | WireUnit)[]
  if (!raw.length || !Array.isArray(raw[0])) return state
  state.units = (raw as WireUnit[]).map(w => ({
    id: w[0], typeId: w[1], team: w[2] === 0 ? 'west' : 'east', x: w[3], y: w[4], hp: w[5], maxHp: w[6],
    attackCooldown: w[7], level: w[8], at: w[9], ownerId: '', lane: 1, wp: 0,
  }))
  return state
}
