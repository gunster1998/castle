// Суперудар: один раз за раунд каждый игрок (и бот) может выжечь круг у своей базы —
// все вражеские воины в круге погибают. Файл одинаковый в client/src и server/src — меняйте оба.
import type { Team } from './types'
import { BASE_ZONE } from './placement'
import { WORLD_W, WORLD_H } from './world'

export const STRIKE = {
  /** Радиус круга (координаты мира): в поперечнике — больше половины базы. */
  radius: 260,
  /** Задержка между выбором места и ударом: противник видит метку. */
  delay: 30,
  /** Насколько центр может выходить за зону базы. */
  margin: 50,
}

export type StrikeCheck = { ok: true } | { ok: false; reason: string }

/** Центр удара — только на своей базе или рядом с ней. */
export function canStrike(team: Team, x: number, y: number): StrikeCheck {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'Неверная точка' }
  const z = BASE_ZONE[team], m = STRIKE.margin
  if (x < z.x0 - m || x > z.x1 + m || y < z.y0 - m || y > z.y1 + m) return { ok: false, reason: 'Суперудар — только рядом со своей базой' }
  return { ok: true }
}

/** Ядерная ракета: тоже один раз за раунд, но бьёт в любую точку карты — и по замку. */
export const NUKE = {
  radius: 220,
  /** Полёт ракеты от своего замка, тиков. */
  delay: 80,
  /** Доля прочности замка, которую снимает попадание (замок в круге). */
  castleDamage: 0.2,
}

export function canNuke(x: number, y: number): StrikeCheck {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > WORLD_W || y < 0 || y > WORLD_H) return { ok: false, reason: 'Цель за пределами поля' }
  return { ok: true }
}

/** Ракета за золото и сколько их можно держать в запасе. */
// в круг обычно попадает 8–12 зданий по ~180 — ракета сносит на 1500–2000 золота, плюс воины и 20% замка
export const NUKE_PRICE = 1500
export const NUKE_MAX = 3

/** Ауры замка: короткий, но очень сильный бафф всех войск команды. */
export const AURA = {
  /** Цена одного включения. */
  cost: 250,
  /** Сколько действует, тиков (20 в секунду); повторная покупка продлевает. */
  duration: 15 * 20,
  /** Дольше этого вперёд не накопить. */
  maxAhead: 45 * 20,
  /** «Сила»: множитель урона. */
  damageMult: 2,
  /** «Ярость»: множитель перезарядки удара (меньше — чаще). */
  speedMult: 0.5,
  names: { damage: 'Сила', speed: 'Ярость' } as const,
}

/** «Последний шанс»: замок команды ниже этой доли, а у соперника — на столько больше. */
export const COMEBACK = { ownBelow: 0.35, gap: 0.3 }

/** Ополчение: вызвать можно, когда у замка осталось меньше этой доли прочности; раз за раунд. */
export const MILITIA = { below: 0.3, count: 15 }
