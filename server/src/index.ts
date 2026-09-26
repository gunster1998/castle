import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { GameRoom } from './GameRoom'
import type { Sock } from './sock'
import { handlePoll, pollCount } from './poll'
import type { ClientMsg, Race, ServerMsg, BotLevel, TeamSize, ChatLine } from './types'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST || '0.0.0.0'
// Собранный клиент (client/dist) отдаём тем же процессом; WebSocket — на любом пути, в проде /ws
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../../client/dist'))
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

// Файлы отдаются сжатыми (brotli или gzip) и кешируются в памяти: JS и модели жмутся в 3–4 раза
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.glb'])
interface Cached { mtime: number; raw: Buffer; br?: Buffer; gz?: Buffer }
const fileCache = new Map<string, Cached>()

function readCached(file: string, mtime: number): Cached {
  let c = fileCache.get(file)
  if (!c || c.mtime !== mtime) {
    c = { mtime, raw: fs.readFileSync(file) }
    fileCache.set(file, c)
  }
  return c
}

const clientIp = (req: http.IncomingMessage) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
const shortUa = (req: http.IncomingMessage) => String(req.headers['user-agent'] || '').slice(0, 160)

const httpServer = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
  // запасной канал — только если игрок сам включил его (у него не работает WebSocket)
  if (handlePoll(url, req, res, (sock, r) => onConnection(sock, r, 'poll'))) return
  // диагностика: браузер не смог подключиться по WebSocket — присылает отчёт обычным запросом
  if (url === '/diag' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      let data: unknown = body
      try { data = JSON.parse(body) } catch { /* как есть */ }
      console.log(`[diag] ${clientIp(req)} ${shortUa(req)} ${body.slice(0, 300)}`)
      perfLog({ type: 'diag', ip: clientIp(req), ua: shortUa(req), data })
      res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end()
    })
    return
  }
  if (url === '/' || url === '/index.html') console.log(`[page] ${clientIp(req)} ${shortUa(req)}`)
  let file = path.normalize(path.join(STATIC_DIR, url === '/' ? 'index.html' : url))
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      file = path.join(STATIC_DIR, 'index.html')
      try { st = fs.statSync(file) } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Клиент не собран: npm run build в client/')
        return
      }
    }
    const ext = path.extname(file)
    let c: Cached
    try { c = readCached(file, st.mtimeMs) } catch { res.writeHead(500); res.end(); return }
    const headers: Record<string, string> = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
      'vary': 'Accept-Encoding',
    }
    let body = c.raw
    const accept = String(req.headers['accept-encoding'] || '')
    if (COMPRESSIBLE.has(ext) && c.raw.length > 1024) {
      if (/\bbr\b/.test(accept)) {
        c.br ??= zlib.brotliCompressSync(c.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } })
        body = c.br
        headers['content-encoding'] = 'br'
      } else if (/\bgzip\b/.test(accept)) {
        c.gz ??= zlib.gzipSync(c.raw, { level: 9 })
        body = c.gz
        headers['content-encoding'] = 'gzip'
      }
    }
    headers['content-length'] = String(body.length)
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : body)
  })
})
// сжатие сообщений: состояние партии — JSON, он жмётся в 5–10 раз
const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 }, serverNoContextTakeover: false, clientNoContextTakeover: true },
})
httpServer.listen(PORT, HOST)

