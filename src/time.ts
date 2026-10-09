import { parse } from 'date-fns'

/** 'HH:mm' to minutes since midnight, e.g. '07:30' -> 450. */
export const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** Minutes since midnight to 'HH:mm' (inverse of `toMin`). */
export const fromMin = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** A half-open time range on one day: it includes `start` but not `end`. */
interface Range {
  start: string
  end: string
}

/**
 * True when two ranges share some time. Ranges that merely touch (one ends when the other starts)
 * do NOT overlap. 'HH:mm' strings compare correctly as text.
 */
export const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end

/** Local Date for a 'YYYY-MM-DD' + 'HH:mm' pair. */
export const at = (date: string, time: string) => parse(`${date} ${time}`, 'yyyy-MM-dd HH:mm', new Date())

/** Hours from `now` until the given moment; negative when it is already in the past. */
export const hoursUntil = (date: string, time: string, now: Date) =>
  (at(date, time).getTime() - now.getTime()) / 3_600_000

/** One bookable slot of the day, e.g. { start: '18:00', end: '19:00' }. */
export interface Slot {
  start: string
  end: string
}

/** All bookable slots of a day for the given settings. */
export function slotsFor(s: { openHour: number; closeHour: number; slotMinutes: number }): Slot[] {
  const slots: Slot[] = []
  for (let m = s.openHour * 60; m + s.slotMinutes <= s.closeHour * 60; m += s.slotMinutes) {
    slots.push({ start: fromMin(m), end: fromMin(m + s.slotMinutes) })
  }
  return slots
}
