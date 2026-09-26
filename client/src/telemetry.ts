// Телеметрия производительности: что именно тормозит у игрока.
// Каждый кадр отрисовка сообщает, сколько заняли её участки. Долгие кадры записываются
// с разбивкой; раз в 30 с сводка уходит на сервер (logs/perf-*.log), сильные рывки — сразу.

export type Sections = Record<'sync' | 'units' | 'world' | 'fx' | 'overlay' | 'render', number>
export interface FrameCtx {
  units: number
  buildings: number
  particles: number
  calls: number
  quality: number
  /** Юнитов создано с нуля в этом кадре (не из запаса). */
  created: number
  /** Юнитов взято из запаса в этом кадре. */
  reused: number
  stateArrived: boolean
}

interface Hitch extends FrameCtx {
  at: number
  /** Интервал между кадрами, мс. */
  interval: number
  /** Время работы нашего кода в кадре, мс. */
  work: number
  sections: Sections
  /** Интервал большой, а наш код отработал быстро — значит браузер (видеокарта, сборка мусора, вкладка в фоне). */
  outside: boolean
}

const HITCH_MS = 100
const SEVERE_MS = 300
const REPORT_EVERY_MS = 30_000

let send: ((data: unknown) => void) | null = null
let context: () => Record<string, unknown> = () => ({})
let intervals: number[] = []
let hitches: Hitch[] = []
let longTasks = { count: 0, total: 0, max: 0 }
let lastReport = performance.now()
let lastSevere = 0
let deviceSent = false
let lastHitch: Hitch | null = null
let paused = 0

export function startTelemetry(sendFn: (data: unknown) => void, ctx: () => Record<string, unknown>) {
  send = sendFn
  context = ctx
  try {
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        longTasks.count++
        longTasks.total += e.duration
        longTasks.max = Math.max(longTasks.max, e.duration)
      }
    })
    po.observe({ type: 'longtask', buffered: false })
  } catch { /* longtask есть не во всех браузерах */ }
  // перед закрытием вкладки — отправить накопленное
  addEventListener('pagehide', () => report(true))
}

/** Вызывается отрисовкой каждый кадр. */
export function frame(interval: number, work: number, sections: Sections, ctx: FrameCtx) {
  if (document.hidden) return // во фоновой вкладке браузер сам тормозит кадры
  // окно свёрнуто или закрыто другим окном: браузер не рисовал секунды, а наш код не работал — это пауза, не рывок
  if (interval > 3000 && work < 200) { paused++; return }
  intervals.push(interval)
  if (interval > HITCH_MS || work > HITCH_MS / 2) {
    const h: Hitch = {
      at: Math.round(performance.now()), interval: Math.round(interval), work: +work.toFixed(1),
      sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, +v.toFixed(1)])) as Sections,
      outside: work < interval * 0.3, ...ctx,
    }
    hitches.push(h)
    lastHitch = h
    if (hitches.length > 200) hitches = hitches.slice(-100)
    if (interval > SEVERE_MS && performance.now() - lastSevere > 10_000) {
      lastSevere = performance.now()
      sendNow({ kind: 'severe', hitch: h, ...context() })
    }
  }
  if (performance.now() - lastReport > REPORT_EVERY_MS) report(false)
}

export function lastHitchInfo(): Hitch | null { return lastHitch }

function sendNow(data: Record<string, unknown>) {
  if (!send) return
  if (!deviceSent) { data.device = deviceInfo(); deviceSent = true }
  try { send(data) } catch { /* соединения нет — не страшно */ }
}

function report(final: boolean) {
  lastReport = performance.now()
  if (intervals.length < 30 && !final) return
  const sorted = [...intervals].sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)
  const worst = [...hitches].sort((a, b) => b.interval - a.interval).slice(0, 5)
  sendNow({
    kind: final ? 'final' : 'report',
    frames: sorted.length,
    fpsAvg: +(1000 / avg).toFixed(1),
    p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1), max: +(sorted.at(-1) ?? 0).toFixed(1),
    hitches: hitches.length,
    paused,
    hitchesOutside: hitches.filter(h => h.outside).length,
    longTasks: { count: longTasks.count, total: Math.round(longTasks.total), max: Math.round(longTasks.max) },
    worst,
    ...context(),
  })
  intervals = []
  hitches = []
  paused = 0
  longTasks = { count: 0, total: 0, max: 0 }
}

function deviceInfo() {
  let gpu = 'unknown'
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
  } catch { /* нет доступа */ }
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    ua: navigator.userAgent,
    gpu,
    cores: navigator.hardwareConcurrency,
    memoryGb: nav.deviceMemory,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    viewport: `${innerWidth}x${innerHeight}`,
  }
}
