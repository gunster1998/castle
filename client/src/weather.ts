// Погода и время суток: выбираются в начале раунда. Файл одинаковый в client/src и server/src — меняйте оба.

export interface Conditions { night: boolean; rain: boolean }

export const WEATHER = {
  /** Ночью стрелки, маги и башни видят хуже. */
  nightRange: 0.8,
  /** Ночью нежить сильнее. */
  nightUndeadDamage: 1.15,
  /** В дождь артиллерия стреляет реже… */
  rainArtilleryInterval: 1.4,
  /** …и едет медленнее. */
  rainArtillerySpeed: 0.8,
  chanceNight: 0.35,
  chanceRain: 0.3,
}

export const UNDEAD_UNITS = new Set(['ghoul', 'crypt_fiend', 'necromancer', 'abomination', 'bone_catapult', 'gargoyle', 'death_tank'])
export const isArtillery = (typeId: string, splash?: number) => !!splash || typeId === 'mortar'

export function rollConditions(): Conditions {
  return { night: Math.random() < WEATHER.chanceNight, rain: Math.random() < WEATHER.chanceRain }
}

/** Что сейчас действует — для игрока. */
export function describeConditions(c: Conditions | undefined): string {
  if (!c || (!c.night && !c.rain)) return 'Ясный день'
  const parts: string[] = []
  if (c.night) parts.push('🌙 Ночь: стрелки видят хуже, нежить сильнее')
  if (c.rain) parts.push('🌧 Дождь: артиллерия медленнее')
  return parts.join(' · ')
}
