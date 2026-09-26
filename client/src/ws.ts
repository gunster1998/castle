import { unpackState, type ClientMsg, type ServerMsg } from './types'

type Handler = (msg: ServerMsg) => void

/** Не открылся WebSocket за это время — предупредить игрока (он сам решит, включать ли запасной режим). */
const STUCK_AFTER_MS = 8000
/** Игрок включил запасной режим: помним до закрытия вкладки. */
const POLL_PREF = 'cf.transport'
/** В запасном режиме так часто пробуем, не заработал ли WebSocket, — и сами возвращаемся на него. */
const UPGRADE_EVERY_MS = 20_000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function prefGet() { try { return sessionStorage.getItem(POLL_PREF) } catch { return null } }
function prefSet(on: boolean) {
  try {
    if (on) sessionStorage.setItem(POLL_PREF, '1')
    else sessionStorage.removeItem(POLL_PREF)
    localStorage.removeItem(POLL_PREF) // старая версия запоминала на 3 дня
  } catch { /* приватный режим */ }
}

/**
 * Соединение с сервером — WebSocket. По умолчанию через Web Worker (net.worker.ts): сокет и разбор
 * сообщений — в фоне, в главный поток приходит только свежее состояние. Нет воркеров — WebSocket в главном потоке.
 * Запасной режим (обычные HTTP-запросы) — только если игрок сам его включил: у него WebSocket не проходит.
 */
export class GameWS {
  private handlers: Handler[] = []
  private worker: Worker | null = null
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stuckTimer: ReturnType<typeof setTimeout> | null = null
  private upgradeTimer: ReturnType<typeof setInterval> | null = null
  private outbox: string[] = []
  public connected = false
  /** Сколько устаревших состояний пропущено (главный поток не успевал). */
  public droppedStates = 0
  private stopped = false
  private everOpened = false
  /** Последняя ошибка соединения — для диагностики. */
  public lastError = ''
  private mode: 'worker' | 'ws' | 'poll' = 'ws'
  private sid = ''
  private sendQueued = false
  /** WebSocket не открылся — показать игроку предупреждение. */
  public onStuck: () => void = () => {}
  /** Сменился способ связи (например, запасной режим сам вернулся на WebSocket). */
  public onTransport: (t: 'worker' | 'ws' | 'poll') => void = () => {}

  /** url — адрес WebSocket, httpBase — адрес сервера для запасного режима ('' — этот же сайт). */
  constructor(private url: string, private httpBase = '') {}

  get usingWorker() { return this.mode === 'worker' }
  get transport() { return this.mode }

