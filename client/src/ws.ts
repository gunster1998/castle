import type { ClientMsg, ServerMsg } from './types'

type Handler = (msg: ServerMsg) => void

/**
 * Соединение с сервером. По умолчанию работает через Web Worker (net.worker.ts):
 * сокет и разбор сообщений — в фоне, в главный поток приходит только свежее состояние.
 * Если воркеры недоступны — обычный WebSocket в главном потоке.
 */
export class GameWS {
  private handlers: Handler[] = []
  private worker: Worker | null = null
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private outbox: string[] = []
  public connected = false
  /** Сколько устаревших состояний пропущено (главный поток не успевал). */
  public droppedStates = 0

  constructor(private url: string) {}

  get usingWorker() { return !!this.worker }

  connect() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./net.worker.ts', import.meta.url), { type: 'module' })
        this.worker.onmessage = ev => this.fromWorker(ev.data)
        this.worker.onerror = e => {
          // воркер не поднялся (старый браузер, CSP) — работаем по-старому
          console.warn('Сетевой воркер недоступен, соединение в главном потоке', e.message)
          this.worker?.terminate()
          this.worker = null
          this.connectDirect()
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

  private fromWorker(m: { kind: string; msg?: ServerMsg; dropped?: number }) {
    switch (m.kind) {
      case 'open':
        this.connected = true
        break
      case 'closed':
        this.connected = false
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
    this.ws = new WebSocket(this.url)
    this.ws.onopen = () => {
      this.connected = true
      while (this.outbox.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.outbox.shift()!)
    }
    this.ws.onmessage = ev => {
      try {
        this.emit(JSON.parse(ev.data) as ServerMsg)
      } catch (e) {
        console.error('Bad server message', e)
      }
    }
    this.ws.onclose = () => {
      this.connected = false
      this.reconnectTimer = setTimeout(() => this.connectDirect(), 2000)
    }
  }

  private emit(msg: ServerMsg) {
    for (const h of this.handlers) h(msg)
  }

  send(msg: ClientMsg) {
    const data = JSON.stringify(msg)
    if (this.worker) this.worker.postMessage({ kind: 'send', data })
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
    else this.outbox.push(data)
  }

  onMessage(handler: Handler) {
    this.handlers.push(handler)
  }

  disconnect() {
    if (this.worker) { this.worker.postMessage({ kind: 'close' }); this.worker.terminate(); this.worker = null }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
