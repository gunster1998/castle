import { GameWS } from './ws'
import { render, initRenderer, updateEffects, unproject, resetScene, setSelectedBuilding, pickBuilding, showPing } from './renderer'
import type { GameState, ServerMsg, Team, Race, RoomInfo, BotLevel, TeamSize } from './types'
import { TEAM_MAX } from './types'
import { BUILDINGS_BY_RACE, BUILDING_TYPES, UNIT_TYPES, ANTITANK_RANGE, PRIEST_HEAL } from './data'
import { MAX_LEVEL, upgradeCost, unitMult, spawnMult, buildingHpMult, marketMult, marketDecay } from './upgrades'
import { canPlace } from './placement'
import { canStrike, canNuke, AURA, NUKE_PRICE, NUKE_MAX, MILITIA } from './strike'
import { LANE_NAMES, laneFor } from './lanes'
import { startTelemetry } from './telemetry'
import { initChat, onChat, clearRoomChat } from './chat'
import { initStats, updateStats } from './stats'
import { notifyDiff, note } from './notify'
import { initSound, sfx, isMuted, setMuted } from './sound'

// ── Состояние ────────────────────────────────────────────────────────────────

let myId = ''
let myTeam: Team = 'west'
let roomId: string | null = null
let searching = false
let searchStart = 0
let gameState: GameState | null = null
let selectedBuilding: string | null = null
/** Сколько после конца матча до возвращения в комнату (как на сервере). */
const BACK_TO_ROOM_MS = 10_000
let gameEndAt = 0
/** Выбираем место: суперудар или ядерная ракета. */
let aiming: false | 'strike' | 'nuke' = false
let hover: { x: number; y: number } | null = null
let selectedBid: string | null = null
let infoAt = 0
let stateAt = 0
let race: Race = 'human'
let size: TeamSize = 1
let searchSize: TeamSize = 1

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const menuEl = $('menu'), searchEl = $('search'), roomEl = $('room'), gameEl = $('game')
const canvas = $<HTMLCanvasElement>('canvas')
const nameInput = $<HTMLInputElement>('name-input')
const roomNameInput = $<HTMLInputElement>('room-name')
const botLevel = $<HTMLSelectElement>('bot-level')
const roomList = $('room-list')
const readyBtn = $<HTMLButtonElement>('ready-btn')
const rematchBtn = $<HTMLButtonElement>('rematch-btn')
const buildMenu = $('build-menu')
const strikeBtn = $<HTMLButtonElement>('strike-btn')
const nukeBtn = $<HTMLButtonElement>('nuke-btn')
const counterBtn = $<HTMLButtonElement>('counter-btn')
const militiaBtn = $<HTMLButtonElement>('militia-btn')
militiaBtn.addEventListener('click', () => ws.send({ type: 'militia' }))
/** Летящая вражеская ракета, которую ещё можно сбить. */
function incomingNuke() {
  if (!gameState || gameState.phase !== 'playing') return undefined
  return (gameState.strikes ?? []).find(st => st.nuke && st.team !== myTeam && st.interceptAt === undefined
    && st.killed === undefined && st.hitTick - gameState!.tick >= 16)
}
function counterNuke() {
  const st = incomingNuke()
  if (st) ws.send({ type: 'counter_nuke', strikeId: st.id })
}
counterBtn.addEventListener('click', () => counterNuke())
const hudEl = $('hud')
const tipEl = $('tip')
const toastEl = $('toast')

function safeGet(k: string) { try { return localStorage.getItem(k) } catch { return null } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* приватный режим */ } }
nameInput.value = safeGet('cf.name') || `Игрок${Math.floor(Math.random() * 900 + 100)}`
race = (['human', 'undead', 'orc'] as Race[]).find(r => r === safeGet('cf.race')) ?? 'human'
size = ([1, 2, 4] as TeamSize[]).find(n => String(n) === safeGet('cf.size')) ?? 1

// ── Сеть ─────────────────────────────────────────────────────────────────────

const proto = location.protocol === 'https:' ? 'wss' : 'ws'
const WS_URL = import.meta.env.VITE_WS_URL ?? (import.meta.env.DEV ? 'ws://localhost:3001' : `${proto}://${location.host}/ws`)
// запасной HTTP-канал идёт на тот же сервер
const HTTP_BASE = import.meta.env.DEV ? 'http://localhost:3001' : ''
const ws = new GameWS(WS_URL, HTTP_BASE)

/** Ключ вкладки: переживает обновление страницы (sessionStorage), в новой вкладке — свой. */
let session = (() => {
  try {
    let k = sessionStorage.getItem('cf.session')
    if (!k) {
      k = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem('cf.session', k)
    }
    return k
  } catch {
    return undefined
  }
})()

/**
 * Сервер обновился, а вкладка работает на старом коде (при переподключении страница не перезагружается) —
 * перезагрузить: ключ вкладки сохранится, и игрок вернётся в свою партию уже с новым кодом.
 */
