// Общие типы клиента и сервера. Файл одинаковый в client/src и server/src — меняйте оба.

export type Team = 'west' | 'east'
export type Race = 'human' | 'undead'
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
}

export interface BuildingTypeDef {
  id: string
  name: string
  race: Race
  cost: number
  hp: number
  spawnInterval: number  // тиков между выходом юнитов
  unitTypeId: string
  color: string
  description: string
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
}

export interface Castle {
  hp: number
  maxHp: number
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

export type ServerMsg =
  | { type: 'init'; playerId: string }
  | { type: 'lobby'; online: number; searching: number; rooms: RoomInfo[] }
  | { type: 'queue'; searching: boolean; size?: TeamSize }
  | { type: 'room'; roomId: string | null; team: Team | null }
  | { type: 'state'; state: GameState }
  | { type: 'error'; message: string }

export type ClientMsg =
  | { type: 'hello'; name: string; race: Race }
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