interface Client {
  id: string
  ws: Sock
  name: string
  race: Race
  roomId: string | null
  searching: boolean
  size: TeamSize
  /** Ключ вкладки: после обновления страницы игрок возвращается в свою партию. */
  session: string | null
  online: boolean
  telemetryAt: number
  chatAt: number
  dropTimer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, string>()   // ключ вкладки -> id игрока
const GRACE_GAME_MS = Number(process.env.GRACE_GAME_MS) || 15 * 60_000 // столько держим место отключившегося в партии
const GRACE_LOBBY_MS = Number(process.env.GRACE_LOBBY_MS) || 2 * 60_000 // и в лобби комнаты
/** Партия, где не осталось ни одного человека на связи, закрывается через столько. */
const EMPTY_ROOM_MS = Number(process.env.EMPTY_ROOM_MS) || 5 * 60_000
const cleanSession = (x: unknown) => (typeof x === 'string' && /^[\w-]{16,64}$/.test(x) ? x : null)

const clients = new Map<string, Client>()
const rooms = new Map<string, GameRoom>()
const SIZES: TeamSize[] = [1, 2, 4]
const queues: Record<TeamSize, string[]> = { 1: [], 2: [], 4: [] }
const queued = () => SIZES.reduce((n, k) => n + queues[k].length, 0)
const cleanSize = (x: unknown): TeamSize => (SIZES.includes(Number(x) as TeamSize) ? (Number(x) as TeamSize) : 1)
let _pid = 0
let _rid = 0

const RACES: Race[] = ['human', 'undead', 'orc']
const LEVELS: BotLevel[] = ['easy', 'normal', 'hard']
const cleanName = (n: unknown) => String(n ?? '').replace(/[<>]/g, '').trim().slice(0, 20)
const cleanRace = (r: unknown): Race => (RACES.includes(r as Race) ? (r as Race) : 'human')

/** Текущая сборка клиента: имя главного скрипта из index.html (в нём хеш содержимого). */
let buildCache = { mtime: -1, name: undefined as string | undefined }
function currentBuild(): string | undefined {
  try {
    const file = path.join(STATIC_DIR, 'index.html')
    const mtime = fs.statSync(file).mtimeMs
    if (mtime !== buildCache.mtime) {
      const m = /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(file, 'utf8'))
      buildCache = { mtime, name: m?.[1] }
    }
  } catch { return undefined }
  return buildCache.name
}

function send(c: Client, msg: ServerMsg) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg))
}

// ── Меню: список комнат и счётчики ───────────────────────────────────────────

let lobbyTimer: ReturnType<typeof setTimeout> | null = null
function broadcastLobby() {
  // не чаще раза в 200 мс
  if (lobbyTimer) return
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null
    const msg: ServerMsg = {
      type: 'lobby',
      online: [...clients.values()].filter(c => c.online).length,
      searching: queued(),
      rooms: [...rooms.values()].filter(r => r.listed).map(r => r.info()),
    }
    for (const c of clients.values()) if (!c.roomId) send(c, msg)
  }, 200)
}

// ── Чат в меню ───────────────────────────────────────────────────────────────

const CHAT_KEEP = 50
// история общего чата переживает перезапуск сервера
const CHAT_FILE = path.join(path.resolve(process.env.LOG_DIR || 'logs'), 'lobby-chat.json')
const lobbyChat: ChatLine[] = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'))
    return Array.isArray(list) ? list.slice(-CHAT_KEEP) : []
  } catch { return [] }
})()
let chatSaveTimer: ReturnType<typeof setTimeout> | null = null
function saveLobbyChat() {
  if (chatSaveTimer) return
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null
    fs.writeFile(CHAT_FILE, JSON.stringify(lobbyChat), () => {})
  }, 1000)
}
/** Текст сообщения: без управляющих символов, не длиннее 200. */
const cleanChat = (x: unknown) => String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
const sendLobbyChat = (c: Client) => send(c, { type: 'chat', scope: 'lobby', lines: lobbyChat, reset: true })

function chat(c: Client, text: string) {
  // не чаще раза в 0,7 с
  const now = Date.now()
  if (now - c.chatAt < 700 || !text) return
  c.chatAt = now
  console.log(`[chat] ${c.roomId ?? 'lobby'} ${c.name}: ${text}`)
  if (c.roomId) { rooms.get(c.roomId)?.chat(c.id, text); return }
  const line: ChatLine = { from: c.name, text, at: now }
  lobbyChat.push(line)
  if (lobbyChat.length > CHAT_KEEP) lobbyChat.shift()
  saveLobbyChat()
  for (const o of clients.values()) if (!o.roomId && o.online) send(o, { type: 'chat', scope: 'lobby', lines: [line] })
}

