// Правила размещения зданий. Файл одинаковый в client/src и server/src — меняйте оба.
import type { Team, Building } from './types'
import { WORLD_W, CASTLE_POS } from './world'

/** Зона базы, где команда может строить (координаты мира): почти во всю высоту поля, вдоль краёв тоже. */
export const BASE_ZONE: Record<Team, { x0: number; x1: number; y0: number; y1: number }> = {
  west: { x0: 140, x1: 820, y0: 110, y1: 1090 },
  east: { x0: WORLD_W - 820, x1: WORLD_W - 140, y0: 110, y1: 1090 },
}
/** Минимальное расстояние между центрами зданий. */
export const BUILDING_SPACING = 72
/** Здания не ставятся вплотную к замку. */
export const CASTLE_CLEARANCE = 115

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
