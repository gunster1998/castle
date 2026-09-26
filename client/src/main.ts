import { GameWS } from './ws'
import { render, initRenderer, updateEffects, unproject, resetScene, setSelectedBuilding, pickBuilding } from './renderer'
import type { GameState, ServerMsg, Team, Race, RoomInfo, BotLevel, TeamSize } from './types'
import { TEAM_MAX } from './types'
import { BUILDINGS_BY_RACE, BUILDING_TYPES, UNIT_TYPES } from './data'
import { MAX_LEVEL, upgradeCost, unitMult, spawnMult, buildingHpMult } from './upgrades'
import { canPlace } from './placement'

// ── Состояние ────────────────────────────────────────────────────────────────

let myId = ''
let myTeam: Team = 'west'
let roomId: string | null = null
let searching = false
let searchStart = 0
let gameState: GameState | null = null
let selectedBuilding: string | null = null
let hover: { x: number; y: number } | null = null
let selectedBid: string | null = null
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
const tipEl = $('tip')
const toastEl = $('toast')

function safeGet(k: string) { try { return localStorage.getItem(k) } catch { return null } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* приватный режим */ } }
nameInput.value = safeGet('cf.name') || `Игрок${Math.floor(Math.random() * 900 + 100)}`
race = (safeGet('cf.race') as Race) === 'undead' ? 'undead' : 'human'
size = ([1, 2, 4] as TeamSize[]).find(n => String(n) === safeGet('cf.size')) ?? 1

// ── Сеть ─────────────────────────────────────────────────────────────────────

const proto = location.protocol === 'https:' ? 'wss' : 'ws'
const WS_URL = import.meta.env.VITE_WS_URL ?? (import.meta.env.DEV ? 'ws://localhost:3001' : `${proto}://${location.host}/ws`)
const ws = new GameWS(WS_URL)

function hello() {
  ws.send({ type: 'hello', name: nameInput.value.trim() || 'Игрок', race })
}

ws.onMessage((msg: ServerMsg) => {
  switch (msg.type) {
    case 'init':
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
      if (!roomId) { gameState = null; selectedBuilding = null; selectBid(null) }
      break
    case 'state':
      if (msg.state.roomId !== roomId) break
      if (msg.state.phase === 'playing') updateEffects(msg.state)
      gameState = msg.state
      stateAt = performance.now()
      break
    case 'error':
      if (gameState?.phase === 'playing') showTip(msg.message, '#ff6b5e')
      else toast(msg.message)
      break
  }
  updateUI()
})
ws.connect()

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

