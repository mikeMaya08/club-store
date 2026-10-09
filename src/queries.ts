import { at, fromMin, overlaps, toMin } from './time'
import type { Block, ClubEvent, EventType, Lesson, Reservation, State } from './types'

export interface SlotQuery {
  courtId: string
  date: string
  start: string
  end: string
}

export interface Conflicts {
  reservations: Reservation[]
  /** Blocks that are not tied to a lesson (maintenance, tournament). */
  blocks: Block[]
  lessons: Lesson[]
}

/** Everything that already occupies this court/time. Cancelled items never conflict. */
export function findConflicts(
  s: State,
  q: SlotQuery,
  ignore: { blockId?: string; lessonId?: string; reservationId?: string } = {},
): Conflicts {
  const same = (x: { courtId: string; date: string; start: string; end: string }) =>
    x.courtId === q.courtId && x.date === q.date && overlaps(x, q)
  return {
    reservations: s.reservations.filter((r) => r.status !== 'cancelled' && r.id !== ignore.reservationId && same(r)),
    blocks: s.blocks.filter((b) => !b.lessonId && b.id !== ignore.blockId && same(b)),
    lessons: s.lessons.filter((l) => l.status !== 'cancelled' && l.id !== ignore.lessonId && same(l)),
  }
}

export const hasConflicts = (c: Conflicts) => c.reservations.length + c.blocks.length + c.lessons.length > 0

export const isFutureReservation = (r: Reservation, now: Date) => at(r.date, r.start) > now

/** Future booked reservations of a player. A weekly series counts as ONE. */
export const activeReservationCount = (s: State, playerId: string, now: Date) =>
  new Set(
    s.reservations
      .filter((r) => r.playerId === playerId && r.status === 'booked' && isFutureReservation(r, now))
      .map((r) => r.seriesId ?? r.id),
  ).size

export type SlotStatus = 'available' | 'taken' | 'blocked' | 'lesson' | 'no-lights' | 'past' | 'inactive'

/** What a single grid cell should look like. */
export function slotStatus(s: State, courtId: string, date: string, start: string, now: Date): SlotStatus {
  const court = s.courts.find((c) => c.id === courtId)
  if (!court || !court.active) return 'inactive'
  if (at(date, start) <= now) return 'past'
  const end = fromMin(toMin(start) + s.settings.slotMinutes)
  const conflicts = findConflicts(s, { courtId, date, start, end })
  if (conflicts.lessons.length) return 'lesson'
  if (conflicts.blocks.length) return 'blocked'
  if (conflicts.reservations.length) return 'taken'
  if (!court.lights && start >= s.settings.lightsRequiredFrom) return 'no-lights'
  return 'available'
}

export const unreadCount = (s: State, userId: string) =>
  s.notifications.filter((n) => n.userId === userId && !n.read).length

export interface EventFilter {
  types?: EventType[]
  /** Only events done by this user. */
  actorId?: string
  /** Events done by OR affecting this user. */
  involvingUserId?: string
  entity?: ClubEvent['entity']
  /** 'YYYY-MM-DD', inclusive, compared with the day of `createdAt`. */
  from?: string
  to?: string
}

/** Filters the activity log. The result is newest first. */
export function filterEvents(events: ClubEvent[], f: EventFilter = {}): ClubEvent[] {
  return events
    .filter(
      (e) =>
        (!f.types?.length || f.types.includes(e.type)) &&
        (!f.actorId || e.actorId === f.actorId) &&
        (!f.involvingUserId || e.actorId === f.involvingUserId || e.subjectId === f.involvingUserId) &&
        (!f.entity || e.entity === f.entity) &&
        (!f.from || e.createdAt.slice(0, 10) >= f.from) &&
        (!f.to || e.createdAt.slice(0, 10) <= f.to),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true }))
}
