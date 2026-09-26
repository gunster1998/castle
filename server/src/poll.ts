// Запасной канал — только если игрок сам его включил (у него не работает WebSocket: антивирус, прокси,
// фильтр провайдера). Обычные HTTP-запросы: клиент держит «длинный» GET /poll/recv — сервер отвечает,
// как только есть сообщения, — и шлёт свои через POST /poll/send. Для игровой логики это такой же сокет.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import type http from 'node:http'
import type { Sock } from './sock'

const OPEN = 1
const CLOSED = 3
const HOLD_MS = 25_000     // сколько держим пустой запрос recv
const IDLE_MS = 40_000     // нет запросов столько — игрок ушёл
const MAX_QUEUE = 300

export class PollSocket extends EventEmitter implements Sock {
  readyState = OPEN
  private queue: string[] = []
  private waiting: { res: http.ServerResponse; gzip: boolean; timer: ReturnType<typeof setTimeout> } | null = null
  private closeCode: number | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private flushQueued = false

  constructor(readonly sid: string, private onGone: (sid: string) => void) {
    super()
    this.touch()
  }

  send(data: string) {
    if (this.readyState !== OPEN) return
    // состояние партии нужно только самое свежее: подряд идущие заменяем
    const last = this.queue.length - 1
    if (last >= 0 && isState(data) && isState(this.queue[last])) this.queue[last] = data
    else this.queue.push(data)
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
    this.scheduleFlush()
  }

  close(code = 1000) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.closeCode = code
    this.scheduleFlush()
    // как у WebSocket — событие закрытия приходит не сразу (важно при передаче игрока новой вкладке)
    setImmediate(() => this.emit('close', code))
    // запись держим ещё немного, чтобы клиент успел узнать код закрытия
    setTimeout(() => this.onGone(this.sid), 10_000)
  }

  /** GET /poll/recv: ответить сразу, если есть что, иначе подождать. */
  attach(res: http.ServerResponse, gzip: boolean) {
    this.touch()
    if (this.waiting) this.flush()
    const timer = setTimeout(() => this.flush(), HOLD_MS)
    this.waiting = { res, gzip, timer }
    res.on('close', () => { if (this.waiting?.res === res) { clearTimeout(timer); this.waiting = null } })
    if (this.queue.length || this.closeCode !== null) this.flush()
  }

  /** POST /poll/send: сообщения клиента. */
  receive(messages: string[]) {
    this.touch()
    if (this.readyState !== OPEN) return
    for (const m of messages) this.emit('message', m)
  }

  private scheduleFlush() {
    if (this.flushQueued || !this.waiting) return
    this.flushQueued = true
    setImmediate(() => { this.flushQueued = false; this.flush() })
  }

  private flush() {
    const w = this.waiting
    if (!w) return
    this.waiting = null
    clearTimeout(w.timer)
    const body = `{"m":[${this.queue.join(',')}],"c":${this.closeCode}}`
    this.queue = []
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }
    let out: Buffer | string = body
    if (w.gzip && body.length > 1024) {
      out = zlib.gzipSync(body, { level: 3 })
      headers['content-encoding'] = 'gzip'
    }
    w.res.writeHead(200, headers)
    w.res.end(out)
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { if (!this.waiting) this.close(1001); else this.touch() }, IDLE_MS)
  }
}

const isState = (s: string) => s.startsWith('{"type":"state"')
const CORS = { 'access-control-allow-origin': '*' }

const polls = new Map<string, PollSocket>()
export const pollCount = () => polls.size

/** Обработчик /poll/*. Возвращает false, если адрес не наш. */
export function handlePoll(url: string, req: http.IncomingMessage, res: http.ServerResponse,
  onOpen: (sock: PollSocket, req: http.IncomingMessage) => void): boolean {
  if (!url.startsWith('/poll/')) return false
  const sid = new URL(req.url || '/', 'http://x').searchParams.get('sid') || ''
  const reply = (status: number, body = '') => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS })
    res.end(body)
  }
  if (url === '/poll/open' && req.method === 'POST') {
    const id = randomUUID()
    const sock = new PollSocket(id, gone => polls.delete(gone))
    polls.set(id, sock)
    onOpen(sock, req)
    reply(200, JSON.stringify({ sid: id }))
    return true
  }
  const sock = polls.get(sid)
  if (!sock) { reply(404, '{"error":"unknown sid"}'); return true }
  if (url === '/poll/recv' && req.method === 'GET') {
    sock.attach(res, /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')))
    return true
  }
  if (url === '/poll/send' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy() })
    req.on('end', () => {
      try {
        const list = JSON.parse(body)
        if (Array.isArray(list)) sock.receive(list.filter((x): x is string => typeof x === 'string').slice(0, 50))
      } catch { /* мусор */ }
      reply(204)
    })
    return true
  }
  reply(405)
  return true
}