function staleBuild(build: string | undefined): boolean {
  if (import.meta.env.DEV || !build) return false
  const mine = new URL(import.meta.url).pathname.split('/').pop()
  if (!mine || mine === build) return false
  try {
    const last = Number(sessionStorage.getItem('cf.reloadAt'))
    if (Date.now() - last < 60_000) return false  // уже перезагружались — не зацикливаться
    sessionStorage.setItem('cf.reloadAt', String(Date.now()))
  } catch { return false }
  console.warn('Вышла новая версия игры — перезагружаем', mine, '→', build)
  location.reload()
  return true
}

/** Начало раунда, конец матча — музыкальные заставки. */
function phaseSounds(prev: GameState | null, next: GameState) {
  if (!prev || prev.roomId !== next.roomId || prev.phase === next.phase) return
  if (next.phase === 'playing') sfx('start')
  if (next.phase === 'game_end') {
    const { west, east } = next.wins
    const mine = myTeam === 'west' ? west : east, theirs = myTeam === 'west' ? east : west
    sfx(mine >= theirs ? 'win' : 'lose')
  }
}

function hello() {
  ws.send({ type: 'hello', name: nameInput.value.trim() || 'Игрок', race, session })
}

ws.onMessage((msg: ServerMsg) => {
  switch (msg.type) {
    case 'init':
      everConnected = true
      if (staleBuild(msg.build)) return
      myId = msg.playerId
      // после переподключения старой комнаты уже нет
      roomId = null; searching = false; gameState = null
      hello()
      break
    case 'lobby':
      $('online').textContent = String(msg.online)
      $('searching').textContent = String(msg.searching)
      renderRooms(msg.rooms)
      break
    case 'queue':
      searching = msg.searching
      if (searching) {
        searchStart = Date.now()
        searchSize = msg.size ?? size
        $('search-hint').textContent = searchSize === 1
          ? 'Как только ещё кто-то нажмёт «Найти соперника» в формате 1 × 1, игра начнётся.'
          : `Формат ${searchSize} × ${searchSize}: игра начнётся, когда наберётся ${searchSize * 2} игроков.`
      }
      break
    case 'room':
      if (msg.roomId !== roomId) resetScene()
      roomId = msg.roomId
      if (msg.team) myTeam = msg.team
      if (!roomId) { gameState = null; selectedBuilding = null; aiming = false; selectBid(null); clearRoomChat() }
      break
    case 'ping':
      showPing(msg.x, msg.y, msg.kind)
      note(`${msg.from}: ${msg.kind === 'attack' ? '⚔ атакуем здесь!' : '🆘 нужна помощь!'}`, msg.kind === 'attack' ? 'warn' : 'danger')
      return
    case 'chat':
      onChat(msg)
      if (!msg.reset) sfx('chat')
      return
    case 'state':
      if (msg.state.roomId !== roomId) break
      if (msg.state.phase === 'playing') updateEffects(msg.state)
      phaseSounds(gameState, msg.state)
      notifyDiff(gameState, msg.state, myTeam)
      if (msg.state.phase === 'game_end' && gameState?.phase !== 'game_end') gameEndAt = Date.now()
      // матч окончен, комната снова в сборе: сцену — с чистого листа
      if (msg.state.phase === 'lobby' && gameState && gameState.phase !== 'lobby') resetScene()
      gameState = msg.state
      stateAt = performance.now()
      break
    case 'error':
      if (msg.message.includes('другой вкладке')) {
        // эта вкладка уступила место — не переподключаемся, иначе вкладки будут отбирать игру друг у друга
        ws.disconnect()
        roomId = null; gameState = null; searching = false
        show('menu')
        roomList.innerHTML = '<div class="empty">Игра открыта в другой вкладке. Обновите эту страницу, чтобы играть здесь.</div>'
        toast(msg.message)
        return
      }
      sfx('error')
      if (gameState?.phase === 'playing') showTip(msg.message, '#ff6b5e')
      else toast(msg.message)
      break
  }
  updateUI()
})
// WebSocket не открывается — предупредить; запасной режим игрок включает сам
const netWarn = $('net-warn')
ws.onStuck = () => { netWarn.hidden = false }
ws.onTransport = t => {
  $('poll-badge').hidden = t !== 'poll'
  if (t === 'poll') netWarn.hidden = true
}
$('net-warn-poll').addEventListener('click', () => { netWarn.hidden = true; ws.usePoll() })
$('net-warn-close').addEventListener('click', () => { netWarn.hidden = true })
ws.connect()
let everConnected = false

// ── Меню ─────────────────────────────────────────────────────────────────────

function setRace(r: Race) {
  race = r
  safeSet('cf.race', r)
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-race]')) b.setAttribute('aria-pressed', String(b.dataset.race === r))
  hello()
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-race]')) b.addEventListener('click', () => setRace(b.dataset.race as Race))
setRace(race)

nameInput.addEventListener('change', () => { safeSet('cf.name', nameInput.value.trim()); hello() })
function setSize(n: TeamSize) {
  size = n
  safeSet('cf.size', String(n))
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-size]')) b.setAttribute('aria-pressed', String(b.dataset.size === String(n)))
  $('bot-btn').textContent = n === 1 ? 'Играть с ботом' : `Играть ${n}×${n} с ботами`
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-size]')) b.addEventListener('click', () => setSize(Number(b.dataset.size) as TeamSize))
setSize(size)
$('quick-btn').addEventListener('click', () => { hello(); ws.send({ type: 'quick_match', race, size }) })
$('cancel-search').addEventListener('click', () => ws.send({ type: 'cancel_queue' }))
$('bot-btn').addEventListener('click', () => { hello(); ws.send({ type: 'play_bot', race, level: botLevel.value as BotLevel, size }) })
$('create-btn').addEventListener('click', () => {
  hello()
  ws.send({ type: 'create_room', name: roomNameInput.value.trim() || `Комната ${nameInput.value.trim()}`, race })
})