readyBtn.addEventListener('click', () => ws.send({ type: 'ready' }))
$('leave-room-btn').addEventListener('click', () => ws.send({ type: 'leave_room' }))
$('leave-game-btn').addEventListener('click', () => ws.send({ type: 'leave_room' }))
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
    row.querySelector('.pn span')!.textContent = raceName(p.race)
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
        btn.title = `Горячая клавиша: ${i + 1}`
        btn.innerHTML = `<span class="bname">${i + 1}. ${btype.name}</span><span class="bcost">🪙${btype.cost}</span><span class="bdesc">${btype.description}</span>`
        btn.addEventListener('click', () => selectBuilding(bid))
        buildMenu.appendChild(btn)
      })
    }
    for (const btn of buildMenu.querySelectorAll<HTMLButtonElement>('.build-btn')) {
      btn.classList.toggle('selected', btn.dataset.id === selectedBuilding)
      btn.classList.toggle('cant-afford', me.gold < BUILDING_TYPES[btn.dataset.id!].cost)
    }
    rematchBtn.hidden = true
  } else {
    buildMenu.style.display = 'none'
    selectedBuilding = null
    rematchBtn.hidden = phase !== 'game_end' || gameState.players.length < 2
    if (phase === 'game_end') {
      showTip(gameState.notice ?? (me?.ready ? 'Ждём ответа соперника на реванш…' : 'Матч окончен. Реванш или в меню?'), '#f2c14e')
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
  showTip(selectedBuilding ? `Кликните на своей базе, чтобы построить: ${BUILDING_TYPES[id].name}. Shift — строить ещё. Esc — отмена.` : '', '#ffffff')
  updateUI()
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
setInterval(() => {
  if (!searching) return
  const s = Math.floor((Date.now() - searchStart) / 1000)
  $('search-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}, 250)

// ── Ввод на поле ─────────────────────────────────────────────────────────────

initRenderer(canvas)
// отладка/тесты: текущее состояние партии
;(window as unknown as { __castle: Record<string, unknown> }).__castle.state = () => gameState

canvas.addEventListener('mousemove', e => {
  if (!gameState || gameState.phase !== 'playing') { hover = null; return }
  hover = unproject(e.clientX, e.clientY, canvas)
  canvas.style.cursor = !selectedBuilding && pickBuilding(e.clientX, e.clientY, canvas) ? 'pointer' : 'crosshair'
})
canvas.addEventListener('mouseleave', () => { hover = null })

function selectBid(id: string | null) {
  selectedBid = id
  setSelectedBuilding(id)
  renderInfo()
}

canvas.addEventListener('click', e => {
  if (!gameState || gameState.phase !== 'playing') return
  const p = unproject(e.clientX, e.clientY, canvas)
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
  if (e.key === 'Escape') { selectedBuilding = null; selectBid(null); showTip(''); updateUI(); return }
  if (e.code === 'KeyU') { upgradeSelected(); return }
  const me = gameState.players.find(p => p.id === myId)
  const idx = Number(e.key) - 1
  if (me && idx >= 0 && idx < BUILDINGS_BY_RACE[me.race].length) selectBuilding(BUILDINGS_BY_RACE[me.race][idx])
})

// ── Карточка здания ──────────────────────────────────────────────────────────

const binfo = $('binfo')
const upgradeBtn = $<HTMLButtonElement>('bi-upgrade')
$('bi-close').addEventListener('click', () => selectBid(null))
upgradeBtn.addEventListener('click', () => upgradeSelected())

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
  $('bi-timer').textContent = `${fmt(left)} с`
  $('bi-spawnbar').style.width = `${Math.min(100, (1 - (left * 20) / interval) * 100)}%`

  const lv = b.level, next = Math.min(MAX_LEVEL, lv + 1)
  const canUp = mine && lv < MAX_LEVEL
  const m = unitMult(lv), mn = unitMult(next)
  $('bi-unit-name').textContent = ut.name
  $('bi-unit-level').textContent = `уровень ${lv}`
  const heal = ut.id === 'priest'
  const dmg = ut.damage * m
  const perSec = 20 / ut.attackInterval
  const rows: [string, string, string?][] = [
    ['Здоровье', String(Math.round(ut.hp * m)), canUp ? String(Math.round(ut.hp * mn)) : undefined],
    [heal ? 'Лечение / урон' : 'Урон за удар', heal ? `${Math.round(25 * m)} / ${Math.round(dmg)}` : String(Math.round(dmg)),
      canUp ? (heal ? `${Math.round(25 * mn)} / ${Math.round(ut.damage * mn)}` : String(Math.round(ut.damage * mn))) : undefined],
    ['Урон в секунду', fmt(dmg * perSec), canUp ? fmt(ut.damage * mn * perSec) : undefined],
    ['Ударов в секунду', fmt(perSec)],
    ['Дальность', ut.range < 70 ? 'ближний бой' : String(ut.range)],
    ['Скорость', fmt(ut.speed)],
    ['Найм раз в', `${fmt(interval / 20)} с`, canUp ? `${fmt(bt.spawnInterval * spawnMult(next) / 20)} с` : undefined],
  ]
  const dl = $('bi-stats')
  dl.innerHTML = ''
  for (const [k, v, nv] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    if (nv && nv !== v) { const i = document.createElement('i'); i.textContent = `→ ${nv}`; dd.appendChild(i) }
    dl.append(dt, dd)
  }
  const me = gameState!.players.find(p => p.id === myId)
  if (canUp) {
    const cost = upgradeCost(bt.cost, lv)
    upgradeBtn.hidden = false
    upgradeBtn.disabled = !me || me.gold < cost
    upgradeBtn.textContent = `Улучшить до ${next} ур. — 🪙${cost}`
    $('bi-note').textContent = `Воины +25% здоровья и урона, найм на 10% быстрее, прочность здания ${Math.round(bt.hp * buildingHpMult(next))}. Клавиша U.`
  } else {
    upgradeBtn.hidden = true
    $('bi-note').textContent = mine ? 'Максимальный уровень.' : 'Нажмите на своё здание, чтобы улучшить его.'
  }
}

// ── Кадр ─────────────────────────────────────────────────────────────────────

function loop() {
  if (gameState && roomId && gameState.phase !== 'lobby') {
    render(canvas, gameState, myId, myTeam, selectedBuilding, hover)
    if (selectedBid) renderInfo()
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
