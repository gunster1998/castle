// Правила размещения зданий. Файл одинаковый в client/src и server/src — меняйте оба.
import type { Team, Building } from './types'

/** Зона базы, где команда может строить (координаты мира). */
export const BASE_ZONE: Record<Team, { x0: number; x1: number; y0: number; y1: number }> = {
  west: { x0: 110, x1: 590, y0: 195, y1: 660 },
  east: { x0: 1010, x1: 1490, y0: 195, y1: 660 },
}
/** Минимальное расстояние между центрами зданий. */
export const BUILDING_SPACING = 72
/** Здания не ставятся вплотную к замку. */
export const CASTLE_CLEARANCE = 115
const CASTLE_POS: Record<Team, { x: number; y: number }> = { west: { x: 60, y: 400 }, east: { x: 1540, y: 400 } }

export type PlaceCheck = { ok: true } | { ok: false; reason: string }

export function canPlace(team: Team, x: number, y: number, buildings: Pick<Building, 'x' | 'y'>[]): PlaceCheck {
  const z = BASE_ZONE[team]
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'Неверная точка' }
  if (x < z.x0 || x > z.x1 || y < z.y0 || y > z.y1) return { ok: false, reason: 'Стройте только на своей базе' }
  const c = CASTLE_POS[team]
  if (Math.hypot(x - c.x, y - c.y) < CASTLE_CLEARANCE) return { ok: false, reason: 'Слишком близко к замку' }
  for (const b of buildings) {
    if (Math.hypot(b.x - x, b.y - y) < BUILDING_SPACING) return { ok: false, reason: 'Место занято другим зданием' }
  }
  return { ok: true }
}
