import { WebSocket } from 'ws'
import type { Sock } from './sock'
import type {
  GameState, PlayerState, PlayerStats, Unit, Building, Team, Race, BotLevel, RoomInfo, ServerMsg, ChatLine, AuraKind, Strike,
} from './types'
import { TEAM_MAX, packUnit } from './types'
import {
  UNIT_TYPES, BUILDING_TYPES, BUILDINGS_BY_RACE,
  CASTLE_HP, CASTLE_WEST, CASTLE_EAST, CASTLE_GUNS, ANTITANK_RANGE, PRIEST_HEAL,
  INCOME_INTERVAL, STARTING_GOLD, BASE_INCOME, BUILDING_INCOME_RATE,
} from './data'
import { canPlace, BASE_ZONE } from './placement'
import { MAX_LEVEL, upgradeCost, unitMult, spawnMult, buildingHpMult, BUILDING_RADIUS, marketMult, marketDecay } from './upgrades'
import { STRIKE, canStrike, NUKE, canNuke, NUKE_PRICE, NUKE_MAX, AURA, COMEBACK, MILITIA } from './strike'
import { laneFor, lanePath } from './lanes'
import { WEATHER, UNDEAD_UNITS, isArtillery, rollConditions } from './weather'

let _uid = 1
const uid = () => String(_uid++)

const emptyStats = (): PlayerStats => ({ kills: 0, lost: 0, castleDmg: 0, trained: 0, built: 0, spent: 0, strikeKills: 0, towerKills: 0 })

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

const TICK_MS = 50            // 20 тиков в секунду
const MAX_ROUNDS = 3
const ROUND_END_TICKS = 120   // 6 секунд до следующего раунда
/** После конца матча — столько на итоги, потом все возвращаются в комнату. */
export const BACK_TO_ROOM_MS = 10_000
const BOT_THINK: Record<BotLevel, number> = { easy: 110, normal: 40, hard: 16 }
/** Надбавка к доходу ботов: сложный играет «на равных с преимуществом». */
const BOT_INCOME: Record<BotLevel, number> = { easy: 1, normal: 1.1, hard: 1.25 }
/** Роль воина в армии — для подбора состава. */
type Role = 'melee' | 'ranged' | 'support' | 'artillery' | 'flyer' | 'tank' | 'tower' | 'aa' | 'eco'
const ROLE: Record<string, Role> = {
  footman: 'melee', ghoul: 'melee', abomination: 'melee',
  rifleman: 'ranged', crypt_fiend: 'ranged',
  priest: 'support', necromancer: 'support',
  mortar: 'artillery', cannon: 'artillery', bone_catapult: 'artillery',
  gryphon: 'flyer', gargoyle: 'flyer',
  steam_tank: 'tank', death_tank: 'tank',
  orc_grunt: 'melee', yeti: 'melee', totem_spirit: 'ranged', demon: 'support',
  orc_catapult: 'artillery', dragon: 'flyer', war_machine: 'tank',
}
/** К какому составу стремится бот (доли зданий по ролям). */
const TARGET_MIX: Record<Role, number> = { melee: 0.3, ranged: 0.25, support: 0.1, artillery: 0.1, flyer: 0.1, tank: 0.1, tower: 0.05, aa: 0, eco: 0 }
const roleOf = (buildingTypeId: string): Role => {
  const bt = BUILDING_TYPES[buildingTypeId]
  return bt.income ? 'eco' : bt.tower?.airOnly ? 'aa' : bt.tower ? 'tower' : ROLE[bt.unitTypeId] ?? 'melee'
}
/** Сколько врагов должно собраться в круге, чтобы бот ударил. */
const BOT_STRIKE_MIN: Record<BotLevel, number> = { easy: 7, normal: 6, hard: 5 }

export interface RoomHooks {
  /** Состав или фаза комнаты изменились — обновить список комнат. */
  changed(): void
}

/** Одна партия на двоих: лобби комнаты, раунды, боты. */
export class GameRoom {
  readonly id: string
  readonly name: string
  /** Комнату нашёл матчмейкинг или она с ботом — в список открытых не попадает. */
  readonly listed: boolean
  private sockets = new Map<string, Sock>()   // только живые игроки, у ботов сокета нет
  private state: GameState
  private interval: ReturnType<typeof setInterval> | null = null
  private chatLines: ChatLine[] = []
  private backTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(id: string, name: string, listed: boolean, private hooks: RoomHooks) {
    this.id = id
    this.name = name
    this.listed = listed
    this.state = this.makeInitialState()
  }

  private makeInitialState(): GameState {
    return {
      roomId: this.id,
      roomName: this.name,
      tick: 0,
      phase: 'lobby',
      round: 0,
      maxRounds: MAX_ROUNDS,
      wins: { west: 0, east: 0 },
      castles: {
        west: { hp: CASTLE_HP, maxHp: CASTLE_HP },
        east: { hp: CASTLE_HP, maxHp: CASTLE_HP },
      },
      units: [],
      buildings: [],
      players: [],
      strikes: [],
      auras: { west: { damage: 0, speed: 0 }, east: { damage: 0, speed: 0 } },
      roundEndTimer: 0,
    }
  }

  // ── Состав ────────────────────────────────────────────────────────────────