function renderRooms(rooms: RoomInfo[]) {
  const open = rooms.filter(r => r.open)
  const busy = rooms.filter(r => !r.open && r.phase !== 'lobby')
  roomList.innerHTML = ''
  if (!open.length) {
    const d = document.createElement('div')
    d.className = 'empty'
    d.textContent = busy.length
      ? `Свободных комнат нет, идёт игр: ${busy.length}. Создайте свою или нажмите «Найти соперника».`
      : 'Свободных комнат нет. Создайте свою или нажмите «Найти соперника».'
    roomList.appendChild(d)
  }
  for (const r of open) {
    const row = document.createElement('div')
    row.className = 'room'
    const host = r.players[0]
    const w = r.players.filter(p => p.team === 'west').length, e = r.players.filter(p => p.team === 'east').length
    row.innerHTML = `<div class="info"><div class="name"></div><div class="who"></div></div>`
    row.querySelector('.name')!.textContent = r.name
    row.querySelector('.who')!.textContent = host
      ? `${r.players.length}/${r.maxPlayers} · Запад ${w}, Восток ${e} · создал ${host.name}`
      : 'пустая'
    const btn = document.createElement('button')
    btn.className = 'btn'
    btn.textContent = 'Войти'
    btn.addEventListener('click', () => { hello(); ws.send({ type: 'join_room', roomId: r.id, race }) })
    row.appendChild(btn)
    roomList.appendChild(row)
  }
}

const raceName = (r: Race) => (r === 'human' ? 'Люди' : 'Нежить')

// ── Комната ──────────────────────────────────────────────────────────────────

readyBtn.addEventListener('click', () => { ws.send({ type: 'ready' }); sfx('ok') })
$('leave-room-btn').addEventListener('click', () => { forgetMatch(); ws.send({ type: 'leave_room' }) })
$('leave-game-btn').addEventListener('click', () => { forgetMatch(); ws.send({ type: 'leave_room' }) })

// ── Возвращение в партию ─────────────────────────────────────────────────────
// Ключ вкладки живёт, пока вкладка открыта. Чтобы вернуться после закрытия вкладки или браузера,
// последняя партия запоминается в localStorage, а в меню появляется кнопка «Вернуться».
interface LastMatch { session: string; roomName: string; at: number }
const MATCH_KEY = 'cf.lastMatch'
const MATCH_TTL = 15 * 60_000
let matchSavedAt = 0
function rememberMatch() {
  if (!session || !gameState || !roomId) return
  const now = Date.now()
  if (now - matchSavedAt < 5000) return
  matchSavedAt = now
  safeSet(MATCH_KEY, JSON.stringify({ session, roomName: gameState.roomName, at: now } satisfies LastMatch))
}
function forgetMatch() { try { localStorage.removeItem(MATCH_KEY) } catch { /* приватный режим */ } }
function lastMatch(): LastMatch | null {
  try {
    const m = JSON.parse(safeGet(MATCH_KEY) || 'null') as LastMatch | null
    return m && m.session !== session && Date.now() - m.at < MATCH_TTL ? m : null
  } catch { return null }
}
const rejoinBtn = $<HTMLButtonElement>('rejoin-btn')
function showRejoin() {
  const m = roomId ? null : lastMatch()
  rejoinBtn.hidden = !m
  if (m) rejoinBtn.textContent = `↩ Вернуться в партию «${m.roomName}»`
}
rejoinBtn.addEventListener('click', () => {
  const m = lastMatch()
  if (!m) { showRejoin(); return }
  // берём ключ той вкладки: сервер узнает игрока и вернёт его на место
  session = m.session
  try { sessionStorage.setItem('cf.session', m.session) } catch { /* приватный режим */ }
  hello()
  // партии уже нет (закончилась или сервер перезапускался) — кнопку убрать
  setTimeout(() => {
    if (roomId) return
    forgetMatch()
    showRejoin()
    toast('Эта партия уже закончилась')
  }, 3000)
})

// плашка «нет связи» поверх игры
const netEl = $('net-status')
let offlineSince = 0
setInterval(() => {
  const down = !ws.connected && !!roomId
  if (down && !offlineSince) offlineSince = Date.now()
  if (!down) offlineSince = 0
  netEl.hidden = !(down && Date.now() - offlineSince > 1500)
}, 500)
rematchBtn.addEventListener('click', () => ws.send({ type: 'ready' }))
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-room-race]')) {
  b.addEventListener('click', () => {
    setRace(b.dataset.roomRace as Race)
    ws.send({ type: 'set_race', race })
  })
}

const roomBotLevel = $<HTMLSelectElement>('room-bot-level')

