// Три линии боя: верхняя, центральная и нижняя. Воин идёт по линии своего здания:
// поставил казарму у верхнего края базы — её воины пойдут верхом. Файл одинаковый в client/src и server/src.
import type { Team } from './types'
import { WORLD_W, CY } from './world'

export const LANE_NAMES = ['верхняя', 'центральная', 'нижняя'] as const
/** Середина каждой линии между базами (y) — линии расходятся только на нейтральной полосе. */
export const LANE_Y = [230, CY, 970]
/** Где линия уходит от базы и возвращается к ней (x для западной стороны; у восточной — зеркально). */
const BEND_X = [880, WORLD_W - 880]

/** Линия по месту здания: верхняя треть базы — верхняя линия, нижняя — нижняя. */
export function laneFor(y: number): number {
  return y < CY - 130 ? 0 : y > CY + 130 ? 2 : 1
}

/** Точки пути до вражеского замка (сам замок — последняя цель, её здесь нет). */
export function lanePath(team: Team, lane: number): { x: number; y: number }[] {
  if (lane === 1) return []
  const y = LANE_Y[lane]
  const xs = team === 'west' ? BEND_X : [...BEND_X].reverse()
  return xs.map(x => ({ x, y }))
}