  get humanCount() { return this.sockets.size }
  get phase() { return this.state.phase }
  get isFull() { return this.state.players.length >= TEAM_MAX * 2 }
  private teamCount(t: Team) { return this.state.players.filter(p => p.team === t).length }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      phase: this.state.phase,
      players: this.state.players.map(p => ({ name: p.name, race: p.race, team: p.team, bot: p.bot })),
      open: this.listed && this.state.phase === 'lobby' && !this.isFull,
      maxPlayers: TEAM_MAX * 2,
    }
  }

  /** Желаемая команда, если в ней есть место, иначе та, где меньше игроков. */
  private freeTeam(prefer?: Team): Team | null {
    if (prefer && this.teamCount(prefer) < TEAM_MAX) return prefer
    const w = this.teamCount('west'), e = this.teamCount('east')
    if (w >= TEAM_MAX && e >= TEAM_MAX) return null
    return w <= e ? (w < TEAM_MAX ? 'west' : 'east') : (e < TEAM_MAX ? 'east' : 'west')
  }

  addPlayer(id: string, ws: Sock, name: string, race: Race, prefer?: Team): Team | null {
    if (this.state.phase !== 'lobby') return null
    const team = this.freeTeam(prefer)
    if (!team) return null
    this.sockets.set(id, ws)
    this.state.players.push({ id, name, team, race, gold: 0, lumber: 0, ready: false, connected: true, strikeUsed: false, nukes: 1, stats: emptyStats() })
    this.send(id, { type: 'room', roomId: this.id, team })
    this.send(id, { type: 'chat', scope: 'room', lines: this.chatLines, reset: true })
    this.broadcastState()
    this.hooks.changed()
    return team
  }

  addBot(race: Race, level: BotLevel, prefer?: Team) {
    if (this.state.phase !== 'lobby') return
    const team = this.freeTeam(prefer)
    if (!team || (prefer && team !== prefer)) return
    const names: Record<BotLevel, string> = { easy: 'Бот · лёгкий', normal: 'Бот', hard: 'Бот · сложный' }
    const n = this.state.players.filter(p => p.bot).length + 1
    this.state.players.push({
      id: `bot-${uid()}`, name: `${names[level]} ${n}`, team, race, gold: 0, lumber: 0, ready: true, connected: true, bot: level, strikeUsed: false, nukes: 1, stats: emptyStats(),
    })
    this.broadcastState()
    this.hooks.changed()
  }

  removeBot(botId: string) {
    if (this.state.phase !== 'lobby') return
    const before = this.state.players.length
    this.state.players = this.state.players.filter(p => !(p.id === botId && p.bot))
    if (this.state.players.length !== before) { this.broadcastState(); this.hooks.changed() }
  }

  switchTeam(id: string, team: Team) {
    const p = this.state.players.find(p => p.id === id)
    if (!p || this.state.phase !== 'lobby' || p.team === team || this.teamCount(team) >= TEAM_MAX) return
    p.team = team
    p.ready = false
    this.send(id, { type: 'room', roomId: this.id, team })
    this.broadcastState()
    this.hooks.changed()
  }

  /** Связь с игроком оборвалась: место в партии держим, пока он не вернётся (или не истечёт ожидание). */
  disconnect(id: string) {
    const p = this.state.players.find(p => p.id === id)
    this.sockets.delete(id)
    if (!p) return
    p.connected = false
    this.broadcastState()
    this.hooks.changed()
  }

  /** Игрок вернулся (например, обновил страницу): тот же игрок, та же команда, то же золото. */
  reattach(id: string, ws: Sock): boolean {
    const p = this.state.players.find(p => p.id === id)
    if (!p) return false
    this.sockets.set(id, ws)
    p.connected = true
    this.send(id, { type: 'room', roomId: this.id, team: p.team })
    this.send(id, { type: 'chat', scope: 'room', lines: this.chatLines, reset: true })
    this.broadcastState()
    this.hooks.changed()
    return true
  }

  /** Есть ли в комнате хоть кто-то живой или ожидаемый. */
  get hasHumans() { return this.state.players.some(p => !p.bot) }

  /** Игрок вышел. Возвращает true, если в комнате не осталось живых игроков. */
  removePlayer(id: string): boolean {
    const leaving = this.state.players.find(p => p.id === id)
    this.sockets.delete(id)
    this.state.players = this.state.players.filter(p => p.id !== id)
    // комната живёт, пока в ней есть люди — в том числе те, кто сейчас переподключается
    if (!this.hasHumans) {
      this.stop()
      this.closed = true
      if (this.backTimer) clearTimeout(this.backTimer)
      return true
    }
    const s = this.state
    const teamLeft = leaving ? this.teamCount(leaving.team) : 1
    if (leaving && (s.phase === 'playing' || s.phase === 'round_end') && teamLeft > 0) {
      // команда играет дальше без него; его здания остаются
      s.notice = undefined
    } else if (leaving && (s.phase === 'playing' || s.phase === 'round_end')) {
      // в команде никого не осталось — победа соперникам
      const winner: Team = leaving.team === 'west' ? 'east' : 'west'
      s.wins[winner] = Math.ceil(s.maxRounds / 2)
      s.phase = 'game_end'
      s.notice = teamLeft === 0 && this.state.players.filter(p => p.team === leaving.team).length === 0
        ? `Команда соперника (${leaving.name}) вышла из игры — победа за вами`
        : `Соперник (${leaving.name}) вышел из игры — победа за вами`
      s.units = []
      this.stop()
      this.scheduleBackToRoom()
    } else if (s.phase === 'game_end') {
      s.notice = `Соперник (${leaving?.name ?? '?'}) вышел из комнаты`
    } else {
      for (const p of s.players) p.ready = !!p.bot
    }
    this.broadcastState()
    this.hooks.changed()
    return false
  }

  setRace(id: string, race: Race) {
    const p = this.state.players.find(p => p.id === id)
    if (!p || this.state.phase !== 'lobby') return
    p.race = race
    p.ready = false
    this.broadcastState()
    this.hooks.changed()
  }

  /** Готовность. В конце матча «готов» означает реванш. */
  ready(id: string) {
    const s = this.state
    const p = s.players.find(p => p.id === id)
    if (!p) return
    if (s.phase === 'game_end') {
      // «В комнату» — не ждать таймера
      this.backToRoom()
      return
    }
    if (s.phase !== 'lobby') return
    p.ready = true
    this.broadcastState()
    this.tryStart()
  }

  tryStart() {
    const s = this.state
    if (s.phase !== 'lobby') return
    const teams = new Set(s.players.map(p => p.team))
    if (!teams.has('west') || !teams.has('east')) return
    if (!s.players.every(p => p.ready)) return
    this.startRound()
    this.hooks.changed()
  }

  handleMessage(playerId: string, msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'ready': return this.ready(playerId)
      case 'set_race': return this.setRace(playerId, msg.race as Race)
      case 'switch_team': return this.switchTeam(playerId, msg.team === 'east' ? 'east' : 'west')
      case 'add_bot': return this.addBot((['human', 'undead', 'orc'] as Race[])[Math.floor(Math.random() * 3)], (['easy', 'normal', 'hard'].includes(msg.level as string) ? msg.level : 'normal') as BotLevel, msg.team === 'east' ? 'east' : 'west')
      case 'remove_bot': return this.removeBot(String(msg.botId))
      case 'place_building': return this.placeBuilding(playerId, String(msg.buildingTypeId), Number(msg.x), Number(msg.y))
      case 'upgrade_building': return this.upgradeBuilding(playerId, String(msg.buildingId))
      case 'super_strike': return this.superStrike(playerId, Number(msg.x), Number(msg.y))
      case 'nuke': return this.launchNuke(playerId, Number(msg.x), Number(msg.y))
      case 'buy_antitank': return this.buyAntiTank(playerId, String(msg.buildingId))
      case 'buy_aura': return this.buyAura(playerId, msg.aura === 'speed' ? 'speed' : 'damage')
      case 'buy_nuke': return this.buyNuke(playerId)
      case 'counter_nuke': return this.counterNuke(playerId, String(msg.strikeId))
      case 'militia': return this.militia(playerId)
      case 'ping': return this.ping(playerId, Number(msg.x), Number(msg.y), msg.kind === 'help' ? 'help' : 'attack')
    }
  }

  private stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null }
  }

  // ── Раунды ────────────────────────────────────────────────────────────────

  private startRound() {
    const s = this.state
    s.round++
    s.phase = 'playing'
    s.tick = 0
    s.roundEndTimer = 0
    s.units = []
    s.buildings = []
    s.strikes = []
    // ауры замка покупаются заново каждый раунд — как и здания
    s.auras = { west: { damage: 0, speed: 0 }, east: { damage: 0, speed: 0 } }
    s.comeback = { west: false, east: false }
    s.conditions = rollConditions()
    s.notice = undefined
    // чем больше команды, тем прочнее замки
    const size = Math.max(this.teamCount('west'), this.teamCount('east'), 1)
    const hp = Math.round(CASTLE_HP * (1 + 0.6 * (size - 1)))
    s.castles = {
      west: { hp, maxHp: hp },
      east: { hp, maxHp: hp },
    }
    for (const p of s.players) {
      p.gold = STARTING_GOLD
      p.lumber = 0
      p.ready = !!p.bot
      // суперудар и ракета — по одному на каждый раунд
      p.strikeUsed = false
      p.militiaUsed = false
      p.nukes = Math.max(p.nukes, 1)
    }
    if (!this.interval) this.interval = setInterval(() => this.tick(), TICK_MS)
    this.broadcastState()
  }

  private endRound(winner: Team) {
    this.state.phase = 'round_end'
    this.state.wins[winner]++
    this.state.roundEndTimer = ROUND_END_TICKS
    this.broadcastState()
  }

  private scheduleBackToRoom() {
    if (this.backTimer) clearTimeout(this.backTimer)
    this.backTimer = setTimeout(() => this.backToRoom(), BACK_TO_ROOM_MS)
  }

  /** Матч окончен: та же комната, те же игроки и боты — снова лобби, можно готовиться к новой игре. */
  private backToRoom() {
    if (this.backTimer) { clearTimeout(this.backTimer); this.backTimer = null }
    if (this.closed || this.state.phase !== 'game_end') return
    const keep = this.state.players
    this.state = this.makeInitialState()
    this.state.players = keep.map(pl => ({ ...pl, ready: !!pl.bot, gold: 0, lumber: 0, strikeUsed: false, nukes: 1, stats: emptyStats() }))
    this.broadcastState()
    this.hooks.changed()
  }

  /** Замеры для логов производительности: длительность тика и объём рассылки. */
  stats = { ticks: 0, tickMs: 0, tickMax: 0, bytes: 0, unitsMax: 0 }
  takeStats() {
    const st = { ...this.stats, phase: this.state.phase, players: this.state.players.length, humans: this.state.players.filter(p => !p.bot).length, units: this.state.units.length, buildings: this.state.buildings.length }
    this.stats = { ticks: 0, tickMs: 0, tickMax: 0, bytes: 0, unitsMax: 0 }
    return st
  }

  private tick() {
    const t0 = performance.now()
    this.tickInner()
    const ms = performance.now() - t0
    this.stats.ticks++
    this.stats.tickMs += ms
    this.stats.tickMax = Math.max(this.stats.tickMax, ms)
    this.stats.unitsMax = Math.max(this.stats.unitsMax, this.state.units.length)
  }

  private tickInner() {
    const s = this.state

    if (s.phase === 'round_end') {
      s.roundEndTimer--
      if (s.roundEndTimer <= 0) {
        const needed = Math.ceil(s.maxRounds / 2)
        if (s.wins.west >= needed || s.wins.east >= needed) {
          s.phase = 'game_end'
          this.stop()
          this.scheduleBackToRoom()
          this.hooks.changed()
        } else {
          this.startRound()
        }
      }
      this.broadcastState()
      return
    }

    if (s.phase !== 'playing') return
    s.tick++

    for (const u of s.units) {
      if (u.attackCooldown > 0) u.attackCooldown--
    }

    const dead = new Set<string>()
    let razed = false
    this.byId = new Map(s.players.map(p => [p.id, p]))
    for (const unit of s.units) {
      if (dead.has(unit.id)) continue
      const utype = UNIT_TYPES[unit.typeId]
      const mult = unitMult(unit.level)
      // погода: ночью дальние бьют ближе, нежить сильнее; в дождь артиллерия медленнее
      const cond = s.conditions
      const arty = isArtillery(unit.typeId, utype.splash)
      const range = utype.range * (cond?.night && utype.range >= 100 ? WEATHER.nightRange : 1)
      const speed = utype.speed * (cond?.rain && arty ? WEATHER.rainArtillerySpeed : 1)
      const wdmg = cond?.night && UNDEAD_UNITS.has(unit.typeId) ? WEATHER.nightUndeadDamage : 1
      const wint = cond?.rain && arty ? WEATHER.rainArtilleryInterval : 1
      // Жрец лечит раненых союзников (список союзников нужен только ему)
      if (unit.typeId === 'priest' && unit.attackCooldown === 0) {
        const healTarget = s.units
          .filter(u => u.team === unit.team && u.id !== unit.id && !dead.has(u.id))
          .filter(a => a.hp < a.maxHp && dist(unit, a) <= range)
          .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0]
        if (healTarget) {
          healTarget.hp = Math.min(healTarget.maxHp, healTarget.hp + Math.round(PRIEST_HEAL * mult))
          unit.attackCooldown = utype.attackInterval
        }
      }

      // Фаустпатрон: танк рядом — подойти на выстрел и убить с одного попадания
      if (unit.at) {
        let tank: Unit | null = null
        let td = 260
        for (const e of s.units) {
          if (e.team === unit.team || dead.has(e.id) || !UNIT_TYPES[e.typeId].armored) continue
          const d = dist(unit, e)
          if (d < td) { td = d; tank = e }
        }
        if (tank) {
          if (td <= ANTITANK_RANGE) {
            if (unit.attackCooldown === 0) {
              tank.hp = 0
              dead.add(tank.id)
              this.credit(unit.ownerId, tank)
              unit.at = 0
              unit.attackCooldown = utype.attackInterval
            }
          } else {
            this.moveToward(unit, tank, speed)
          }
          continue
        }
      }

      // Ближайший враг в пределах видимости: воин или вражеская башня (остальные здания не атакуются).
      // Летунов достают только стрелки, маги и другие летуны
      const aggro = utype.flying ? 260 : Math.max(range + 40, 230)
      const canAir = !!utype.flying || (utype.range >= 100 && !utype.splash)
      let target: Unit | null = null
      let best = aggro
      for (const e of s.units) {
        if (e.team === unit.team || dead.has(e.id)) continue
        if (!canAir && UNIT_TYPES[e.typeId].flying) continue
        const d = dist(unit, e)
        if (d < best) { best = d; target = e }
      }
      let tower: Building | null = null
      for (const b of s.buildings) {
        if (b.team === unit.team || b.hp <= 0 || !BUILDING_TYPES[b.typeId].tower) continue
        const d = dist(unit, b) - BUILDING_RADIUS
        if (d < best) { best = d; tower = b; target = null }
      }

      if (tower) {
        if (best <= range) {
          if (unit.attackCooldown === 0) {
            const aura = s.auras[unit.team]
            unit.attackCooldown = Math.max(3, Math.round(utype.attackInterval * wint * (aura.speed > s.tick ? AURA.speedMult : 1)))
            tower.hp -= Math.round(utype.damage * mult * wdmg * (aura.damage > s.tick ? AURA.damageMult : 1))
            if (tower.hp <= 0) razed = true
          }
        } else {
          this.moveToward(unit, tower, speed)
        }
      } else if (target) {
        if (best <= range) {
          if (unit.attackCooldown === 0) {
            const aura = s.auras[unit.team]
            const dmg = Math.round(utype.damage * mult * wdmg * (aura.damage > s.tick ? AURA.damageMult : 1))
            unit.attackCooldown = Math.max(3, Math.round(utype.attackInterval * wint * (aura.speed > s.tick ? AURA.speedMult : 1)))
            if (utype.splash) {
              // артиллерия: вся пехота вокруг точки попадания, соседи — на 60%
              for (const e of s.units) {
                if (e.team === unit.team || dead.has(e.id) || UNIT_TYPES[e.typeId].flying) continue
                if (dist(e, target) > utype.splash) continue
                e.hp -= e === target ? dmg : Math.round(dmg * 0.6)
                if (e.hp <= 0) { dead.add(e.id); this.credit(unit.ownerId, e) }
              }
            } else {
              target.hp -= dmg
              if (target.hp <= 0) { dead.add(target.id); this.credit(unit.ownerId, target) }
            }
          }
        } else {
          this.moveToward(unit, target, speed)
        }
      } else if (this.followLane(unit, !!utype.flying, speed)) {
        // идёт по своей линии
      } else {
        const castlePos = unit.team === 'west' ? CASTLE_EAST : CASTLE_WEST
        if (dist(unit, castlePos) < 80) {
          const castle = unit.team === 'west' ? s.castles.east : s.castles.west
          const dmg = Math.round(utype.damage * mult * wdmg * 2)
          castle.hp -= dmg
          const owner = this.byId.get(unit.ownerId)
          if (owner) owner.stats.castleDmg += dmg
          dead.add(unit.id)
        } else {
          this.moveToward(unit, castlePos, speed)
        }
      }
    }
    s.units = s.units.filter(u => !dead.has(u.id))
    // разрушенные башни
    if (razed) s.buildings = s.buildings.filter(b => b.hp > 0)
    this.castleGuns()
    this.resolveStrikes()
    this.checkComeback()

    for (const b of s.buildings) {
      const btype = BUILDING_TYPES[b.typeId]
      if (btype.income) continue // рынок: только доход
      if (btype.tower) { this.towerShoot(b, btype.tower.damage, btype.tower.range * (s.conditions?.night ? 0.85 : 1), btype.spawnInterval, !!btype.tower.airOnly); continue }
      b.spawnTimer--
      if (b.spawnTimer <= 0) {
        this.spawnFromBuilding(b)
        b.spawnTimer = Math.round(btype.spawnInterval * spawnMult(b.level))
      }
    }
    if (s.units.some(u => u.hp <= 0)) s.units = s.units.filter(u => u.hp > 0)

    if (s.tick % INCOME_INTERVAL === 0) {
      for (const p of s.players) {
        let income = BASE_INCOME
        // рынки: самый прокачанный — первым, каждый следующий приносит меньше
        const markets = s.buildings.filter(b => b.ownerId === p.id && BUILDING_TYPES[b.typeId].income).sort((a, b) => b.level - a.level)
        markets.forEach((b, i) => { income += BUILDING_TYPES[b.typeId].income! * marketMult(b.level) * marketDecay(i) })
        for (const b of s.buildings.filter(b => b.ownerId === p.id && !BUILDING_TYPES[b.typeId].income)) {
          income += Math.floor(BUILDING_TYPES[b.typeId].cost * BUILDING_INCOME_RATE)
        }
        income = Math.round(income)
        p.gold += p.bot ? Math.round(income * BOT_INCOME[p.bot]) : income
      }
    }

    for (const p of s.players) if (p.bot) { this.botStrike(p); this.botNuke(p); this.botThink(p) }

    if (s.castles.west.hp <= 0) { this.endRound('east'); return }
    if (s.castles.east.hp <= 0) { this.endRound('west'); return }

    this.broadcastState()
  }

  /** Команда сильно проигрывает — каждому её игроку по ядерной ракете (раз за раунд). */
  private checkComeback() {
    const s = this.state
    s.comeback ??= { west: false, east: false }
    for (const team of ['west', 'east'] as Team[]) {
      if (s.comeback[team]) continue
      const own = s.castles[team], foe = s.castles[team === 'west' ? 'east' : 'west']
      const ownR = own.hp / own.maxHp, foeR = foe.hp / foe.maxHp
      if (ownR > COMEBACK.ownBelow || foeR - ownR < COMEBACK.gap) continue
      s.comeback[team] = true
      for (const p of s.players) if (p.team === team) p.nukes = Math.min(NUKE_MAX, p.nukes + 1)
    }
  }

  /** Замки отстреливаются: по нескольким ближайшим врагам вокруг, и по летунам тоже. */
  private castleGuns() {
    const s = this.state
    for (const team of ['west', 'east'] as Team[]) {
      const c = s.castles[team]
      if (c.gunCd && c.gunCd > 0) { c.gunCd--; continue }
      const pos = team === 'west' ? CASTLE_WEST : CASTLE_EAST
      const near = s.units
        .filter(u => u.team !== team && u.hp > 0 && dist(u, pos) <= CASTLE_GUNS.range)
        .sort((a, b) => dist(a, pos) - dist(b, pos))
        .slice(0, CASTLE_GUNS.targets)
      if (!near.length) continue
      for (const u of near) {
        u.hp -= CASTLE_GUNS.damage
        if (u.hp <= 0) this.credit('', u)
      }
      c.gunCd = CASTLE_GUNS.interval
    }
    if (s.units.some(u => u.hp <= 0)) s.units = s.units.filter(u => u.hp > 0)
  }

  /** Игроки по id — для статистики (обновляется каждый тик). */
  private byId = new Map<string, PlayerState>()

  /** Воин игрока killerOwner убил victim. */
  private credit(killerOwner: string, victim: Unit, kind?: 'tower' | 'strike') {
    const k = this.byId.get(killerOwner)
    if (k) {
      k.stats.kills++
      if (kind === 'tower') k.stats.towerKills++
      if (kind === 'strike') k.stats.strikeKills++
    }
    const v = this.byId.get(victim.ownerId)
    if (v) v.stats.lost++
  }

  /** Башня: перезарядка, потом выстрел по ближайшему врагу в радиусе. Ждёт цель с готовым выстрелом (spawnTimer = 0). */
  private towerShoot(b: Building, damage: number, range: number, interval: number, airOnly: boolean) {
    if (b.spawnTimer > 0) { b.spawnTimer--; return }
    let target: Unit | null = null
    let best = range
    for (const u of this.state.units) {
      if (u.team === b.team || u.hp <= 0) continue
      if (airOnly && !UNIT_TYPES[u.typeId].flying) continue
      const d = dist(u, b)
      if (d <= best) { best = d; target = u }
    }
    if (!target) return
    target.hp -= Math.round(damage * unitMult(b.level))
    if (target.hp <= 0) this.credit(b.ownerId, target, 'tower')
    b.spawnTimer = Math.round(interval * spawnMult(b.level))
  }

  /** Путь по линии до поворота к замку. false — точки пройдены, дальше прямо на замок. */
  private followLane(unit: Unit, flying: boolean, speed: number): boolean {
    if (flying) return false
    const path = lanePath(unit.team, unit.lane)
    const dir = unit.team === 'west' ? 1 : -1
    // точки, которые уже позади (например, воин гнался за врагом), пропускаем
    while (unit.wp < path.length && (path[unit.wp].x - unit.x) * dir < 20) unit.wp++
    if (unit.wp >= path.length) return false
    this.moveToward(unit, path[unit.wp], speed)
    return true
  }

  private moveToward(unit: Unit, target: { x: number; y: number }, speed: number) {
    const dx = target.x - unit.x
    const dy = target.y - unit.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > 0) {
      unit.x += (dx / d) * speed
      unit.y += (dy / d) * speed
    }
  }

  /** Юнит выходит из своего здания со стороны врага. */
  private spawnFromBuilding(b: Building) {
    const utype = UNIT_TYPES[BUILDING_TYPES[b.typeId].unitTypeId]
    if (!utype) return
    const side = b.team === 'west' ? 1 : -1
    const owner = this.state.players.find(p => p.id === b.ownerId)
    if (owner) owner.stats.trained++
    const hp = Math.round(utype.hp * unitMult(b.level))
    this.state.units.push({
      id: uid(),
      typeId: utype.id,
      team: b.team,
      x: b.x + side * 40,
      y: b.y + (Math.random() - 0.5) * 20,
      hp,
      maxHp: hp,
      attackCooldown: 0,
      level: b.level,
      ownerId: b.ownerId,
      lane: laneFor(b.y),
      wp: 0,
      ...(b.antiTank ? { at: 1 } : {}),
    })
  }

  // ── Суперудар ─────────────────────────────────────────────────────────────

  private superStrike(playerId: string, x: number, y: number): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const p = s.players.find(p => p.id === playerId)
    if (!p) return false
    if (p.strikeUsed) { this.send(playerId, { type: 'error', message: 'Суперудар уже использован в этом раунде' }); return false }
    const check = canStrike(p.team, x, y)
    if (!check.ok) { this.send(playerId, { type: 'error', message: check.reason }); return false }
    s.strikes.push({ id: uid(), team: p.team, ownerId: p.id, x: Math.round(x), y: Math.round(y), hitTick: s.tick + STRIKE.delay })
    p.strikeUsed = true
    this.broadcastState()
    return true
  }

  private launchNuke(playerId: string, x: number, y: number): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const p = s.players.find(p => p.id === playerId)
    if (!p) return false
    if (p.nukes <= 0) { this.send(playerId, { type: 'error', message: `Ракет нет — купите за ${NUKE_PRICE} золота` }); return false }
    const check = canNuke(x, y)
    if (!check.ok) { this.send(playerId, { type: 'error', message: check.reason }); return false }
    const st: Strike = { id: uid(), team: p.team, ownerId: p.id, x: Math.round(x), y: Math.round(y), hitTick: s.tick + NUKE.delay, nuke: true }
    // вражеская ПВО рядом с целью и готова — собьёт ракету на полпути
    const aa = s.buildings.find(b => {
      const an = BUILDING_TYPES[b.typeId].tower?.antiNuke
      return an && b.team !== p.team && b.hp > 0 && (b.interceptReady ?? 0) <= s.tick && dist(b, st) <= an.range
    })
    if (aa) {
      st.interceptAt = s.tick + Math.round(NUKE.delay * 0.55)
      st.interceptBy = aa.id
      aa.interceptReady = s.tick + BUILDING_TYPES[aa.typeId].tower!.antiNuke!.cooldown
    }
    s.strikes.push(st)
    p.nukes--
    this.broadcastState()
    return true
  }

  /** Удары, чьё время пришло: все вражеские воины в круге погибают. Прошедшие держим секунду — для эффекта. */
  private resolveStrikes() {
    const s = this.state
    if (!s.strikes.length) return
    for (const st of s.strikes) {
      if (st.killed !== undefined || s.tick < st.hitTick) continue
      if (st.interceptAt !== undefined) { st.killed = 0; continue } // сбита в воздухе
      const radius = st.nuke ? NUKE.radius : STRIKE.radius
      if (st.nuke) {
        // ракета по замку: минус доля прочности
        const enemy: Team = st.team === 'west' ? 'east' : 'west'
        const pos = enemy === 'west' ? CASTLE_WEST : CASTLE_EAST
        if (dist(pos, st) <= radius + 60) {
          const castle = s.castles[enemy]
          const dmg = Math.round(castle.maxHp * NUKE.castleDamage)
          castle.hp -= dmg
          st.castleHit = dmg
          const owner = this.byId.get(st.ownerId)
          if (owner) owner.stats.castleDmg += dmg
        }
        // ракета — единственное, что сносит здания: все вражеские в круге
        const before = s.buildings.length
        s.buildings = s.buildings.filter(b => b.team === st.team || dist(b, st) > radius)
        st.razed = before - s.buildings.length
      }
      const hit = s.units.filter(u => u.team !== st.team && dist(u, st) <= radius)
      for (const u of hit) this.credit(st.ownerId, u, 'strike')
      if (hit.length) { const gone = new Set(hit); s.units = s.units.filter(u => !gone.has(u)) }
      st.killed = hit.length
    }
    s.strikes = s.strikes.filter(st => s.tick < st.hitTick + (st.nuke ? 40 : 20))
  }

  /** Бот бьёт, когда у его базы собралась толпа врагов (удар один на игру — бережёт его). */
  private botStrike(p: PlayerState) {
    const s = this.state
    if (p.strikeUsed || s.tick % 10 !== 0) return
    if (p.bot === 'easy' && Math.random() < 0.6) return
    const pending = s.strikes.filter(st => st.team === p.team && st.killed === undefined)
    const enemies = s.units.filter(u => u.team !== p.team && canStrike(p.team, u.x, u.y).ok
      && !pending.some(st => dist(st, u) < STRIKE.radius))
    let best: Unit[] = []
    for (const e of enemies) {
      // враги идут вперёд — бьём чуть с запасом по ходу движения
      const near = enemies.filter(o => dist(o, e) <= STRIKE.radius * 0.75)
      if (near.length > best.length) best = near
    }
    // удар один — ждём толпу побольше, но если замок уже плох, бьём и по небольшой
    const castle = s.castles[p.team]
    const need = castle.hp < castle.maxHp * 0.4 ? 3 : BOT_STRIKE_MIN[p.bot!]
    if (best.length < need) return
    const lead = p.team === 'west' ? -12 : 12
    const x = best.reduce((a, u) => a + u.x, 0) / best.length + lead
    const y = best.reduce((a, u) => a + u.y, 0) / best.length
    this.superStrike(p.id, x, y)
  }

  /**
   * Бот запускает ракету только по зданиям и только когда накрывает много: по стоимости сносимого.
   * Сначала ждёт хотя бы 900 золота зданий в одном круге (обычно это 5+ зданий), к концу раунда — 600.
   */
  private botNuke(p: PlayerState) {
    const s = this.state
    // замок почти разрушен и враги у стен — ополчение
    const own = s.castles[p.team]
    if (!p.militiaUsed && own.hp <= own.maxHp * MILITIA.below) {
      const pos = p.team === 'west' ? CASTLE_WEST : CASTLE_EAST
      if (s.units.filter(u => u.team !== p.team && dist(u, pos) < 500).length >= 4) { this.militia(p.id); return }
    }
    // летит вражеская ракета по нашей базе — сбить своей (если под ударом есть что терять)
    if (p.bot !== 'easy' && p.nukes > 0) {
      for (const st of s.strikes) {
        if (!st.nuke || st.team === p.team || st.interceptAt !== undefined || st.killed !== undefined || st.hitTick - s.tick < 20) continue
        const value = s.buildings.filter(b => b.team === p.team && dist(b, st) <= NUKE.radius).reduce((a, b) => a + BUILDING_TYPES[b.typeId].cost, 0)
        if (value >= 600 && Math.random() < 0.8) { this.counterNuke(p.id, st.id); return }
      }
    }
    if (p.nukes <= 0 || s.tick % 20 !== 0 || s.tick < 20 * 60) return
    if (p.bot === 'easy' && Math.random() < 0.5) return
    const enemy = s.buildings.filter(b => b.team !== p.team)
    const worth = (b: Building) => {
      const base = BUILDING_TYPES[b.typeId].cost
      let v = base
      for (let l = 1; l < b.level; l++) v += upgradeCost(base, l)
      return v + (b.antiTank ? 150 : 0)
    }
    let best: { x: number; y: number; value: number; count: number } | null = null
    // центр круга — в каждом здании и в середине каждой пары соседей
    const centers: { x: number; y: number }[] = enemy.map(b => ({ x: b.x, y: b.y }))
    for (let i = 0; i < enemy.length; i++) for (let j = i + 1; j < enemy.length; j++) {
      if (dist(enemy[i], enemy[j]) < NUKE.radius * 1.6) centers.push({ x: (enemy[i].x + enemy[j].x) / 2, y: (enemy[i].y + enemy[j].y) / 2 })
    }
    // куда достаёт готовая вражеская ПВО — туда не стреляем (собьют)
    const aa = enemy.filter(b => BUILDING_TYPES[b.typeId].tower?.antiNuke && (b.interceptReady ?? 0) <= s.tick)
    for (const c of centers) {
      if (aa.some(b => dist(b, c) <= BUILDING_TYPES[b.typeId].tower!.antiNuke!.range)) continue
      const hit = enemy.filter(b => dist(b, c) <= NUKE.radius * 0.95)
      const value = hit.reduce((a, b) => a + worth(b), 0)
      if (!best || value > best.value) best = { ...c, value, count: hit.length }
    }
    const minutes = s.tick / 20 / 60
    const need = minutes > 4 ? 600 : 900
    // лишняя ракета в запасе — можно не жадничать
    const threshold = p.nukes > 1 ? need * 0.7 : need
    if (!best || best.value < threshold || best.count < 3) return
    this.launchNuke(p.id, best.x, best.y)
  }

  // ── Постройка ─────────────────────────────────────────────────────────────

  private placeBuilding(playerId: string, btypeId: string, x: number, y: number): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const player = s.players.find(p => p.id === playerId)
    if (!player) return false
    const btype = BUILDING_TYPES[btypeId]
    if (!btype) return false
    if (btype.race !== player.race) { this.send(playerId, { type: 'error', message: 'Это здание другой расы' }); return false }
    if (player.gold < btype.cost) { this.send(playerId, { type: 'error', message: 'Недостаточно золота' }); return false }
    const check = canPlace(player.team, x, y, s.buildings)
    if (!check.ok) { this.send(playerId, { type: 'error', message: check.reason }); return false }

    player.gold -= btype.cost
    player.lumber += btype.cost
    player.stats.built++
    player.stats.spent += btype.cost
    s.buildings.push({
      id: uid(),
      typeId: btypeId,
      race: btype.race,
      team: player.team,
      ownerId: playerId,
      x: Math.round(x), y: Math.round(y),
      hp: btype.hp, maxHp: btype.hp,
      spawnTimer: btype.spawnInterval,
      level: 1,
    })
    this.broadcastState()
    return true
  }

  /** Улучшение: сильнее воины, быстрее найм, прочнее здание. */
  private upgradeBuilding(playerId: string, buildingId: string): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const player = s.players.find(p => p.id === playerId)
    const b = s.buildings.find(b => b.id === buildingId)
    if (!player || !b) return false
    if (b.ownerId !== playerId) { this.send(playerId, { type: 'error', message: 'Это не ваше здание' }); return false }
    if (b.level >= MAX_LEVEL) { this.send(playerId, { type: 'error', message: 'Здание уже улучшено до максимума' }); return false }
    const btype = BUILDING_TYPES[b.typeId]
    const cost = upgradeCost(btype.cost, b.level)
    if (player.gold < cost) { this.send(playerId, { type: 'error', message: `Нужно ${cost} золота для улучшения` }); return false }
    player.gold -= cost
    player.stats.spent += cost
    b.level++
    const newMax = Math.round(btype.hp * buildingHpMult(b.level))
    b.hp += newMax - b.maxHp
    b.maxHp = newMax
    this.broadcastState()
    return true
  }

  /** Фаустпатроны (или костяные копья) для воинов здания. */
  private buyAntiTank(playerId: string, buildingId: string): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const player = s.players.find(p => p.id === playerId)
    const b = s.buildings.find(b => b.id === buildingId)
    if (!player || !b) return false
    const offer = BUILDING_TYPES[b.typeId].antiTank
    if (!offer || b.antiTank) return false
    if (b.ownerId !== playerId) { this.send(playerId, { type: 'error', message: 'Это не ваше здание' }); return false }
    if (player.gold < offer.cost) { this.send(playerId, { type: 'error', message: `Нужно ${offer.cost} золота` }); return false }
    player.gold -= offer.cost
    player.stats.spent += offer.cost
    b.antiTank = true
    this.broadcastState()
    return true
  }

  /** Аура замка: на 15 секунд всем войскам команды; повторная покупка продлевает (любой игрок команды). */
  private buyAura(playerId: string, kind: AuraKind): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const p = s.players.find(p => p.id === playerId)
    if (!p) return false
    const aura = s.auras[p.team]
    const from = Math.max(aura[kind], s.tick)
    if (from - s.tick + AURA.duration > AURA.maxAhead) { this.send(playerId, { type: 'error', message: 'Аура и так включена надолго' }); return false }
    if (p.gold < AURA.cost) { this.send(playerId, { type: 'error', message: `Нужно ${AURA.cost} золота` }); return false }
    p.gold -= AURA.cost
    p.stats.spent += AURA.cost
    aura[kind] = from + AURA.duration
    this.broadcastState()
    return true
  }

  /** Ополчение: 15 защитников полукругом перед своим замком (раз за раунд, когда замок почти разрушен). */
  private militia(playerId: string): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const p = s.players.find(p => p.id === playerId)
    if (!p) return false
    const castle = s.castles[p.team]
    if (p.militiaUsed) { this.send(playerId, { type: 'error', message: 'Ополчение уже вызвано в этом раунде' }); return false }
    if (castle.hp > castle.maxHp * MILITIA.below) { this.send(playerId, { type: 'error', message: `Ополчение — только когда у замка меньше ${MILITIA.below * 100}% прочности` }); return false }
    p.militiaUsed = true
    const typeId = p.race === 'undead' ? 'ghoul' : p.race === 'orc' ? 'orc_grunt' : 'footman'
    const ut = UNIT_TYPES[typeId]
    const pos = p.team === 'west' ? CASTLE_WEST : CASTLE_EAST
    const side = p.team === 'west' ? 1 : -1
    for (let i = 0; i < MILITIA.count; i++) {
      const a = (i / (MILITIA.count - 1) - 0.5) * Math.PI * 0.9
      s.units.push({
        id: uid(), typeId, team: p.team, x: pos.x + side * (110 + Math.cos(a) * 60), y: pos.y + Math.sin(a) * 170,
        hp: ut.hp, maxHp: ut.hp, attackCooldown: 0, level: 1, ownerId: p.id, lane: 1, wp: 0,
      })
    }
    p.stats.trained += MILITIA.count
    this.broadcastState()
    return true
  }

  /** Своей ракетой — навстречу вражеской: перехват в воздухе через 0,75 с. */
  private counterNuke(playerId: string, strikeId: string): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const p = s.players.find(p => p.id === playerId)
    const st = s.strikes.find(x => x.id === strikeId)
    if (!p || !st || !st.nuke || st.team === p.team) return false
    if (st.interceptAt !== undefined || st.killed !== undefined) return false
    if (p.nukes <= 0) { this.send(playerId, { type: 'error', message: 'Нечем сбивать — ракет нет' }); return false }
    if (st.hitTick - s.tick < 16) { this.send(playerId, { type: 'error', message: 'Поздно — ракета уже падает' }); return false }
    p.nukes--
    st.interceptAt = s.tick + 15
    st.interceptBy = `nuke:${p.id}`
    this.broadcastState()
    return true
  }

  private buyNuke(playerId: string): boolean {
    const s = this.state
    if (s.phase !== 'playing') return false
    const p = s.players.find(p => p.id === playerId)
    if (!p) return false
    if (p.nukes >= NUKE_MAX) { this.send(playerId, { type: 'error', message: `Больше ${NUKE_MAX} ракет не унести` }); return false }
    if (p.gold < NUKE_PRICE) { this.send(playerId, { type: 'error', message: `Ракета стоит ${NUKE_PRICE} золота` }); return false }
    p.gold -= NUKE_PRICE
    p.stats.spent += NUKE_PRICE
    p.nukes++
    this.broadcastState()
    return true
  }

  /** Бот: раз в несколько секунд строит здание, если хватает золота. */
  /** Когда бот последний раз покупал ауру. */
  private botAuraAt = new Map<string, number>()

  private botThink(p: PlayerState) {
    const level = p.bot!
    const s = this.state
    if (s.tick % BOT_THINK[level] !== 0) return
    const smart = level !== 'easy'
    const mine = s.buildings.filter(b => b.ownerId === p.id)
    const enemyUnits = s.units.filter(u => u.team !== p.team)
    const army = s.units.filter(u => u.team === p.team).length

    // в большом бою и при лишнем золоте — аура на всю армию, но не чаще раза в 45 с (иначе съедает весь доход)
    const lastAura = this.botAuraAt.get(p.id) ?? -Infinity
    if (smart && mine.length >= 6 && army >= 15 && enemyUnits.length >= 10 && s.tick - lastAura > 20 * 45) {
      const aura = s.auras[p.team]
      const kind: AuraKind = Math.random() < 0.5 ? 'damage' : 'speed'
      if (aura[kind] <= s.tick && p.gold >= AURA.cost + 400) { this.botAuraAt.set(p.id, s.tick); this.buyAura(p.id, kind); return }
    }
    if (smart && p.nukes === 0 && mine.length >= 8 && p.gold >= NUKE_PRICE + 100 && Math.random() < 0.3) { this.buyNuke(p.id); return }

    // у врага танки — раздать пехоте фаустпатроны
    if (smart && enemyUnits.some(u => UNIT_TYPES[u.typeId].armored)) {
      const b = mine.find(b => !b.antiTank && BUILDING_TYPES[b.typeId].antiTank && BUILDING_TYPES[b.typeId].antiTank!.cost <= p.gold)
      if (b) { this.buyAntiTank(p.id, b.id); return }
    }

    const options = BUILDINGS_BY_RACE[p.race]
    let pick: string | undefined
    if (!smart) {
      // лёгкий: что по карману, наугад
      const cheap = options.filter(id => BUILDING_TYPES[id].cost <= p.gold)
      pick = cheap[Math.floor(Math.random() * cheap.length)]
    } else {
      // ответ на армию противника
      const count = (pred: (u: Unit) => boolean) => enemyUnits.filter(pred).length
      const flyers = count(u => !!UNIT_TYPES[u.typeId].flying)
      const tanks = count(u => !!UNIT_TYPES[u.typeId].armored)
      const infantry = count(u => ROLE[u.typeId] === 'melee' || ROLE[u.typeId] === 'ranged')
      const have = (r: Role) => mine.filter(b => roleOf(b.typeId) === r).length
      const need: Role[] = []
      if (flyers >= 3 && have('ranged') + have('tower') + have('aa') * 2 < 2 + Math.floor(flyers / 3)) need.push('aa', 'ranged', 'tower')
      // экономика: 1–3 рынка, пока они окупаются (первые — быстрее всего), и не в разгар раунда
      const markets = have('eco')
      if (mine.length >= 3 && markets < Math.min(3, 1 + Math.floor(mine.length / 6)) && s.tick < 20 * 150) need.unshift('eco')
      // большая база — одна ПВО от ракет
      if (mine.length >= 10 && have('aa') === 0) need.push('aa')
      if (tanks >= 2 && have('tank') < Math.ceil(tanks / 2)) need.push('tank')
      if (infantry >= 12 && have('artillery') < 1 + Math.floor(infantry / 15)) need.push('artillery')
      if (need.length === 0) {
        // иначе — к целевому составу: роль, которой меньше всего относительно цели
        const total = Math.max(1, mine.length)
        const gaps = (Object.keys(TARGET_MIX) as Role[])
          .map(r => ({ r, gap: TARGET_MIX[r] - have(r) / total }))
          .sort((a, b) => b.gap - a.gap)
        need.push(...gaps.map(g => g.r))
      }
      // первые здания — дешёвая пехота и стрелки, чтобы не остаться без армии
      if (mine.length < 2) need.unshift('melee', 'ranged')
      const wanted = need.map(r => options.find(id => roleOf(id) === r)).filter((x): x is string => !!x)
      const first = wanted[0]
      if (first && BUILDING_TYPES[first].cost <= p.gold) pick = first
      else if (first && level === 'hard' && BUILDING_TYPES[first].cost <= p.gold + 120) return // копит на нужное
      else pick = wanted.find(id => BUILDING_TYPES[id].cost <= p.gold)
      // сначала расширяемся (каждое здание — ещё и доход); улучшаем, когда база большая и золото лишнее
      if (mine.length >= 8 && p.gold > 450 && Math.random() < 0.35) {
        const up = mine
          .filter(b => b.level < MAX_LEVEL && upgradeCost(BUILDING_TYPES[b.typeId].cost, b.level) <= p.gold - 150)
          .sort((a, b) => BUILDING_TYPES[b.typeId].cost - BUILDING_TYPES[a.typeId].cost)[0]
        if (up) { this.upgradeBuilding(p.id, up.id); return }
      }
    }
    if (!pick) return

    // куда ставить: на линию, где враг давит сильнее (у башни — ближе к фронту)
    const z = BASE_ZONE[p.team]
    let lane = Math.floor(Math.random() * 3)
    if (smart) {
      const pressure = [0, 0, 0]
      for (const u of enemyUnits) if (!UNIT_TYPES[u.typeId].flying) pressure[u.lane]++
      const max = Math.max(...pressure)
      if (max > 0 && Math.random() < 0.7) lane = pressure.indexOf(max)
    }
    // из нескольких свободных мест — лучшее: на нужной линии, ближе к фронту и подальше от своих зданий
    // (разбросанную базу одна ракета или суперудар не накроет)
    const third = (z.y1 - z.y0) / 3
    let best: { x: number; y: number; score: number } | null = null
    for (let i = 0; i < 40; i++) {
      const t = Math.random() ** (BUILDING_TYPES[pick].tower ? 0.4 : 0.7)
      const x = p.team === 'west' ? z.x0 + (z.x1 - z.x0) * t : z.x1 - (z.x1 - z.x0) * t
      const y = i < 25 ? z.y0 + third * (lane + Math.random()) : z.y0 + Math.random() * (z.y1 - z.y0)
      if (!canPlace(p.team, x, y, s.buildings).ok) continue
      if (!smart) { this.placeBuilding(p.id, pick, x, y); return }
      const spread = Math.min(260, ...mine.map(b => dist(b, { x, y })))
      const onLane = Math.floor((y - z.y0) / third) === lane ? 120 : 0
      const score = spread + onLane + t * 80
      if (!best || score > best.score) best = { x, y, score }
    }
    if (best) this.placeBuilding(p.id, pick, best.x, best.y)
  }

  /** Метка союзникам — только своей команде, не чаще раза в секунду. */
  private pingAt = new Map<string, number>()
  private ping(playerId: string, x: number, y: number, kind: 'attack' | 'help') {
    const p = this.state.players.find(p => p.id === playerId)
    if (!p || this.state.phase !== 'playing' || !Number.isFinite(x) || !Number.isFinite(y)) return
    const now = Date.now()
    if (now - (this.pingAt.get(playerId) ?? 0) < 1000) return
    this.pingAt.set(playerId, now)
    const msg = JSON.stringify({ type: 'ping', x: Math.round(x), y: Math.round(y), kind, from: p.name } satisfies ServerMsg)
    for (const pl of this.state.players) {
      if (pl.team !== p.team) continue
      const ws = this.sockets.get(pl.id)
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg)
    }
  }

  /** Чат комнаты: всем в комнате, и в лобби, и в партии. */
  chat(playerId: string, text: string) {
    const p = this.state.players.find(p => p.id === playerId)
    if (!p) return
    const line: ChatLine = { from: p.name, team: p.team, text, at: Date.now() }
    this.chatLines.push(line)
    if (this.chatLines.length > 50) this.chatLines.shift()
    const msg = JSON.stringify({ type: 'chat', scope: 'room', lines: [line] } satisfies ServerMsg)
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(msg)
  }

  // ── Сообщения ─────────────────────────────────────────────────────────────

  send(playerId: string, msg: ServerMsg) {
    const ws = this.sockets.get(playerId)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** Компактная копия для сети: координаты округлены, лишние знаки не гоняем по сети. */
  private wireState(): GameState {
    const s = this.state
    return {
      ...s,
      units: s.units.map(packUnit) as unknown as Unit[],
      players: s.players.map(p => ({ ...p, gold: Math.floor(p.gold) })),
    }
  }

  broadcastState() {
    const msg = JSON.stringify({ type: 'state', state: this.wireState() } satisfies ServerMsg)
    this.stats.bytes += msg.length * this.sockets.size
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    }
  }
}
