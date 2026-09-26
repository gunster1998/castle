// Сетевой поток: WebSocket, переподключение и разбор сообщений вне главного потока.
// Состояния партии отдаются «по готовности»: пока главный поток не подтвердил предыдущее,
// новые не копятся в очереди — хранится только самое свежее.
/// <reference lib="webworker" />
import { unpackState, type ServerMsg } from './types'

type In =
  | { kind: 'connect'; url: string }
  | { kind: 'send'; data: string }
  | { kind: 'ack' }
  | { kind: 'close' }
  | { kind: 'status' }

type Out =
  | { kind: 'open' }
  | { kind: 'closed'; code: number }
  | { kind: 'msg'; msg: ServerMsg }
  | { kind: 'state'; msg: ServerMsg; dropped: number }
  | { kind: 'status'; open: boolean }

const post = (m: Out) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

let ws: WebSocket | null = null
let url = ''
let closing = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const outbox: string[] = []

// состояние, ожидающее отправки в главный поток
let pending: ServerMsg | null = null
let dropped = 0
let waitingAck = false

function flushState() {
  if (waitingAck || !pending) return
  post({ kind: 'state', msg: pending, dropped })
  pending = null
  dropped = 0
  waitingAck = true
}

function connect() {
  ws = new WebSocket(url)
  ws.onopen = () => {
    post({ kind: 'open' })
    while (outbox.length && ws?.readyState === WebSocket.OPEN) ws.send(outbox.shift()!)
  }
  ws.onmessage = ev => {
    let msg: ServerMsg
    try {
      msg = JSON.parse(ev.data as string) as ServerMsg
    } catch {
      return
    }
    if (msg.type === 'state') {
      unpackState(msg.state)
      if (pending) dropped++
      pending = msg
      flushState()
    } else {
      // порядок важен: сначала отдать ожидающее состояние (например, перед сменой комнаты)
      if (pending && !waitingAck) flushState()
      post({ kind: 'msg', msg })
    }
  }
  ws.onclose = ev => {
    post({ kind: 'closed', code: ev.code })
    pending = null
    waitingAck = false
    // 4000 — игру забрала другая вкладка: не переподключаемся
    if (!closing && ev.code !== 4000) reconnectTimer = setTimeout(connect, 2000)
  }
}

self.onmessage = (ev: MessageEvent<In>) => {
  const m = ev.data
  switch (m.kind) {
    case 'connect':
      url = m.url
      closing = false
      connect()
      break
    case 'send':
      if (ws?.readyState === WebSocket.OPEN) ws.send(m.data)
      else outbox.push(m.data)
      break
    case 'ack':
      waitingAck = false
      flushState()
      break
    case 'status':
      post({ kind: 'status', open: ws?.readyState === WebSocket.OPEN })
      break
    case 'close':
      closing = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      break
  }
}
