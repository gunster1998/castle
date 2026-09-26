import { WebSocket } from 'ws'
import type {
  GameState, PlayerState, Unit, Building, Team, Race, BotLevel, RoomInfo, ServerMsg,
} from './types'
import { TEAM_MAX } from './types'
import {
  UNIT_TYPES, BUILDING_TYPES, BUILDINGS_BY_RACE,
  CASTLE_HP, CASTLE_WEST, CASTLE_EAST,
  INCOME_INTERVAL, STARTING_GOLD, BASE_INCOME, BUILDING_INCOME_RATE,
} from './data'
import { canPlace, BASE_ZONE } from './placement'
import { MAX_LEVEL, upgradeCost, unitMult, spawnMult, buildingHpMult } from './upgrades'

let _uid = 1
const uid = () => String(_uid++)

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

const TICK_MS = 50            // 20 тиков в секунду
const MAX_ROUNDS = 3
const ROUND_END_TICKS = 120   // 6 секунд до следующего раунда
const BOT_THINK: Record<BotLevel, number> = { easy: 110, normal: 60, hard: 28 }

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
  private sockets = new Map<string, WebSocket>()   // только живые игроки, у ботов сокета нет
  private state: GameState
  private interval: ReturnType<typeof setInterval> | null = null

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
      roundEndTimer: 0,
    }
  }

  // ── Состав ────────────────────────────────────────────────────────────────

  get humanCount() { return this.sockets.size }
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

  addPlayer(id: string, ws: WebSocket, name: string, race: Race, prefer?: Team): Team | null {
    if (this.state.phase !== 'lobby') return null
    const team = this.freeTeam(prefer)
    if (!team) return null
    this.sockets.set(id, ws)
    this.state.players.push({ id, name, team, race, gold: 0, lumber: 0, ready: false, connected: true })
    this.send(id, { type: 'room', roomId: this.id, team })
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
      id: `bot-${uid()}`, name: `${names[level]} ${n}`, team, race, gold: 0, lumber: 0, ready: true, connected: true, bot: level,
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

  /** Игрок вышел. Возвращает true, если в комнате не осталось живых игроков. */
  removePlayer(id: string): boolean {
    const leaving = this.state.players.find(p => p.id === id)
    this.sockets.delete(id)
    this.state.players = this.state.players.filter(p => p.id !== id)
    if (this.sockets.size === 0) {
      this.stop()
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
      const keep = s.players
      this.state = this.makeInitialState()
      this.state.players = keep.map(pl => ({ ...pl, ready: !!pl.bot, gold: 0, lumber: 0 }))
      this.state.players.find(pl => pl.id === id)!.ready = true
      this.broadcastState()
      this.tryStart()
      this.hooks.changed()
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
      case 'add_bot': return this.addBot(Math.random() < 0.5 ? 'human' : 'undead', (['easy', 'normal', 'hard'].includes(msg.level as string) ? msg.level : 'normal') as BotLevel, msg.team === 'east' ? 'east' : 'west')
      case 'remove_bot': return this.removeBot(String(msg.botId))
      case 'place_building': return this.placeBuilding(playerId, String(msg.buildingTypeId), Number(msg.x), Number(msg.y))
      case 'upgrade_building': return this.upgradeBuilding(playerId, String(msg.buildingId))
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

  private tick() {
    const s = this.state

    if (s.phase === 'round_end') {
      s.roundEndTimer--
      if (s.roundEndTimer <= 0) {
        const needed = Math.ceil(s.maxRounds / 2)
        if (s.wins.west >= needed || s.wins.east >= needed) {
          s.phase = 'game_end'
          this.stop()
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
    for (const unit of s.units) {
      if (dead.has(unit.id)) continue
      const utype = UNIT_TYPES[unit.typeId]
      const mult = unitMult(unit.level)
      // Жрец лечит раненых союзников (список союзников нужен только ему)
      if (unit.typeId === 'priest' && unit.attackCooldown === 0) {
        const healTarget = s.units
          .filter(u => u.team === unit.team && u.id !== unit.id && !dead.has(u.id))
          .filter(a => a.hp < a.maxHp && dist(unit, a) <= utype.range)
          .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0]
        if (healTarget) {
          healTarget.hp = Math.min(healTarget.maxHp, healTarget.hp + Math.round(25 * mult))
          unit.attackCooldown = utype.attackInterval
        }
      }

      // Ближайший вражеский юнит; здания не атакуются
      let target: Unit | null = null
      let best = Infinity
      for (const e of s.units) {
        if (e.team === unit.team || dead.has(e.id)) continue
        const d = dist(unit, e)
        if (d < best) { best = d; target = e }
      }

      if (target) {
        if (best <= utype.range) {
          if (unit.attackCooldown === 0) {
            target.hp -= Math.round(utype.damage * mult)
            unit.attackCooldown = utype.attackInterval
            if (target.hp <= 0) dead.add(target.id)
          }
        } else {
          this.moveToward(unit, target, utype.speed)
        }
      } else {
        const castlePos = unit.team === 'west' ? CASTLE_EAST : CASTLE_WEST
        if (dist(unit, castlePos) < 80) {
          const castle = unit.team === 'west' ? s.castles.east : s.castles.west
          castle.hp -= Math.round(utype.damage * mult * 2)
          dead.add(unit.id)
        } else {
          this.moveToward(unit, castlePos, utype.speed)
        }
      }
    }
    s.units = s.units.filter(u => !dead.has(u.id))

    for (const b of s.buildings) {
      b.spawnTimer--
      if (b.spawnTimer <= 0) {
        this.spawnFromBuilding(b)
        b.spawnTimer = Math.round(BUILDING_TYPES[b.typeId].spawnInterval * spawnMult(b.level))
      }
    }

    if (s.tick % INCOME_INTERVAL === 0) {
      for (const p of s.players) {
        p.gold += BASE_INCOME
        for (const b of s.buildings.filter(b => b.ownerId === p.id)) {
          p.gold += Math.floor(BUILDING_TYPES[b.typeId].cost * BUILDING_INCOME_RATE)
        }
      }
    }

    for (const p of s.players) if (p.bot) this.botThink(p)

    if (s.castles.west.hp <= 0) { this.endRound('east'); return }
    if (s.castles.east.hp <= 0) { this.endRound('west'); return }

    this.broadcastState()
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
    const side = b.team === 'west' ? 1 : -1
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
    })
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
    b.level++
    const newMax = Math.round(btype.hp * buildingHpMult(b.level))
    b.hp += newMax - b.maxHp
    b.maxHp = newMax
    this.broadcastState()
    return true
  }

  /** Бот: раз в несколько секунд строит здание, если хватает золота. */
  private botThink(p: PlayerState) {
    const level = p.bot!
    if (this.state.tick % BOT_THINK[level] !== 0) return
    // улучшение: обычный и сложный бот вкладываются в уже построенное
    const own = this.state.buildings.filter(b => b.ownerId === p.id && b.level < MAX_LEVEL)
    const upgradable = own.filter(b => upgradeCost(BUILDING_TYPES[b.typeId].cost, b.level) <= p.gold)
    if (upgradable.length && level !== 'easy' && own.length >= 3 && Math.random() < (level === 'hard' ? 0.5 : 0.3)) {
      this.upgradeBuilding(p.id, upgradable[Math.floor(Math.random() * upgradable.length)].id)
      return
    }
    const options = BUILDINGS_BY_RACE[p.race].filter(id => BUILDING_TYPES[id].cost <= p.gold)
    if (!options.length) return
    // сложный бот копит на дорогие здания, лёгкий хватает что попало
    const pick = level === 'hard'
      ? options.sort((a, b) => BUILDING_TYPES[b].cost - BUILDING_TYPES[a].cost)[Math.random() < 0.6 ? 0 : Math.floor(Math.random() * options.length)]
      : options[Math.floor(Math.random() * options.length)]
    const z = BASE_ZONE[p.team]
    for (let i = 0; i < 40; i++) {
      // ближе к линии боя — плотнее
      const t = Math.random() ** 0.7
      const x = p.team === 'west' ? z.x0 + (z.x1 - z.x0) * t : z.x1 - (z.x1 - z.x0) * t
      const y = z.y0 + Math.random() * (z.y1 - z.y0)
      if (canPlace(p.team, x, y, this.state.buildings).ok) {
        this.placeBuilding(p.id, pick, x, y)
        return
      }
    }
  }

  // ── Сообщения ─────────────────────────────────────────────────────────────

  send(playerId: string, msg: ServerMsg) {
    const ws = this.sockets.get(playerId)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** Компактная копия для сети: координаты округлены, лишние знаки не гоняем по сети. */
  private wireState(): GameState {
    const s = this.state
    const r1 = (n: number) => Math.round(n * 10) / 10
    return {
      ...s,
      units: s.units.map(u => ({ ...u, x: r1(u.x), y: r1(u.y), hp: Math.round(u.hp) })),
      players: s.players.map(p => ({ ...p, gold: Math.floor(p.gold) })),
    }
  }

  broadcastState() {
    const msg = JSON.stringify({ type: 'state', state: this.wireState() } satisfies ServerMsg)
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    }
  }
}