function makeRoom(name: string, listed: boolean): GameRoom {
  const id = `r${++_rid}`
  const room = new GameRoom(id, name, listed, { changed: broadcastLobby })
  rooms.set(id, room)
  broadcastLobby()
  return room
}

function enterRoom(c: Client, room: GameRoom, prefer?: 'west' | 'east'): boolean {
  leaveQueue(c)
  if (c.roomId) leaveRoom(c)
  const team = room.addPlayer(c.id, c.ws, c.name, c.race, prefer)
  if (!team) {
    send(c, { type: 'error', message: 'Комната уже заполнена или игра началась' })
    return false
  }
  c.roomId = room.id
  broadcastLobby()
  return true
}

function leaveRoom(c: Client) {
  if (!c.roomId) return
  const room = rooms.get(c.roomId)
  c.roomId = null
  send(c, { type: 'room', roomId: null, team: null })
  sendLobbyChat(c)
  if (room && room.removePlayer(c.id)) rooms.delete(room.id)
  broadcastLobby()
}

function leaveQueue(c: Client) {
  for (const k of SIZES) {
    const i = queues[k].indexOf(c.id)
    if (i >= 0) queues[k].splice(i, 1)
  }
  if (c.searching) {
    c.searching = false
    send(c, { type: 'queue', searching: false })
  }
  broadcastLobby()
}

/** Быстрый поиск: как только в очереди набирается 2×N игроков, они получают общую комнату и сразу начинают. */
function matchmake() {
  for (const size of SIZES) {
    const q = queues[size]
    while (q.length >= size * 2) {
      const group = q.splice(0, size * 2).map(id => clients.get(id)).filter((c): c is Client => !!c)
      if (group.length < size * 2) { q.unshift(...group.map(c => c.id)); break }
      const label = size === 1 ? `${group[0].name} против ${group[1].name}` : `Бой ${size}×${size}`
      const room = makeRoom(label, false)
      group.forEach((c, i) => {
        c.searching = false
        send(c, { type: 'queue', searching: false })
        enterRoom(c, room, i % 2 === 0 ? 'west' : 'east')
      })
      for (const c of group) room.ready(c.id)
    }
  }
  broadcastLobby()
}

// ── Подключения ──────────────────────────────────────────────────────────────

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => onConnection(ws, req))

type Conn = Sock & { on(ev: 'message', cb: (raw: { toString(): string }) => void): unknown; on(ev: 'close', cb: () => void): unknown; on(ev: 'error', cb: (err: Error) => void): unknown }

function onConnection(ws: Conn, req: http.IncomingMessage, kind: 'ws' | 'poll' = 'ws') {
  // пока не пришёл hello с ключом вкладки — временный игрок; если ключ известен, соединение перейдёт к «своему»
  let c: Client = {
    id: `p${++_pid}`, ws, name: `Игрок ${_pid}`, race: 'human', roomId: null, searching: false, size: 1,
    session: null, online: true, dropTimer: null, telemetryAt: 0, chatAt: 0,
  }
  clients.set(c.id, c)
  send(c, { type: 'init', playerId: c.id, build: currentBuild() })
  sendLobbyChat(c)
  console.log(`[${kind}+] ${c.id} ${clientIp(req)} ${shortUa(req)}`)
  broadcastLobby()

  ws.on('message', raw => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg
    } catch {
      return
    }
    try {
      if (msg.type === 'hello') c = hello(c, ws, msg)
      else handle(c, msg)
    } catch (e) {
      console.error('Ошибка обработки', c.id, e)
    }
  })

  ws.on('close', () => {
    // соединение уже передано новой вкладке — старое закрытие ничего не значит
    if (c.ws !== ws) return
    dropped(c)
  })

  ws.on('error', err => console.error('WS error', c.id, err.message))
}

