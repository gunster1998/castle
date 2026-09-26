// Уведомления о важном в бою: ракета летит на базу, танки и летуны противника, замок под атакой.
// Всё выводится из разницы двух последних состояний — сервер ничего особого не шлёт.
import type { GameState, Team } from './types'
import { UNIT_TYPES, BUILDING_TYPES } from './data'
import { NUKE } from './strike'
import { CY } from './world'
import { sfx } from './sound'
import { describeConditions } from './weather'

const box = () => document.getElementById('notify')!
const lastAt = new Map<string, number>()
const seenUnits = new Set<string>()
const seenStrikes = new Set<string>()

function show(key: string, text: string, tone: 'danger' | 'warn' | 'good' = 'warn', gapMs = 20_000) {
  const now = performance.now()
  if (now - (lastAt.get(key) ?? -Infinity) < gapMs) return
  lastAt.set(key, now)
  const el = document.createElement('div')
  el.className = `note ${tone}`
  el.textContent = text
  box().prepend(el)
  while (box().children.length > 4) box().lastElementChild!.remove()
  setTimeout(() => el.classList.add('fade'), 5000)
  setTimeout(() => el.remove(), 5800)
  sfx(tone === 'danger' ? 'error' : tone === 'good' ? 'ok' : 'select')
}

/** Сообщение в ленту уведомлений (для меток союзников и прочего). */
export function note(text: string, tone: 'danger' | 'warn' | 'good' = 'warn') { show(`note-${text}`, text, tone, 800) }

const laneName = (y: number) => (y < CY - 130 ? 'верхней' : y > CY + 130 ? 'нижней' : 'центральной')

export function resetNotify() {
  seenUnits.clear()
  seenStrikes.clear()
  box().innerHTML = ''
}

/** Сравнить прошлое и новое состояние и сказать игроку, что важного случилось. */
export function notifyDiff(prev: GameState | null, next: GameState, myTeam: Team) {
  if (next.phase !== 'playing') return
  if (!prev || prev.round !== next.round || prev.roomId !== next.roomId) {
    resetNotify()
    for (const u of next.units) seenUnits.add(u.id)
    // погода раунда
    if (next.conditions && (next.conditions.night || next.conditions.rain)) show(`cond-${next.round}`, describeConditions(next.conditions), 'warn', 0)
    return
  }
  const enemy: Team = myTeam === 'west' ? 'east' : 'west'

  // «последний шанс»
  if (next.comeback?.[myTeam] && !prev.comeback?.[myTeam]) show('comeback', '☢ Команда проигрывает — всем по ядерной ракете! Клавиша R', 'good', 0)
  if (next.comeback?.[enemy] && !prev.comeback?.[enemy]) show('comeback-foe', '☢ Противник на грани — у каждого из них теперь есть ракета', 'danger', 0)

  // ракеты
  for (const st of next.strikes ?? []) {
    if (!st.nuke || seenStrikes.has(st.id)) continue
    seenStrikes.add(st.id)
    if (st.team === enemy) {
      const onBase = next.buildings.some(b => b.team === myTeam && Math.hypot(b.x - st.x, b.y - st.y) <= NUKE.radius)
      if (st.interceptAt !== undefined) show(`nuke-${st.id}`, '☢ Противник запустил ракету — наша ПВО её собьёт', 'good', 0)
      else show(`nuke-${st.id}`, onBase ? '☢ На вашу базу летит ядерная ракета! Сбить своей — X' : '☢ Противник запустил ядерную ракету! Сбить своей — X', 'danger', 0)
    } else if (st.interceptAt !== undefined) {
      show(`nuke-${st.id}`, 'Нашу ракету собьёт ПВО противника', 'warn', 0)
    }
  }

  // новые вражеские танки и летуны — с линией
  for (const u of next.units) {
    if (seenUnits.has(u.id)) continue
    seenUnits.add(u.id)
    if (u.team !== enemy) continue
    const t = UNIT_TYPES[u.typeId]
    if (t?.armored) show(`tank-${laneName(u.y)}`, `Танки противника на ${laneName(u.y)} линии`, 'warn')
    else if (t?.flying) show('flyers', 'Летуны противника! Против них — стрелки, башни и ПВО', 'warn', 30_000)
  }
  if (seenUnits.size > 5000) seenUnits.clear()

  // ополчение
  for (const p of next.players) {
    const was = prev.players.find(x => x.id === p.id)
    if (p.militiaUsed && was && !was.militiaUsed) show(`militia-${p.id}`, p.team === myTeam ? `🛡 ${p.name} вызвал ополчение!` : `🛡 Противник вызвал ополчение`, p.team === myTeam ? 'good' : 'warn', 0)
  }

  // замок под атакой
  if (next.castles[myTeam].hp < prev.castles[myTeam].hp - 5) show('castle', '🏰 Замок под атакой!', 'danger', 15_000)

  // потерянные башни (ракету сюда не считаем — о ней своё сообщение)
  const nowIds = new Set(next.buildings.map(b => b.id))
  const lost = prev.buildings.filter(b => b.team === myTeam && !nowIds.has(b.id))
  if (lost.length) {
    const towers = lost.filter(b => BUILDING_TYPES[b.typeId]?.tower).length
    if (lost.length > towers) show('razed', `Ракета снесла ваши здания: ${lost.length}`, 'danger', 3000)
    else show('tower', towers > 1 ? `Разрушены ваши башни: ${towers}` : 'Разрушена ваша башня', 'warn', 8000)
  }
}