function renderTeam(team: Team) {
  const el = $(`team-${team}`)
  const players = gameState?.players.filter(p => p.team === team) ?? []
  const me = gameState?.players.find(p => p.id === myId)
  el.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'team-head'
  head.innerHTML = `<b>${team === 'west' ? 'Запад' : 'Восток'} · ${players.length}/${TEAM_MAX}</b>`
  if (me && me.team !== team && players.length < TEAM_MAX) {
    const move = document.createElement('button')
    move.className = 'mini'
    move.textContent = 'Перейти сюда'
    move.addEventListener('click', () => ws.send({ type: 'switch_team', team }))
    head.appendChild(move)
  }
  el.appendChild(head)
  for (const p of players) {
    const row = document.createElement('div')
    row.className = 'pslot' + (p.id === myId ? ' me' : '')
    row.innerHTML = '<div class="pn"><b></b><span></span></div><span class="rdy"></span>'
    row.querySelector('b')!.textContent = p.name + (p.id === myId ? ' (вы)' : '')
    row.querySelector('.pn span')!.textContent = raceName(p.race) + (p.connected ? '' : ' · нет связи')
    const r = row.querySelector<HTMLElement>('.rdy')!
    r.textContent = p.ready ? '✓ готов' : 'не готов'
    r.style.color = p.ready ? 'var(--ok)' : 'var(--muted)'
    if (p.bot) {
      const x = document.createElement('button')
      x.className = 'mini'
      x.textContent = 'убрать'
      x.addEventListener('click', () => ws.send({ type: 'remove_bot', botId: p.id }))
      row.appendChild(x)
    }
    el.appendChild(row)
  }
  for (let i = players.length; i < TEAM_MAX; i++) {
    const row = document.createElement('div')
    row.className = 'pslot free'
    row.innerHTML = '<div class="pn">свободно</div>'
    const add = document.createElement('button')
    add.className = 'mini'
    add.textContent = '+ бот'
    add.addEventListener('click', () => ws.send({ type: 'add_bot', team, level: roomBotLevel.value as BotLevel }))
    row.appendChild(add)
    el.appendChild(row)
  }
}

// ── Экраны ───────────────────────────────────────────────────────────────────

function show(screen: 'menu' | 'search' | 'room' | 'game') {
  menuEl.hidden = screen !== 'menu'
  searchEl.hidden = screen !== 'search'
  roomEl.hidden = screen !== 'room'
  gameEl.style.display = screen === 'game' ? 'flex' : 'none'
}

function updateUI() {
  if (roomId) rememberMatch()
  showRejoin()
  renderCastle()
  updateStats(roomId && gameState?.phase !== 'lobby' ? gameState : null, myId, myTeam)
  if (!roomId) {
    show(searching ? 'search' : 'menu')
    return
  }
  if (!gameState) return
  const phase = gameState.phase
  const me = gameState.players.find(p => p.id === myId)
  if (phase !== 'playing' && selectedBid) selectBid(null)
  if (phase === 'lobby') {
    show('room')
    $('room-title').textContent = gameState.roomName
    renderTeam('west'); renderTeam('east')
    readyBtn.disabled = !!me?.ready
    readyBtn.textContent = me?.ready ? 'Ждём соперника…' : 'Готов'
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-room-race]')) b.setAttribute('aria-pressed', String(b.dataset.roomRace === me?.race))
    return
  }
  show('game')
  // чат партии — над нижней панелью, какой бы высоты она ни была
  document.documentElement.style.setProperty('--hud-h', `${hudEl.offsetHeight}px`)
  if (me) $('gold').textContent = String(me.gold)

  if (phase === 'playing' && me) {
    buildMenu.style.display = 'flex'
    const btypes = BUILDINGS_BY_RACE[me.race]
    if (buildMenu.dataset.race !== me.race) {
      buildMenu.dataset.race = me.race
      buildMenu.innerHTML = ''
      btypes.forEach((bid, i) => {
        const btype = BUILDING_TYPES[bid]
        const btn = document.createElement('button')
        btn.className = 'build-btn'
        btn.dataset.id = bid
        btn.title = `Горячая клавиша: ${(i + 1) % 10}`
        btn.innerHTML = `<span class="bname">${(i + 1) % 10}. ${btype.name}</span><span class="bcost">🪙${btype.cost}</span><span class="bdesc">${btype.description}</span>`
        btn.addEventListener('click', () => selectBuilding(bid))
        buildMenu.appendChild(btn)
      })
    }
    for (const btn of buildMenu.querySelectorAll<HTMLButtonElement>('.build-btn')) {
      btn.classList.toggle('selected', btn.dataset.id === selectedBuilding)
      btn.classList.toggle('cant-afford', me.gold < BUILDING_TYPES[btn.dataset.id!].cost)
    }
    rematchBtn.hidden = true
    strikeBtn.hidden = false
    strikeBtn.disabled = me.strikeUsed
    nukeBtn.hidden = false
    nukeBtn.disabled = me.nukes <= 0
    counterBtn.hidden = !incomingNuke() || me.nukes <= 0
    const myCastle = gameState.castles[me.team]
    militiaBtn.hidden = !!me.militiaUsed || myCastle.hp > myCastle.maxHp * MILITIA.below
    if ((me.strikeUsed && aiming === 'strike') || (me.nukes <= 0 && aiming === 'nuke')) aiming = false
    strikeBtn.classList.toggle('aiming', aiming === 'strike')
    nukeBtn.classList.toggle('aiming', aiming === 'nuke')
    $('strike-note').textContent = me.strikeUsed ? 'уже использован' : aiming === 'strike' ? 'выберите место…' : '1 раз за раунд'
    $('nuke-note').textContent = aiming === 'nuke' ? 'выберите цель…' : me.nukes > 0 ? `в запасе: ${me.nukes}` : `купить в замке 🪙${NUKE_PRICE}`
    renderCastle()
  } else {
    buildMenu.style.display = 'none'
    strikeBtn.hidden = true
    nukeBtn.hidden = true
    counterBtn.hidden = true
    militiaBtn.hidden = true
    aiming = false
    selectedBuilding = null
    rematchBtn.hidden = phase !== 'game_end'
    if (phase === 'game_end') {
      const left = Math.max(0, Math.ceil((BACK_TO_ROOM_MS - (Date.now() - gameEndAt)) / 1000))
      showTip(`${gameState.notice ? gameState.notice + '. ' : 'Матч окончен. '}Через ${left} с — снова в комнату с теми же игроками.`, '#f2c14e')
    } else if (phase === 'round_end') {
      showTip('Следующий раунд скоро начнётся…', '#cccccc')
    }
  }
}

