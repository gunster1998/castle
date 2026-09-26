import type { ClientMsg, ServerMsg } from './types'

type Handler = (msg: ServerMsg) => void

export class GameWS {
  private ws: WebSocket | null = null
  private handlers: Handler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string
  public connected = false

  constructor(url: string) {
    this.url = url
  }

  connect() {
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.connected = true
      console.log('Connected to server')
    }

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg
        for (const h of this.handlers) h(msg)
      } catch (e) {
        console.error('Bad server message', e)
      }
    }

    this.ws.onclose = () => {
      this.connected = false
      console.log('Disconnected — reconnecting in 2s...')
      this.reconnectTimer = setTimeout(() => this.connect(), 2000)
    }

    this.ws.onerror = (e) => {
      console.error('WS error', e)
    }
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  onMessage(handler: Handler) {
    this.handlers.push(handler)
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