  connect() {
    if (prefGet()) { void this.connectPoll(); return }
    this.stuckTimer = setTimeout(() => this.checkStuck(), STUCK_AFTER_MS)
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./net.worker.ts', import.meta.url), { type: 'module' })
        this.mode = 'worker'
        this.onTransport('worker')
        this.worker.onmessage = ev => this.fromWorker(ev.data)
        this.worker.onerror = e => {
          // воркер не поднялся (старый браузер, CSP) — работаем по-старому
          console.warn('Сетевой воркер недоступен, соединение в главном потоке', e.message)
          this.lastError = `worker error: ${e.message}`
          this.worker?.terminate()
          this.worker = null
          if (this.mode === 'worker') this.connectDirect()
        }
        this.worker.postMessage({ kind: 'connect', url: this.url })
        return
      } catch (e) {
        console.warn('Сетевой воркер недоступен', e)
        this.worker = null
      }
    }
    this.connectDirect()
  }

  /** Игрок сам включил запасной режим. */
  usePoll() {
    if (this.mode === 'poll') return
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null }
    if (this.worker) { this.worker.postMessage({ kind: 'close' }); this.worker.terminate(); this.worker = null }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null }
    prefSet(true)
    void this.connectPoll()
  }

  private opened() {
    this.connected = true
    this.everOpened = true
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null }
  }

  /** Таймер мог сработать просто потому, что страница долго грузилась, — сначала спрашиваем воркер. */
  private checkStuck(checked = false) {
    this.stuckTimer = null
    if (this.everOpened || this.stopped || this.mode === 'poll') return
    if (this.ws?.readyState === WebSocket.OPEN) { this.opened(); return }
    if (this.worker && !checked) { this.worker.postMessage({ kind: 'status' }); return }
    const report = {
      reason: 'ws-timeout', wsUrl: this.url, worker: !!this.worker, lastError: this.lastError,
      ua: navigator.userAgent, lang: navigator.language, online: navigator.onLine,
    }
    fetch(`${this.httpBase}/diag`, { method: 'POST', body: JSON.stringify(report), keepalive: true }).catch(() => { /* не прошло */ })
    this.onStuck()
  }

  private fromWorker(m: { kind: string; msg?: ServerMsg; dropped?: number; code?: number; open?: boolean }) {
    switch (m.kind) {
      case 'status':
        if (m.open) this.opened()
        else this.checkStuck(true)
        break
      case 'open':
        this.opened()
        break
      case 'closed':
        this.connected = false
        this.lastError = `closed ${m.code ?? ''}`
        break
      case 'msg':
        this.emit(m.msg!)
        break
      case 'state':
        this.droppedStates += m.dropped ?? 0
        this.emit(m.msg!)
        // готовы к следующему: подтверждаем после отрисовки кадра, а не сразу
        requestAnimationFrame(() => this.worker?.postMessage({ kind: 'ack' }))
        break
    }
  }

  private connectDirect() {
    this.mode = 'ws'
    this.onTransport('ws')
    this.ws = new WebSocket(this.url)
    this.ws.onopen = () => {
      this.opened()
      while (this.outbox.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.outbox.shift()!)
    }
    this.ws.onmessage = ev => {
      try {
        this.emit(JSON.parse(ev.data) as ServerMsg)
      } catch (e) {
        console.error('Bad server message', e)
      }
    }
    this.ws.onerror = () => { this.lastError = 'websocket error' }
    this.ws.onclose = ev => {
      this.lastError = `closed ${ev.code}`
      this.connected = false
      if (ev.code !== 4000 && !this.stopped && this.mode === 'ws') this.reconnectTimer = setTimeout(() => this.connectDirect(), 2000)
    }
  }

  // ── Запасной режим: HTTP ───────────────────────────────────────────────────

  /** В запасном режиме время от времени проверяем, не проходит ли уже WebSocket. */
  private tryUpgrade() {
    if (this.mode !== 'poll' || this.stopped) return
    let done = false
    const probe = new WebSocket(this.url)
    const fail = () => { if (!done) { done = true; try { probe.close() } catch { /* уже закрыт */ } } }
    const timer = setTimeout(fail, 6000)
    probe.onerror = fail
    probe.onclose = fail
    probe.onopen = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      probe.onclose = null
      probe.close()
      // WebSocket проходит: бросаем HTTP и подключаемся заново (сервер узнает нас по ключу вкладки)
      console.info('WebSocket заработал — выходим из запасного режима')
      prefSet(false)
      if (this.upgradeTimer) { clearInterval(this.upgradeTimer); this.upgradeTimer = null }
      this.sid = ''
      this.connected = false
      this.everOpened = false
      this.mode = 'ws'
      this.connect()
    }
  }

  private async connectPoll() {
    this.mode = 'poll'
    this.onTransport('poll')
    if (!this.upgradeTimer) this.upgradeTimer = setInterval(() => this.tryUpgrade(), UPGRADE_EVERY_MS)
    while (!this.stopped && this.mode === 'poll') {
      try {
        const r = await fetch(`${this.httpBase}/poll/open`, { method: 'POST', cache: 'no-store' })
        if (!r.ok) throw new Error(`open ${r.status}`)
        this.sid = ((await r.json()) as { sid: string }).sid
        this.opened()
        this.flushPoll()
        const code = await this.recvLoop()
        if (this.mode !== 'poll') return // вернулись на WebSocket
        this.connected = false
        this.sid = ''
        if (code === 4000) return
      } catch (e) {
        this.lastError = `poll: ${(e as Error).message}`
        this.connected = false
        this.sid = ''
      }
      await sleep(2000)
    }
  }

  /** Получение сообщений; возвращает код закрытия от сервера (или null — сессия потеряна). */
  private async recvLoop(): Promise<number | null> {
    const sid = this.sid
    while (!this.stopped && this.sid === sid && this.mode === 'poll') {
      const r = await fetch(`${this.httpBase}/poll/recv?sid=${sid}`, { cache: 'no-store' })
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`recv ${r.status}`)
      const { m, c } = (await r.json()) as { m: ServerMsg[]; c: number | null }
      // из пачки подряд идущих состояний показываем только последнее
      for (let i = 0; i < m.length; i++) {
        if (m[i].type === 'state' && m[i + 1]?.type === 'state') { this.droppedStates++; continue }
        this.emit(m[i])
      }
      if (c !== null) return c
    }
    return null
  }

  private flushPoll() {
    if (this.sendQueued || !this.sid || !this.outbox.length) return
    this.sendQueued = true
    queueMicrotask(() => {
      this.sendQueued = false
      if (!this.sid || !this.outbox.length) return
      const batch = this.outbox.splice(0, this.outbox.length)
      fetch(`${this.httpBase}/poll/send?sid=${this.sid}`, { method: 'POST', body: JSON.stringify(batch), cache: 'no-store' })
        .catch(e => { this.lastError = `poll send: ${(e as Error).message}` })
    })
  }

  // ── Общее ──────────────────────────────────────────────────────────────────

  private emit(msg: ServerMsg) {
    // из воркера состояние приходит уже распакованным; повторная распаковка ничего не делает
    if (msg.type === 'state') unpackState(msg.state)
    for (const h of this.handlers) h(msg)
  }

  send(msg: ClientMsg) {
    const data = JSON.stringify(msg)
    if (this.mode === 'poll') { this.outbox.push(data); this.flushPoll() }
    else if (this.worker) this.worker.postMessage({ kind: 'send', data })
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
    else this.outbox.push(data)
  }

  onMessage(handler: Handler) {
    this.handlers.push(handler)
  }

  disconnect() {
    this.stopped = true
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    if (this.upgradeTimer) clearInterval(this.upgradeTimer)
    if (this.worker) { this.worker.postMessage({ kind: 'close' }); this.worker.terminate(); this.worker = null }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.sid = ''
  }
}