function selectBuilding(id: string) {
  const me = gameState?.players.find(p => p.id === myId)
  if (!me) return
  if (me.gold < BUILDING_TYPES[id].cost) { showTip('Недостаточно золота!', '#ff8800'); return }
  selectedBuilding = selectedBuilding === id ? null : id
  aiming = false
  showTip(selectedBuilding
    ? BUILDING_TYPES[id].tower
      ? `Кликните на своей базе: ${BUILDING_TYPES[id].name}. Круг — докуда она стреляет. Esc — отмена.`
      : `Кликните на своей базе: ${BUILDING_TYPES[id].name}. Верх базы — воины пойдут верхней линией, низ — нижней, середина — центральной. Shift — ещё. Esc — отмена.`
    : '', '#ffffff')
  updateUI()
}

function toggleAim(kind: 'strike' | 'nuke' = 'strike') {
  const me = gameState?.players.find(p => p.id === myId)
  if (!me || gameState?.phase !== 'playing') return
  if (kind === 'strike' && me.strikeUsed) { showTip('Суперудар уже использован в этом раунде', '#ff8800'); return }
  if (kind === 'nuke' && me.nukes <= 0) { showTip(`Ракет нет — купите в замке за ${NUKE_PRICE} золота (кнопка «🏰 Замок» или C)`, '#ff8800'); return }
  aiming = aiming === kind ? false : kind
  if (aiming) { selectedBuilding = null; selectBid(null) }
  showTip(aiming === 'strike' ? 'Суперудар: кликните на своей базе или рядом — все враги в круге погибнут. Один раз за раунд. Esc — отмена.'
    : aiming === 'nuke' ? 'Ядерная ракета: кликните в любую точку поля — по толпе врагов, по зданиям (сносит их) или по замку (−20% прочности). Летит 4 секунды. Один раз за раунд. Esc — отмена.'
    : '', aiming === 'nuke' ? '#ff9a5c' : '#ffd35c')
  updateUI()
}
strikeBtn.addEventListener('click', () => toggleAim('strike'))
nukeBtn.addEventListener('click', () => toggleAim('nuke'))

// ── Замок: ауры на все войска и ракеты ───────────────────────────────────────
const cinfo = $('cinfo')
let castleOpen = false
function toggleCastle(open = !castleOpen) {
  castleOpen = open
  renderCastle()
}
$('castle-btn').addEventListener('click', () => toggleCastle())
$('ci-close').addEventListener('click', () => toggleCastle(false))
$('ci-damage').addEventListener('click', () => ws.send({ type: 'buy_aura', aura: 'damage' }))
$('ci-speed').addEventListener('click', () => ws.send({ type: 'buy_aura', aura: 'speed' }))
$('ci-nuke').addEventListener('click', () => ws.send({ type: 'buy_nuke' }))
function renderCastle() {
  const me = gameState?.players.find(p => p.id === myId)
  const show = castleOpen && !!me && gameState?.phase === 'playing'
  cinfo.hidden = !show
  $('castle-btn').hidden = gameState?.phase !== 'playing'
  if (me && gameState) {
    // на кнопке замка — сколько ещё действуют ауры
    const a = gameState.auras?.[me.team] ?? { damage: 0, speed: 0 }
    const badges = (['damage', 'speed'] as const).map(k => {
      const left = Math.ceil((a[k] - gameState!.tick) / 20)
      return left > 0 ? `${k === 'damage' ? '⚔' : '⚡'}${left}` : ''
    }).filter(Boolean).join(' ')
    $('castle-btn').textContent = badges ? `🏰 Замок ${badges}` : '🏰 Замок'
  }
  if (!show || !me || !gameState) return
  cinfo.className = me.team
  const c = gameState.castles[me.team]
  $('ci-hp').textContent = `${Math.max(0, Math.round(c.hp))} / ${c.maxHp}`
  const auras = gameState.auras?.[me.team] ?? { damage: 0, speed: 0 }
  for (const kind of ['damage', 'speed'] as const) {
    const left = Math.max(0, Math.ceil((auras[kind] - gameState.tick) / 20))
    $(`ci-${kind}-lv`).textContent = left ? `действует ${left} с` : ''
    const btn = $<HTMLButtonElement>(`ci-${kind}`)
    btn.textContent = left ? `+15 с — 🪙${AURA.cost}` : `Включить — 🪙${AURA.cost}`
    btn.disabled = me.gold < AURA.cost || (left * 20 + AURA.duration > AURA.maxAhead)
  }
  $('ci-nukes').textContent = `${me.nukes} из ${NUKE_MAX}`
  const nb = $<HTMLButtonElement>('ci-nuke')
  nb.textContent = `🪙${NUKE_PRICE}`
  nb.disabled = me.nukes >= NUKE_MAX || me.gold < NUKE_PRICE
}

