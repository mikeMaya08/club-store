import { parse } from 'date-fns'

export const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

export const fromMin = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

interface Range {
  start: string
  end: string
}

/** 'HH:mm' strings compare correctly as text. */
export const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end

/** Local Date for a 'YYYY-MM-DD' + 'HH:mm' pair. */
export const at = (date: string, time: string) => parse(`${date} ${time}`, 'yyyy-MM-dd HH:mm', new Date())

export const hoursUntil = (date: string, time: string, now: Date) =>
  (at(date, time).getTime() - now.getTime()) / 3_600_000

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