/** hello: имя, раса и ключ вкладки. Известный ключ — вернуть игрока в его партию. */
function hello(c: Client, ws: Sock, msg: Extract<ClientMsg, { type: 'hello' }>): Client {
  const name = cleanName(msg.name) || c.name
  const race = cleanRace(msg.race)
  const token = cleanSession(msg.session)
  const knownId = token ? sessions.get(token) : undefined
  const known = knownId ? clients.get(knownId) : undefined
  if (known && known !== c) {
    if (known.dropTimer) { clearTimeout(known.dropTimer); known.dropTimer = null }
    if (known.online && known.ws !== ws) {
      send(known, { type: 'error', message: 'Игра открыта в другой вкладке' })
      known.ws.close(4000, 'replaced')
    }
    known.ws = ws
    known.online = true
    if (!known.roomId) { known.name = name; known.race = race }
    clients.delete(c.id)
    send(known, { type: 'init', playerId: known.id, build: currentBuild() })
    if (!known.roomId) sendLobbyChat(known)
    if (known.roomId) {
      const room = rooms.get(known.roomId)
      if (!room || !room.reattach(known.id, ws)) {
        known.roomId = null
        send(known, { type: 'room', roomId: null, team: null })
      }
    }
    console.log(`[↻] ${known.id} вернулся${known.roomId ? ` в ${known.roomId}` : ''}`)
    broadcastLobby()
    return known
  }
  c.name = name
  c.race = race
  if (token && !c.session) {
    c.session = token
    sessions.set(token, c.id)
  }
  broadcastLobby()
  return c
}

/** Связь оборвалась: в партии держим место, в меню — забываем сразу. */
function dropped(c: Client) {
  c.online = false
  leaveQueue(c)
  const room = c.roomId ? rooms.get(c.roomId) : undefined
  if (room) {
    room.disconnect(c.id)
    const grace = room.phase === 'lobby' ? GRACE_LOBBY_MS : GRACE_GAME_MS
    console.log(`[…] ${c.id} потерял связь, ждём ${grace / 1000} с`)
    c.dropTimer = setTimeout(() => { c.dropTimer = null; forget(c) }, grace)
  } else {
    forget(c)
  }
  broadcastLobby()
}

function forget(c: Client) {
  leaveRoom(c)
  clients.delete(c.id)
  if (c.session && sessions.get(c.session) === c.id) sessions.delete(c.session)
  console.log(`[-] ${c.id} ушёл`)
  broadcastLobby()
}

function handle(c: Client, msg: ClientMsg) {
  switch (msg.type) {
    case 'quick_match': {
      c.race = cleanRace(msg.race)
      if (c.roomId) leaveRoom(c)
      leaveQueue(c)
      c.size = cleanSize(msg.size)
      queues[c.size].push(c.id)
      c.searching = true
      send(c, { type: 'queue', searching: true, size: c.size })
      matchmake()
      return
    }
    case 'cancel_queue': return leaveQueue(c)
    case 'create_room': {
      c.race = cleanRace(msg.race)
      const room = makeRoom(cleanName(msg.name) || `Комната ${c.name}`, true)
      if (!enterRoom(c, room)) rooms.delete(room.id)
      return
    }
    case 'join_room': {
      c.race = cleanRace(msg.race)
      const room = rooms.get(String(msg.roomId))
      if (!room || !room.info().open) {
        send(c, { type: 'error', message: 'Комната больше недоступна' })
        broadcastLobby()
        return
      }
      enterRoom(c, room)
      return
    }
    case 'play_bot': {
      c.race = cleanRace(msg.race)
      const level = LEVELS.includes(msg.level) ? msg.level : 'normal'
      const size = cleanSize(msg.size)
      const room = makeRoom(size === 1 ? `${c.name} против бота` : `${c.name}: ${size}×${size} с ботами`, false)
      if (!enterRoom(c, room, 'west')) { rooms.delete(room.id); return }
      // противники — другими расами, чем игрок (по очереди)
      const others = RACES.filter(r => r !== c.race)
      const foe: Race = others[Math.floor(Math.random() * others.length)]
      // союзники — разных рас, противники — в основном расой, противоположной игроку
      for (let i = 1; i < size; i++) room.addBot(i % 2 ? foe : c.race, level, 'west')
      for (let i = 0; i < size; i++) room.addBot(i % 2 ? c.race : foe, level, 'east')
      room.ready(c.id)
      return
    }
    case 'leave_room': return leaveRoom(c)
    case 'chat': return chat(c, cleanChat(msg.text))
    case 'telemetry': {
      // не чаще раза в 3 с и не больше 16 КБ с игрока
      const now = Date.now()
      if (now - c.telemetryAt < 3000) return
      c.telemetryAt = now
      const body = JSON.stringify(msg.data ?? null)
      if (body.length > 16_384) return
      perfLog({ type: 'client', player: c.id, name: c.name, room: c.roomId, data: JSON.parse(body) })
      return
    }
    case 'set_race':
      c.race = cleanRace(msg.race)
      if (c.roomId) rooms.get(c.roomId)?.setRace(c.id, c.race)
      return
    case 'ready':
    case 'place_building':
    case 'upgrade_building':
    case 'super_strike':
    case 'nuke':
    case 'buy_antitank':
    case 'buy_aura':
    case 'buy_nuke':
    case 'counter_nuke':
    case 'ping':
    case 'militia':
    case 'switch_team':
    case 'add_bot':
    case 'remove_bot':
      if (c.roomId) rooms.get(c.roomId)?.handleMessage(c.id, msg as unknown as { type: string })
      return
  }
}

