// Чат: общий — в меню, свой — в комнате и в партии (там он поверх поля, открывается по Enter).
import type { ChatLine, ChatScope, ServerMsg } from './types'

const lines: Record<ChatScope, ChatLine[]> = { lobby: [], room: [] }
const KEEP = 60
/** В партии строки гаснут через столько мс (пока чат закрыт). */
const FADE_MS = 12_000

let sendText: (text: string) => void = () => {}
const boxes = () => [...document.querySelectorAll<HTMLElement>('.chat[data-scope]')]
const gameBox = () => document.getElementById('chat-game')!

const time = (at: number) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

function lineEl(l: ChatLine, scope: ChatScope, inGame: boolean): HTMLElement {
  const div = document.createElement('div')
  div.className = 'chat-line'
  if (!inGame) {
    const t = document.createElement('time')
    t.textContent = time(l.at)
    div.appendChild(t)
  }
  const who = document.createElement('b')
  who.className = scope === 'lobby' ? 'lobby' : (l.team ?? '')
  who.textContent = `${l.from}:`
  div.append(who, document.createTextNode(l.text))
  if (inGame) {
    // гаснет, потом убирается из виду; при открытом чате видна вся история
    const age = Date.now() - l.at
    if (age > FADE_MS + 700) div.classList.add('fade', 'old')
    else {
      setTimeout(() => div.classList.add('fade'), Math.max(0, FADE_MS - age))
      setTimeout(() => div.classList.add('old'), FADE_MS + 700 - age)
    }
  }
  return div
}

function fill(box: HTMLElement) {
  const scope = box.dataset.scope as ChatScope
  const log = box.querySelector<HTMLElement>('.chat-log')!
  const inGame = box.id === 'chat-game'
  log.innerHTML = ''
  const list = lines[scope]
  if (!list.length && !inGame) {
    const none = document.createElement('div')
    none.className = 'none'
    none.textContent = scope === 'lobby' ? 'Пока тихо. Напишите первым — вас увидят все в меню.' : 'Сообщения видят все в комнате.'
    log.appendChild(none)
  }
  for (const l of list) log.appendChild(lineEl(l, scope, inGame))
  log.scrollTop = log.scrollHeight
}

function append(scope: ChatScope, added: ChatLine[]) {
  for (const box of boxes()) {
    if (box.dataset.scope !== scope) continue
    const log = box.querySelector<HTMLElement>('.chat-log')!
    const inGame = box.id === 'chat-game'
    log.querySelector('.none')?.remove()
    for (const l of added) log.appendChild(lineEl(l, scope, inGame))
    while (log.children.length > KEEP) log.firstElementChild!.remove()
    log.scrollTop = log.scrollHeight
  }
}

export function onChat(msg: Extract<ServerMsg, { type: 'chat' }>) {
  const list = lines[msg.scope]
  if (msg.reset) {
    list.splice(0, list.length, ...msg.lines.slice(-KEEP))
    for (const box of boxes()) if (box.dataset.scope === msg.scope) fill(box)
    return
  }
  list.push(...msg.lines)
  if (list.length > KEEP) list.splice(0, list.length - KEEP)
  append(msg.scope, msg.lines)
}

/** Вышли из комнаты: её чат больше не нужен. */
export function clearRoomChat() {
  lines.room = []
  for (const box of boxes()) if (box.dataset.scope === 'room') fill(box)
}

function openGameChat() {
  const box = gameBox()
  const form = box.querySelector<HTMLFormElement>('.chat-form')!
  box.classList.add('open')
  form.hidden = false
  document.getElementById('chat-hint')!.hidden = true
  form.querySelector('input')!.focus()
  const log = box.querySelector<HTMLElement>('.chat-log')!
  log.scrollTop = log.scrollHeight
}
function closeGameChat() {
  const box = gameBox()
  const form = box.querySelector<HTMLFormElement>('.chat-form')!
  box.classList.remove('open')
  form.hidden = true
  document.getElementById('chat-hint')!.hidden = false
  form.querySelector('input')!.blur()
}

/** inGame — открыт ли сейчас экран партии (там чат открывается по Enter). */
export function initChat(send: (text: string) => void, inGame: () => boolean) {
  sendText = send
  for (const box of boxes()) {
    fill(box)
    const form = box.querySelector<HTMLFormElement>('.chat-form')!
    const input = form.querySelector('input')!
    form.addEventListener('submit', e => {
      e.preventDefault()
      const text = input.value.trim()
      if (text) sendText(text)
      input.value = ''
      if (box.id === 'chat-game') closeGameChat()
    })
    if (box.id === 'chat-game') {
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; closeGameChat() }
      })
      input.addEventListener('blur', () => { if (!input.value.trim()) closeGameChat() })
    }
  }
  window.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !inGame()) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
    e.preventDefault()
    openGameChat()
  })
}
