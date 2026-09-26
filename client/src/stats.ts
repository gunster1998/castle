// Итоги раунда и матча: кто сколько убил, потерял, нанёс урона замку, построил и потратил.
import type { GameState, PlayerState, Team } from './types'

const $ = (id: string) => document.getElementById(id)!
const panel = () => $('stats')
let shownKey = ''
let closedKey = ''

/** Вклад игрока: по нему выбирается лучший игрок матча. */
const score = (p: PlayerState) => p.stats.kills + p.stats.castleDmg / 40 + p.stats.trained * 0.3

const COLS: [string, (p: PlayerState) => number, string?][] = [
  ['Убил', p => p.stats.kills],
  ['Потерял', p => p.stats.lost],
  ['Урон замку', p => p.stats.castleDmg],
  ['Нанял', p => p.stats.trained],
  ['Зданий', p => p.stats.built],
  ['Потратил', p => p.stats.spent, '🪙'],
  ['Башнями', p => p.stats.towerKills],
  ['Суперударом', p => p.stats.strikeKills],
]

function render(state: GameState, myId: string, myTeam: Team) {
  const end = state.phase === 'game_end'
  $('stats-title').textContent = end ? 'Итоги матча' : `Итоги после раунда ${state.round}`
  const { west, east } = state.wins
  const res = $('stats-result')
  res.innerHTML = ''
  const b = document.createElement('b')
  const winner: Team | null = end ? (west > east ? 'west' : east > west ? 'east' : null) : null
  if (end && winner) { b.className = winner === myTeam ? 'win' : 'lose'; b.textContent = winner === myTeam ? 'Победа' : 'Поражение' }
  res.append(b, document.createTextNode(`${end && winner ? ' · ' : ''}счёт по раундам: синие ${west} — красные ${east}`))

  const players = state.players.filter(p => p.stats)
  const mvp = players.length > 1 ? players.reduce((a, p) => (score(p) > score(a) ? p : a)) : null
  const table = $('stats-table')
  table.innerHTML = ''
  const head = document.createElement('tr')
  for (const h of ['Игрок', ...COLS.map(c => c[0])]) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th) }
  table.appendChild(head)
  // лучший в каждом столбце
  const best = COLS.map(([, f], i) => (i === 1 ? -1 : Math.max(0, ...players.map(f))))
  for (const team of ['west', 'east'] as Team[]) {
    const list = players.filter(p => p.team === team).sort((a, b) => score(b) - score(a))
    if (!list.length) continue
    for (const p of list) {
      const tr = document.createElement('tr')
      tr.className = `${team}${p.id === myId ? ' me' : ''}`
      const name = document.createElement('td')
      name.textContent = p.name + (p.id === myId ? ' (вы)' : '')
      if (p === mvp) { const m = document.createElement('span'); m.className = 'mvp'; m.textContent = '★ MVP'; name.appendChild(m) }
      tr.appendChild(name)
      COLS.forEach(([, f, unit], i) => {
        const td = document.createElement('td')
        const v = f(p)
        td.textContent = `${unit ?? ''}${v}`
        if (v > 0 && v === best[i]) td.className = 'best'
        tr.appendChild(td)
      })
      table.appendChild(tr)
    }
    if (list.length > 1) {
      const tr = document.createElement('tr')
      tr.className = `team-sum ${team}`
      const name = document.createElement('td')
      name.textContent = team === 'west' ? 'Синие, всего' : 'Красные, всего'
      tr.appendChild(name)
      for (const [, f, unit] of COLS) { const td = document.createElement('td'); td.textContent = `${unit ?? ''}${list.reduce((a, p) => a + f(p), 0)}`; tr.appendChild(td) }
      table.appendChild(tr)
    }
  }
}

/** Вызывается при каждом обновлении интерфейса: показывает итоги в конце раунда и матча. */
export function updateStats(state: GameState | null, myId: string, myTeam: Team) {
  const btn = $('stats-btn') as HTMLButtonElement
  const showable = !!state && (state.phase === 'round_end' || state.phase === 'game_end') && state.players.some(p => p.stats)
  btn.hidden = !showable || state?.phase !== 'game_end'
  if (!showable) { panel().hidden = true; shownKey = ''; return }
  const key = `${state!.roomId}:${state!.phase}:${state!.round}`
  if (key !== shownKey) {
    shownKey = key
    render(state!, myId, myTeam)
    panel().hidden = closedKey === key
  }
}

export function initStats() {
  $('stats-close').addEventListener('click', () => { panel().hidden = true; closedKey = shownKey })
  $('stats-btn').addEventListener('click', () => { panel().hidden = !panel().hidden; if (panel().hidden) closedKey = shownKey; else closedKey = '' })
}