function showTip(msg: string, color = '#ffffff') {
  tipEl.textContent = msg
  tipEl.style.color = color
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function toast(msg: string) {
  toastEl.textContent = msg
  toastEl.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 3500)
}

// поиск: таймер
// конец матча: сервер больше не шлёт состояния — обратный отсчёт до комнаты обновляем сами
setInterval(() => { if (gameState?.phase === 'game_end') updateUI() }, 1000)

setInterval(() => {
  if (!searching) return
  const s = Math.floor((Date.now() - searchStart) / 1000)
  $('search-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}, 250)

// ── Ввод на поле ─────────────────────────────────────────────────────────────

initRenderer(canvas)
initStats()
initSound()
// щелчок на любую кнопку интерфейса
document.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button')
  if (b && !b.disabled) sfx(b.classList.contains('build-btn') || b.classList.contains('strike-btn') ? 'select' : 'click')
}, { capture: true })
const muteBtn = $<HTMLButtonElement>('mute-btn')
const showMute = () => { muteBtn.textContent = isMuted() ? '🔇' : '🔊'; muteBtn.title = isMuted() ? 'Включить звук (M)' : 'Выключить звук (M)' }
muteBtn.addEventListener('click', () => { setMuted(!isMuted()); showMute() })
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code === 'KeyM' && (e.target as HTMLElement).tagName !== 'INPUT') { setMuted(!isMuted()); showMute() }
})
showMute()
initChat(text => ws.send({ type: 'chat', text }), () => gameEl.style.display === 'flex')
addEventListener('resize', () => { if (gameEl.style.display === 'flex') document.documentElement.style.setProperty('--hud-h', `${hudEl.offsetHeight}px`) })
startTelemetry(
  data => ws.send({ type: 'telemetry', data }),
  () => ({ room: roomId, phase: gameState?.phase, players: gameState?.players.length, net: { transport: ws.transport, dropped: ws.droppedStates } }),
)
// отладка/тесты: текущее состояние партии
;(window as unknown as { __castle: Record<string, unknown> }).__castle.state = () => gameState
;(window as unknown as { __castle: Record<string, unknown> }).__castle.net = () => ({ transport: ws.transport, connected: ws.connected, dropped: ws.droppedStates, lastError: ws.lastError })

canvas.addEventListener('mousemove', e => {
  if (!gameState || gameState.phase !== 'playing') { hover = null; return }
  hover = unproject(e.clientX, e.clientY, canvas)
  const now = performance.now()
  if (now - cursorAt > 100) {
    cursorAt = now
    canvas.style.cursor = !selectedBuilding && !aiming && pickBuilding(e.clientX, e.clientY, canvas) ? 'pointer' : 'crosshair'
  }
})
let cursorAt = 0
canvas.addEventListener('mouseleave', () => { hover = null })

function selectBid(id: string | null) {
  selectedBid = id
  setSelectedBuilding(id)
  renderInfo()
}

canvas.addEventListener('click', e => {
  if (!gameState || gameState.phase !== 'playing') return
  const p = unproject(e.clientX, e.clientY, canvas)
  // Alt+клик — метка союзникам (с Shift — «нужна помощь»)
  if (e.altKey) {
    ws.send({ type: 'ping', x: Math.round(p.x), y: Math.round(p.y), kind: e.shiftKey ? 'help' : 'attack' })
    return
  }
  if (aiming) {
    const check = aiming === 'nuke' ? canNuke(p.x, p.y) : canStrike(myTeam, p.x, p.y)
    if (!check.ok) { showTip(check.reason, '#ff6b5e'); return }
    ws.send({ type: aiming === 'nuke' ? 'nuke' : 'super_strike', x: Math.round(p.x), y: Math.round(p.y) })
    aiming = false
    showTip('')
    updateUI()
    return
  }
  if (!selectedBuilding) {
    selectBid(pickBuilding(e.clientX, e.clientY, canvas))
    return
  }
  const check = canPlace(myTeam, p.x, p.y, gameState.buildings)
  if (!check.ok) { showTip(check.reason, '#ff6b5e'); return }
  ws.send({ type: 'place_building', buildingTypeId: selectedBuilding, x: Math.round(p.x), y: Math.round(p.y) })
  // с Shift — строим следующее такое же
  const me = gameState.players.find(pl => pl.id === myId)
  if (!e.shiftKey || !me || me.gold - BUILDING_TYPES[selectedBuilding].cost < BUILDING_TYPES[selectedBuilding].cost) {
    selectedBuilding = null
    showTip('', '#ffffff')
  }
  updateUI()
})

