// Размеры мира и замки. Файл одинаковый в client/src и server/src — меняйте оба.
// Мир: x 0..WORLD_W (запад → восток), y 0..WORLD_H.

export const WORLD_W = 2600
export const WORLD_H = 1200
export const CX = WORLD_W / 2
export const CY = WORLD_H / 2
export const CASTLE_POS = { west: { x: 80, y: CY }, east: { x: WORLD_W - 80, y: CY } }
