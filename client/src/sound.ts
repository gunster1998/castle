// Звуки: Web Audio, файлы из public/sfx (Kenney, CC0; собираются scripts/build-sounds.mjs).
// Браузер разрешает звук только после первого клика или нажатия клавиши — до этого всё молчит.

const FILES: Record<string, number> = {
  hit_metal: 3, hit_punch: 3, hit_soft: 3, death: 3, magic: 2, dark: 1, boom: 3, bigboom: 1, charge: 1,
  build: 2, upgrade: 1, castle: 2, click: 1, select: 1, error: 1, ok: 1, chat: 1, back: 1, start: 1, win: 1, lose: 1,
}
/** Громкость каждого вида (файлы Kenney разной громкости). */
const LEVEL: Record<string, number> = {
  hit_metal: 0.35, hit_punch: 0.4, hit_soft: 0.3, death: 0.35, magic: 0.25, dark: 0.3, boom: 0.5, bigboom: 1, charge: 0.6,
  build: 0.6, upgrade: 0.7, castle: 0.55, click: 0.4, select: 0.4, error: 0.5, ok: 0.5, chat: 0.45, back: 0.4,
  start: 0.6, win: 0.7, lose: 0.7, bow: 0.22,
}
/** Не чаще раза в столько мс для одного вида: в большом бою иначе каша. */
const GAP: Record<string, number> = { hit_metal: 70, hit_punch: 70, hit_soft: 60, death: 90, bow: 50, magic: 120, dark: 120, boom: 90, castle: 150 }
const MAX_VOICES = 14

let ctx: AudioContext | null = null
let master: GainNode | null = null
const buffers = new Map<string, AudioBuffer[]>()
const lastAt = new Map<string, number>()
let voices = 0
let volume = 0.7
let muted = false
let noise: AudioBuffer | null = null
try {
  volume = Number(localStorage.getItem('cf.volume') ?? 0.7)
  muted = localStorage.getItem('cf.muted') === '1'
} catch { /* приватный режим */ }

function ensure(): AudioContext | null {
  if (ctx) return ctx
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  master = ctx.createGain()
  master.gain.value = muted ? 0 : volume
  master.connect(ctx.destination)
  void loadAll(ctx)
  return ctx
}

async function loadAll(c: AudioContext) {
  const base = `${import.meta.env.BASE_URL}sfx/`
  await Promise.all(Object.entries(FILES).map(async ([name, n]) => {
    const list: AudioBuffer[] = []
    for (let i = 0; i < n; i++) {
      try {
        const res = await fetch(`${base}${name}_${i}.mp3`)
        list.push(await c.decodeAudioData(await res.arrayBuffer()))
      } catch { /* нет файла — без этого звука */ }
    }
    buffers.set(name, list)
  }))
  // шум для синтезированного свиста стрелы
  noise = c.createBuffer(1, c.sampleRate * 0.3, c.sampleRate)
  const d = noise.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
}

/** Первое действие игрока: создать и «разбудить» звук. */
export function initSound() {
  const unlock = () => { const c = ensure(); if (c?.state === 'suspended') void c.resume() }
  addEventListener('pointerdown', unlock, { capture: true })
  addEventListener('keydown', unlock, { capture: true })
}

export interface PlayOpts {
  /** 0..1 — дополнительная громкость (например, по расстоянию). */
  gain?: number
  /** Стерео: -1 слева … 1 справа. */
  pan?: number
  /** Скорость/высота. */
  rate?: number
}

/** Сыграть звук вида name (случайный из вариантов). */
export function sfx(name: string, opts: PlayOpts = {}) {
  const c = ctx
  if (!c || !master || muted || c.state !== 'running') return
  const now = performance.now()
  const gap = GAP[name] ?? 0
  if (gap && now - (lastAt.get(name) ?? 0) < gap) return
  if (voices >= MAX_VOICES && !['bigboom', 'win', 'lose', 'start', 'charge', 'error', 'click', 'select', 'ok'].includes(name)) return
  lastAt.set(name, now)
  const g = c.createGain()
  g.gain.value = (LEVEL[name] ?? 0.5) * (opts.gain ?? 1)
  let out: AudioNode = g
  if (opts.pan && c.createStereoPanner) {
    const p = c.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, opts.pan))
    g.connect(p)
    out = p
  }
  out.connect(master)
  let src: AudioScheduledSourceNode
  if (name === 'bow') {
    // свист стрелы: короткий шум, полоса частот скользит вниз
    if (!noise) return
    const s = c.createBufferSource()
    s.buffer = noise
    const f = c.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 2.5
    const t = c.currentTime
    const r = opts.rate ?? 1
    f.frequency.setValueAtTime(2600 * r, t)
    f.frequency.exponentialRampToValueAtTime(700 * r, t + 0.16)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime((LEVEL.bow) * (opts.gain ?? 1), t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    s.connect(f)
    f.connect(g)
    s.start(t)
    s.stop(t + 0.22)
    src = s
  } else {
    const list = buffers.get(name)
    if (!list?.length) return
    const s = c.createBufferSource()
    s.buffer = list[Math.floor(Math.random() * list.length)]
    // немного разной высоты — одинаковые удары не звучат как пулемёт
    s.playbackRate.value = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12)
    s.connect(g)
    s.start()
    src = s
  }
  voices++
  src.onended = () => { voices--; g.disconnect(); out.disconnect() }
}

export function isMuted() { return muted }
export function setMuted(m: boolean) {
  muted = m
  if (master) master.gain.value = muted ? 0 : volume
  try { localStorage.setItem('cf.muted', m ? '1' : '0') } catch { /* приватный режим */ }
}
