// Замер тика комнаты при большом числе юнитов: npx tsx bench/tick.ts
import { GameRoom } from '../src/GameRoom'
import { UNIT_TYPES } from '../src/data'

const types = Object.keys(UNIT_TYPES)
for (const n of [200, 500, 1000, 2000]) {
  const room = new GameRoom('bench', 'bench', false, { changed() {} })
  const st = (room as unknown as { state: any }).state
  st.phase = 'playing'
  st.players = [{ id: 'a', team: 'west', race: 'human', gold: 0 }, { id: 'b', team: 'east', race: 'undead', gold: 0 }]
  st.units = Array.from({ length: n }, (_, i) => {
    const t = types[i % types.length]
    return { id: String(i), typeId: t, team: i % 2 ? 'west' : 'east', x: 300 + Math.random() * 1000, y: 250 + Math.random() * 300, hp: 1e9, maxHp: 1e9, attackCooldown: 0, level: 1 }
  })
  const tick = (room as unknown as { tickInner(): void }).tickInner.bind(room)
  for (let i = 0; i < 20; i++) tick() // прогрев JIT
  const times: number[] = []
  for (let i = 0; i < 100; i++) { const t0 = performance.now(); tick(); times.push(performance.now() - t0) }
  times.sort((a, b) => a - b)
  const json = JSON.stringify({ type: 'state', state: st })
  const t1 = performance.now(); for (let i = 0; i < 50; i++) JSON.parse(json); const parse = (performance.now() - t1) / 50
  console.log(`${String(n).padStart(4)} юнитов: тик ср. ${(times.reduce((a, b) => a + b) / times.length).toFixed(2)} мс, p95 ${times[95].toFixed(2)} мс (бюджет тика 50 мс) | JSON ${(json.length / 1024).toFixed(0)} КБ, разбор ${parse.toFixed(2)} мс`)
}