// ── Логи производительности: logs/perf-ГГГГ-ММ-ДД.log, по строке JSON ─────────

const LOG_DIR = path.resolve(process.env.LOG_DIR || 'logs')
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch { /* нет прав — логи не пишем */ }
function perfLog(entry: Record<string, unknown>) {
  const ts = new Date()
  const file = path.join(LOG_DIR, `perf-${ts.toISOString().slice(0, 10)}.log`)
  fs.appendFile(file, JSON.stringify({ ts: ts.toISOString(), ...entry }) + '\n', () => {})
}

// сервер: раз в минуту — тики комнат, трафик, память, задержка цикла событий
const loopDelay = monitorEventLoopDelay({ resolution: 20 })
const lag = (ns: number) => Math.max(0, +(ns / 1e6 - 20).toFixed(1))
loopDelay.enable()
// пустые партии: все люди отключились и не вернулись — закрыть, чтобы не крутить ботов впустую
const emptySince = new Map<string, number>()
setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.humanCount > 0) { emptySince.delete(room.id); continue }
    const since = emptySince.get(room.id) ?? now
    emptySince.set(room.id, since)
    if (now - since < EMPTY_ROOM_MS) continue
    emptySince.delete(room.id)
    console.log(`[x] ${room.id} закрыта: все отключились`)
    for (const c of [...clients.values()]) if (c.roomId === room.id && !c.online) {
      if (c.dropTimer) { clearTimeout(c.dropTimer); c.dropTimer = null }
      forget(c)
    }
  }
}, 15_000).unref()

setInterval(() => {
  const online = [...clients.values()].filter(c => c.online).length
  const roomStats = [...rooms.values()].map(r => {
    const st = r.takeStats()
    return {
      id: r.id, name: r.name, phase: st.phase, players: st.players, humans: st.humans, units: st.units, unitsMax: st.unitsMax,
      buildings: st.buildings, tickAvgMs: st.ticks ? +(st.tickMs / st.ticks).toFixed(2) : 0, tickMaxMs: +st.tickMax.toFixed(2),
      sentKBps: +(st.bytes / 60 / 1024).toFixed(1),
    }
  })
  if (!online && !roomStats.length) { loopDelay.reset(); return }
  perfLog({
    type: 'server', online, polling: pollCount(), rooms: roomStats,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    // задержка цикла событий сверх шага замера (20 мс): 0 — сервер не тормозит
    loopDelayMs: { p50: lag(loopDelay.percentile(50)), p99: lag(loopDelay.percentile(99)), max: lag(loopDelay.max) },
  })
  loopDelay.reset()
}, 60_000).unref()

console.log(`Castle Fight: http://${HOST}:${PORT} (игра и WebSocket), статика из ${STATIC_DIR}`)