window.addEventListener('keydown', e => {
  if (!gameState || gameState.phase !== 'playing' || (e.target as HTMLElement).tagName === 'INPUT') return
  if (e.key === 'Escape') { selectedBuilding = null; aiming = false; selectBid(null); showTip(''); updateUI(); return }
  if (e.code === 'KeyU') { upgradeSelected(); return }
  if (e.code === 'KeyQ') { toggleAim('strike'); return }
  if (e.code === 'KeyR') { toggleAim('nuke'); return }
  if (e.code === 'KeyX') { counterNuke(); return }
  if (e.code === 'KeyV') { ws.send({ type: 'militia' }); return }
  if (e.code === 'KeyC') { toggleCastle(); return }
  const me = gameState.players.find(p => p.id === myId)
  const idx = e.key === '0' ? 9 : Number(e.key) - 1
  if (me && idx >= 0 && idx < BUILDINGS_BY_RACE[me.race].length) selectBuilding(BUILDINGS_BY_RACE[me.race][idx])
})

// ── Карточка здания ──────────────────────────────────────────────────────────

const binfo = $('binfo')
const upgradeBtn = $<HTMLButtonElement>('bi-upgrade')
$('bi-close').addEventListener('click', () => selectBid(null))
upgradeBtn.addEventListener('click', () => upgradeSelected())
const antiTankBtn = $<HTMLButtonElement>('bi-antitank')
antiTankBtn.addEventListener('click', () => { if (selectedBid) ws.send({ type: 'buy_antitank', buildingId: selectedBid }) })

function upgradeSelected() {
  const b = gameState?.buildings.find(x => x.id === selectedBid)
  if (!b || b.ownerId !== myId) return
  ws.send({ type: 'upgrade_building', buildingId: b.id })
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',')

