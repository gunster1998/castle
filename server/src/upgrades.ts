// Улучшения зданий. Файл одинаковый в client/src и server/src — меняйте оба.

export const MAX_LEVEL = 3

/** Цена перехода с уровня level на level+1. */
export function upgradeCost(baseCost: number, level: number): number {
  return Math.round(baseCost * (level === 1 ? 0.75 : 1.1))
}
/** Множитель здоровья и урона воинов. */
export const unitMult = (level: number) => 1 + 0.25 * (level - 1)
/** Множитель времени найма (меньше — быстрее). */
export const spawnMult = (level: number) => 1 - 0.1 * (level - 1)
/** Множитель прочности здания. */
export const buildingHpMult = (level: number) => 1 + 0.3 * (level - 1)
/** Радиус здания: для дальности атаки по нему. */
export const BUILDING_RADIUS = 30
