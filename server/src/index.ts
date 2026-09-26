import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { GameRoom } from './GameRoom'
import type { ClientMsg, Race, ServerMsg, BotLevel, TeamSize } from './types'

const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST || '0.0.0.0'
// Собранный клиент (client/dist) отдаём тем же процессом; WebSocket — на любом пути, в проде /ws
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../../client/dist'))
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

const httpServer = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
  let file = path.normalize(path.join(STATIC_DIR, url === '/' ? 'index.html' : url))
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(STATIC_DIR, 'index.html')
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Клиент не собран: npm run build в client/'); return }
      const ext = path.extname(file)
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
      })
      res.end(data)
    })
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
  ws: WebSocket
  name: string
  race: Race
  roomId: string | null
  searching: boolean
  size: TeamSize
}

const clients = new Map<string, Client>()
const rooms = new Map<string, GameRoom>()
const SIZES: TeamSize[] = [1, 2, 4]
const queues: Record<TeamSize, string[]> = { 1: [], 2: [], 4: [] }
const queued = () => SIZES.reduce((n, k) => n + queues[k].length, 0)
const cleanSize = (x: unknown): TeamSize => (SIZES.includes(Number(x) as TeamSize) ? (Number(x) as TeamSize) : 1)
let _pid = 0
let _rid = 0

const RACES: Race[] = ['human', 'undead']
const LEVELS: BotLevel[] = ['easy', 'normal', 'hard']
const cleanName = (n: unknown) => String(n ?? '').replace(/[<>]/g, '').trim().slice(0, 20)
const cleanRace = (r: unknown): Race => (RACES.includes(r as Race) ? (r as Race) : 'human')

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
      online: clients.size,
      searching: queued(),
      rooms: [...rooms.values()].filter(r => r.listed).map(r => r.info()),
    }
    for (const c of clients.values()) if (!c.roomId) send(c, msg)
  }, 200)
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

wss.on('connection', (ws: WebSocket) => {
  const c: Client = { id: `p${++_pid}`, ws, name: `Игрок ${_pid}`, race: 'human', roomId: null, searching: false, size: 1 }
  clients.set(c.id, c)
  send(c, { type: 'init', playerId: c.id })
  console.log(`[+] ${c.id}, онлайн: ${clients.size}`)
  broadcastLobby()

  ws.on('message', raw => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg
    } catch {
      return
    }
    try {
      handle(c, msg)
    } catch (e) {
      console.error('Ошибка обработки', c.id, e)
    }
  })

  ws.on('close', () => {
    console.log(`[-] ${c.id} отключился`)
    leaveQueue(c)
    leaveRoom(c)
    clients.delete(c.id)
    broadcastLobby()
  })

  ws.on('error', err => console.error('WS error', c.id, err.message))
})

function handle(c: Client, msg: ClientMsg) {
  switch (msg.type) {
    case 'hello': {
      c.name = cleanName(msg.name) || c.name
      c.race = cleanRace(msg.race)
      broadcastLobby()
      return
    }
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
      const foe: Race = c.race === 'human' ? 'undead' : 'human'
      // союзники — разных рас, противники — в основном расой, противоположной игроку
      for (let i = 1; i < size; i++) room.addBot(i % 2 ? foe : c.race, level, 'west')
      for (let i = 0; i < size; i++) room.addBot(i % 2 ? c.race : foe, level, 'east')
      room.ready(c.id)
      return
    }
    case 'leave_room': return leaveRoom(c)
    case 'set_race':
      c.race = cleanRace(msg.race)
      if (c.roomId) rooms.get(c.roomId)?.setRace(c.id, c.race)
      return
    case 'ready':
    case 'place_building':
    case 'upgrade_building':
    case 'switch_team':
    case 'add_bot':
    case 'remove_bot':
      if (c.roomId) rooms.get(c.roomId)?.handleMessage(c.id, msg as unknown as { type: string })
      return
  }
}

console.log(`Castle Fight: http://${HOST}:${PORT} (игра и WebSocket), статика из ${STATIC_DIR}`)