function renderInfo() {
  const b = gameState && gameState.phase === 'playing' ? gameState.buildings.find(x => x.id === selectedBid) : undefined
  if (!b) {
    binfo.hidden = true
    if (selectedBid && gameState?.phase === 'playing') { selectedBid = null; setSelectedBuilding(null) }
    return
  }
  const bt = BUILDING_TYPES[b.typeId]
  const ut = UNIT_TYPES[bt.unitTypeId]
  const tw = bt.tower
  const mine = b.ownerId === myId
  const owner = gameState!.players.find(p => p.id === b.ownerId)
  binfo.hidden = false
  binfo.className = b.team
  $('bi-name').textContent = bt.name
  $('bi-stars').textContent = '★'.repeat(b.level) + '☆'.repeat(MAX_LEVEL - b.level)
  $('bi-owner').textContent = mine ? 'Ваше здание' : `Здание соперника: ${owner?.name ?? '?'}`
  $('bi-hp').textContent = `${Math.max(0, Math.round(b.hp))} / ${b.maxHp}`
  const hpR = Math.max(0, b.hp / b.maxHp)
  const hpBar = $('bi-hpbar')
  hpBar.style.width = `${hpR * 100}%`
  hpBar.style.background = hpR > 0.6 ? '#46d36a' : hpR > 0.3 ? '#f2c14e' : '#ef5a4a'
  // таймер тикает между обновлениями сервера (20 тиков в секунду)
  const interval = bt.spawnInterval * spawnMult(b.level)
  const left = Math.max(0, b.spawnTimer / 20 - (performance.now() - stateAt) / 1000)
  const mk = bt.income
  // доход рынка: какой он по счёту у владельца (самые прокачанные — первыми), столько и приносит
  const ownMarkets = mk ? gameState!.buildings.filter(x => x.ownerId === b.ownerId && BUILDING_TYPES[x.typeId].income).sort((a, c) => c.level - a.level) : []
  const rank = Math.max(0, ownMarkets.findIndex(x => x.id === b.id))
  const perStep = mk ? mk * marketMult(b.level) * marketDecay(rank) : 0
  $('bi-timer-label').textContent = tw ? 'Перезарядка' : mk ? 'Доход' : 'Следующий воин через'
  $('bi-timer').textContent = mk ? `+${fmt(perStep)} за 2,5 с` : tw && left === 0 ? 'готова' : `${fmt(left)} с`
  $('bi-spawnbar').style.width = mk ? '100%' : `${Math.min(100, (1 - (left * 20) / interval) * 100)}%`

  const lv = b.level, next = Math.min(MAX_LEVEL, lv + 1)
  const canUp = mine && lv < MAX_LEVEL
  const m = unitMult(lv), mn = unitMult(next)
  $('bi-unit-name').textContent = tw ? 'Стрельба башни' : mk ? 'Торговля' : ut.name
  $('bi-unit-level').textContent = `уровень ${lv}`
  const heal = ut?.id === 'priest'
  const dmg = (tw ? tw.damage : ut?.damage ?? 0) * m
  const perSec = 20 / (tw ? interval : ut?.attackInterval ?? 1)
  const nextStep = mk ? mk * marketMult(next) * marketDecay(rank) : 0
  const rows: [string, string, string?][] = mk ? [
    ['Золота в минуту', String(Math.round(perStep * 24)), canUp ? String(Math.round(nextStep * 24)) : undefined],
    ['Рынок по счёту', `${rank + 1}-й (каждый следующий −20%)`],
    ['Окупается за', `${Math.round(bt.cost / (perStep / 2.5))} с`],
  ] : tw ? [
    ['Урон за выстрел', String(Math.round(dmg)), canUp ? String(Math.round(tw.damage * mn)) : undefined],
    ['Урон в секунду', fmt(dmg * perSec), canUp ? fmt(tw.damage * mn * 20 / (bt.spawnInterval * spawnMult(next))) : undefined],
    ['Выстрелов в секунду', fmt(perSec), canUp ? fmt(20 / (bt.spawnInterval * spawnMult(next))) : undefined],
    ['Дальность', String(tw.range)],
    ...(tw.airOnly ? [['Цели', 'только летуны'] as [string, string]] : []),
    ...(tw.antiNuke ? [['Сбивает ракеты', (b.interceptReady ?? 0) > gameState!.tick
      ? `через ${Math.ceil(((b.interceptReady ?? 0) - gameState!.tick) / 20)} с` : `готова (радиус ${tw.antiNuke.range})`] as [string, string]] : []),
  ] : [
    ['Здоровье', String(Math.round(ut.hp * m)), canUp ? String(Math.round(ut.hp * mn)) : undefined],
    [heal ? 'Лечение / урон' : 'Урон за удар', heal ? `${Math.round(PRIEST_HEAL * m)} / ${Math.round(dmg)}` : String(Math.round(dmg)),
      canUp ? (heal ? `${Math.round(PRIEST_HEAL * mn)} / ${Math.round(ut.damage * mn)}` : String(Math.round(ut.damage * mn))) : undefined],
    ['Урон в секунду', fmt(dmg * perSec), canUp ? fmt(ut.damage * mn * perSec) : undefined],
    ['Ударов в секунду', fmt(perSec)],
    ['Дальность', ut.range < 90 ? 'ближний бой' : String(ut.range)],
    ...(ut.splash ? [['Удар по площади', `радиус ${ut.splash}, соседям 60%`] as [string, string]] : []),
    ...(ut.flying ? [['Летает', 'пехота ближнего боя не достаёт'] as [string, string]] : []),
    ['Линия', ut.flying ? 'летит напрямую' : LANE_NAMES[laneFor(b.y)]],
    ['Скорость', fmt(ut.speed)],
    ['Найм раз в', `${fmt(interval / 20)} с`, canUp ? `${fmt(bt.spawnInterval * spawnMult(next) / 20)} с` : undefined],
  ]
  if (bt.antiTank && b.antiTank) rows.push([bt.antiTank.name, 'есть: танк с одного выстрела'])
  const dl = $('bi-stats')
  dl.innerHTML = ''
  for (const [k, v, nv] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    if (nv && nv !== v) { const i = document.createElement('i'); i.textContent = `→ ${nv}`; dd.appendChild(i) }
    dl.append(dt, dd)
  }
  const me = gameState!.players.find(p => p.id === myId)
  // противотанковое оружие для пехоты этого здания
  const at = bt.antiTank
  if (at && mine && !b.antiTank) {
    antiTankBtn.hidden = false
    antiTankBtn.disabled = !me || me.gold < at.cost
    antiTankBtn.textContent = `🚀 ${at.name} — 🪙${at.cost}`
    antiTankBtn.title = `Каждый воин выходит с одним выстрелом: убивает танк с одного попадания (дальность ${ANTITANK_RANGE})`
  } else antiTankBtn.hidden = true
  if (canUp) {
    const cost = upgradeCost(bt.cost, lv)
    upgradeBtn.hidden = false
    upgradeBtn.disabled = !me || me.gold < cost
    upgradeBtn.textContent = `Улучшить до ${next} ур. — 🪙${cost}`
    $('bi-note').textContent = mk
      ? `Доход +50%: ${Math.round(nextStep * 24)} золота в минуту. Окупится за ${Math.round(cost / ((nextStep - perStep) / 2.5))} с. Клавиша U.`
      : tw
      ? `Урон +25%, стреляет на 10% чаще, прочность ${Math.round(bt.hp * buildingHpMult(next))}. Клавиша U.`
      : `Воины +25% здоровья и урона, найм на 10% быстрее, прочность здания ${Math.round(bt.hp * buildingHpMult(next))}. Клавиша U.`
  } else {
    upgradeBtn.hidden = true
    $('bi-note').textContent = mine ? 'Максимальный уровень.' : 'Нажмите на своё здание, чтобы улучшить его.'
  }
}

// ── Кадр ─────────────────────────────────────────────────────────────────────

function loop() {
  if (gameState && roomId && gameState.phase !== 'lobby') {
    render(canvas, gameState, myId, myTeam, selectedBuilding, hover, aiming)
    // карточка здания: 5 раз в секунду достаточно (таймер — десятые доли секунды)
    const now = performance.now()
    if (selectedBid && now - infoAt > 200) { infoAt = now; renderInfo() }
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
