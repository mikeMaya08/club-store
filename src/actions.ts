import { clock } from './clock'
import { hasBug } from './config'
import { RuleError } from './errors'
import { chargedPrice } from './pricing'
import { activeReservationCount, findConflicts, hasConflicts, isFutureReservation } from './queries'
import { settingsSchema } from './schema'
import { commit } from './store'
import { at, fromMin, hoursUntil, overlaps, slotsFor, toMin } from './time'
import { addDays, format, parseISO } from 'date-fns'
import { lessonTemplateSchema } from './schema'
import type { Block, Court, Lesson, LessonTemplate, Note, Reservation, Role, Settings, State, User } from './types'

// ---------- helpers (all operate on the draft state inside commit) ----------

function nextId(prefix: string, items: { id: string }[]) {
  let max = 0
  for (const item of items) {
    const n = Number(item.id.slice(prefix.length + 1))
    if (item.id.startsWith(`${prefix}-`) && Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}-${max + 1}`
}

function notify(s: State, userId: string, type: string, message: string) {
  s.notifications.push({
    id: nextId('notif', s.notifications),
    userId,
    type,
    message,
    read: false,
    createdAt: clock.now().toISOString(),
  })
}

function getUser(s: State, id: string): User {
  const u = s.users.find((x) => x.id === id)
  if (!u) throw new RuleError('NOT_FOUND', `User ${id} not found.`)
  return u
}

/** Rule 7: inactive users can't act. */
function getActiveUser(s: State, id: string): User {
  const u = getUser(s, id)
  if (!u.active) throw new RuleError('USER_INACTIVE')
  return u
}

function getCourt(s: State, id: string): Court {
  const c = s.courts.find((x) => x.id === id)
  if (!c) throw new RuleError('NOT_FOUND', `Court ${id} not found.`)
  return c
}

const courtName = (s: State, id: string) => s.courts.find((c) => c.id === id)?.name ?? id

/** Rule 2: from `lightsRequiredFrom` on, only courts with lights. */
function assertLights(s: State, court: Court, start: string) {
  if (!court.lights && start >= s.settings.lightsRequiredFrom) throw new RuleError('NO_LIGHTS')
}

function assertTimeRange(start: string, end: string) {
  if (toMin(end) <= toMin(start)) throw new RuleError('INVALID_SLOT', 'The end time must be after the start time.')
}

/** Rule 8: cancel booked reservations that overlap a block and tell the players. */
function cancelOverlapping(s: State, b: { courtId: string; date: string; start: string; end: string }) {
  for (const r of s.reservations) {
    if (r.status === 'booked' && r.courtId === b.courtId && r.date === b.date && overlaps(r, b)) {
      r.status = 'cancelled'
      r.cancelReason = 'blocked by club'
      notify(
        s,
        r.playerId,
        'reservation-cancelled',
        `Your reservation on ${courtName(s, r.courtId)} (${r.date} ${r.start}) was cancelled: blocked by club.`,
      )
    }
  }
}

function cancelFutureReservations(s: State, playerId: string, reason: string) {
  const now = clock.now()
  for (const r of s.reservations) {
    if (r.playerId === playerId && r.status === 'booked' && isFutureReservation(r, now)) {
      r.status = 'cancelled'
      r.cancelReason = reason
    }
  }
}

// ---------- reservations ----------

export interface BookInput {
  courtId: string
  playerId: string
  date: string
  start: string
  partnerId?: string
}

/** Validates one booking against the rules and adds it. Used by single and recurring bookings. */
function bookOne(
  s: State,
  input: BookInput,
  opts: { seriesId?: string; checkLimit?: boolean; notifyPartner?: boolean } = {},
): Reservation {
  const now = clock.now()
  getActiveUser(s, input.playerId)
  const court = getCourt(s, input.courtId)
  if (!court.active) throw new RuleError('COURT_INACTIVE') // rule 7

  const slot = slotsFor(s.settings).find((x) => x.start === input.start) // rule 1
  if (!slot) throw new RuleError('INVALID_SLOT')
  if (at(input.date, slot.start) <= now) throw new RuleError('INVALID_SLOT', 'That slot is in the past.')

  assertLights(s, court, slot.start) // rule 2
  if ((opts.checkLimit ?? true) && activeReservationCount(s, input.playerId, now) >= s.settings.maxActiveReservations) {
    throw new RuleError('MAX_ACTIVE') // rule 3
  }
  const query = { courtId: input.courtId, date: input.date, start: slot.start, end: slot.end }
  if (!hasBug('double-booking') && hasConflicts(findConflicts(s, query))) throw new RuleError('SLOT_TAKEN') // rule 4

  if (input.partnerId) {
    if (input.partnerId === input.playerId) throw new RuleError('VALIDATION', 'You cannot be your own partner.')
    getActiveUser(s, input.partnerId)
  }
  const reservation: Reservation = {
    id: nextId('res', s.reservations),
    ...query,
    playerId: input.playerId,
    partnerId: input.partnerId,
    seriesId: opts.seriesId,
    status: 'booked',
    price: chargedPrice(s.settings, slot.start), // rule 6
    createdAt: now.toISOString(),
  }
  s.reservations.push(reservation)
  if (input.partnerId && (opts.notifyPartner ?? true)) {
    const who = getUser(s, input.playerId).name
    const series = opts.seriesId ? ' (weekly series)' : ''
    notify(s, input.partnerId, 'partner-added', `${who} added you as a partner on ${reservation.date} at ${reservation.start}${series}.`)
  }
  return reservation
}

function bookReservation(input: BookInput): Reservation {
  return commit((s) => bookOne(s, input))
}

export interface RecurringInput extends BookInput {
  /** Number of weekly occurrences, including the first one (2 to 8). */
  weeks: number
}

/**
 * Books the same slot every week. It is all-or-nothing: if any week breaks a rule, nothing is booked
 * and the error names the date. The whole series counts as ONE active reservation (rule 3).
 */
function bookRecurring(input: RecurringInput): Reservation[] {
  return commit((s) => {
    if (!Number.isInteger(input.weeks) || input.weeks < 2 || input.weeks > 8) {
      throw new RuleError('VALIDATION', 'A weekly series needs between 2 and 8 weeks.')
    }
    let max = 0
    for (const r of s.reservations) max = Math.max(max, Number(r.seriesId?.slice('series-'.length)) || 0)
    const seriesId = `series-${max + 1}`
    const created: Reservation[] = []
    for (let i = 0; i < input.weeks; i++) {
      const date = format(addDays(parseISO(input.date), 7 * i), 'yyyy-MM-dd')
      try {
        created.push(bookOne(s, { ...input, date }, { seriesId, checkLimit: i === 0, notifyPartner: i === 0 }))
      } catch (e) {
        if (e instanceof RuleError) throw new RuleError(e.code, `Week of ${date}: ${e.message}`)
        throw e
      }
    }
    return created
  })
}

/** Cancels every future occurrence of a series that is still outside the cancellation window. */
function cancelSeries(seriesId: string, actorId: string, opts: { force?: boolean } = {}): { cancelled: number; skipped: number } {
  return commit((s) => {
    const actor = getActiveUser(s, actorId)
    const now = clock.now()
    const future = s.reservations.filter((r) => r.seriesId === seriesId && r.status === 'booked' && isFutureReservation(r, now))
    if (future.length === 0) throw new RuleError('NOT_FOUND', 'That series has no upcoming reservations.')
    if (actor.role === 'player' && future.some((r) => r.playerId !== actor.id)) {
      throw new RuleError('INVALID_STATE', 'You can only cancel your own reservations.')
    }
    const bypass = (actor.role === 'admin' && opts.force) || hasBug('cancel-anytime')
    let cancelled = 0
    for (const r of future) {
      if (!bypass && hoursUntil(r.date, r.start, now) < s.settings.cancelHoursLimit) continue
      r.status = 'cancelled'
      r.cancelReason = actor.role === 'admin' ? 'cancelled by club' : 'cancelled by player'
      cancelled++
    }
    if (cancelled === 0) throw new RuleError('CANCEL_TOO_LATE')
    return { cancelled, skipped: future.length - cancelled }
  })
}

/** Admin: moves a booked reservation to another court / day / slot. Price follows the new slot. */
function moveReservation(id: string, to: { courtId?: string; date?: string; start?: string }, actorId: string): Reservation {
  return commit((s) => {
    const actor = getActiveUser(s, actorId)
    if (actor.role !== 'admin') throw new RuleError('INVALID_STATE', 'Only admins can move reservations.')
    const r = s.reservations.find((x) => x.id === id)
    if (!r) throw new RuleError('NOT_FOUND', 'Reservation not found.')
    if (r.status !== 'booked') throw new RuleError('INVALID_STATE', 'Only booked reservations can be moved.')

    const next = { courtId: to.courtId ?? r.courtId, date: to.date ?? r.date, start: to.start ?? r.start }
    const court = getCourt(s, next.courtId)
    if (!court.active) throw new RuleError('COURT_INACTIVE')
    const slot = slotsFor(s.settings).find((x) => x.start === next.start)
    if (!slot) throw new RuleError('INVALID_SLOT')
    if (at(next.date, slot.start) <= clock.now()) throw new RuleError('INVALID_SLOT', 'That slot is in the past.')
    assertLights(s, court, slot.start)
    const query = { courtId: next.courtId, date: next.date, start: slot.start, end: slot.end }
    if (!hasBug('double-booking') && hasConflicts(findConflicts(s, query, { reservationId: id }))) throw new RuleError('SLOT_TAKEN')

    Object.assign(r, query, { price: chargedPrice(s.settings, slot.start) })
    notify(s, r.playerId, 'reservation-moved', `Your reservation was moved to ${courtName(s, r.courtId)} on ${r.date} at ${r.start}.`)
    return r
  })
}

function cancelReservation(id: string, actorId: string, opts: { force?: boolean; reason?: string } = {}): Reservation {
  return commit((s) => {
    const actor = getActiveUser(s, actorId)
    const r = s.reservations.find((x) => x.id === id)
    if (!r) throw new RuleError('NOT_FOUND', 'Reservation not found.')
    if (r.status !== 'booked') throw new RuleError('INVALID_STATE', 'Only booked reservations can be cancelled.')
    if (actor.role === 'player' && r.playerId !== actor.id && r.partnerId !== actor.id) {
      throw new RuleError('INVALID_STATE', 'You can only cancel your own reservations.')
    }
    const bypass = actor.role === 'admin' && opts.force
    if (!bypass && !hasBug('cancel-anytime') && hoursUntil(r.date, r.start, clock.now()) < s.settings.cancelHoursLimit) {
      throw new RuleError('CANCEL_TOO_LATE', `Reservations can only be cancelled ${s.settings.cancelHoursLimit} hours before they start.`) // rule 5
    }
    r.status = 'cancelled'
    r.cancelReason = opts.reason ?? (actor.role === 'admin' ? 'cancelled by club' : 'cancelled by player')
    if (actor.role === 'admin') {
      notify(s, r.playerId, 'reservation-cancelled', `Your reservation on ${courtName(s, r.courtId)} (${r.date} ${r.start}) was cancelled by the club.`)
    }
    return r
  })
}

function markNoShow(id: string, actorId: string): Reservation {
  return commit((s) => {
    getActiveUser(s, actorId)
    const r = s.reservations.find((x) => x.id === id)
    if (!r) throw new RuleError('NOT_FOUND', 'Reservation not found.')
    if (r.status !== 'booked') throw new RuleError('INVALID_STATE', 'Only booked reservations can be marked as no-show.')
    r.status = 'no-show'
    return r
  })
}

// ---------- blocks ----------

export interface BlockInput {
  courtId: string
  date: string
  start: string
  end: string
  reason: Block['reason']
  createdBy: string
}

function assertBlockFree(s: State, q: { courtId: string; date: string; start: string; end: string }, ignoreBlockId?: string) {
  const c = findConflicts(s, q, { blockId: ignoreBlockId })
  if (c.blocks.length || c.lessons.length) throw new RuleError('SLOT_TAKEN', 'That time overlaps another block or lesson.')
}

function createBlock(input: BlockInput): Block {
  return commit((s) => {
    getActiveUser(s, input.createdBy)
    getCourt(s, input.courtId)
    assertTimeRange(input.start, input.end)
    if (input.reason === 'lesson') throw new RuleError('INVALID_STATE', 'Lesson blocks are created with the lesson.')
    assertBlockFree(s, input)
    const block: Block = { id: nextId('block', s.blocks), ...input }
    s.blocks.push(block)
    cancelOverlapping(s, block) // rule 8
    return block
  })
}

function moveBlock(id: string, to: { courtId?: string; date?: string; start?: string; end?: string }): Block {
  return commit((s) => {
    const block = s.blocks.find((b) => b.id === id)
    if (!block) throw new RuleError('NOT_FOUND', 'Block not found.')
    if (block.lessonId) throw new RuleError('INVALID_STATE', 'Lesson blocks move with their lesson.')
    const next = { courtId: block.courtId, date: block.date, start: block.start, end: block.end, ...to }
    getCourt(s, next.courtId)
    assertTimeRange(next.start, next.end)
    assertBlockFree(s, next, id)
    Object.assign(block, next)
    cancelOverlapping(s, block)
    return block
  })
}

function deleteBlock(id: string): void {
  commit((s) => {
    const block = s.blocks.find((b) => b.id === id)
    if (!block) throw new RuleError('NOT_FOUND', 'Block not found.')
    if (block.lessonId) throw new RuleError('INVALID_STATE', 'Cancel the lesson to remove its block.')
    s.blocks = s.blocks.filter((b) => b.id !== id)
  })
}

// ---------- lessons ----------

/** Fills free seats from the waitlist, in order, skipping players who are no longer active. */
function promoteFromWaitlist(s: State, lesson: Lesson) {
  while (lesson.studentIds.length < lesson.capacity && lesson.waitlist.length > 0) {
    const id = lesson.waitlist.shift()!
    if (!s.users.find((u) => u.id === id)?.active) continue
    lesson.studentIds.push(id)
    notify(s, id, 'waitlist-promoted', `A seat opened up: you are now enrolled in ${lesson.title}.`)
  }
}

export interface LessonInput {
  coachId: string
  courtId: string
  date: string
  start: string
  end: string
  title: string
  capacity: number
}

function createLesson(input: LessonInput): Lesson {
  return commit((s) => {
    const coach = getActiveUser(s, input.coachId)
    if (coach.role !== 'coach') throw new RuleError('INVALID_STATE', 'Only coaches can create lessons.')
    const court = getCourt(s, input.courtId)
    if (!court.active) throw new RuleError('COURT_INACTIVE')
    assertTimeRange(input.start, input.end)
    if (toMin(input.start) < s.settings.openHour * 60 || toMin(input.end) > s.settings.closeHour * 60) {
      throw new RuleError('INVALID_SLOT', 'Lessons must fit inside opening hours.')
    }
    assertLights(s, court, input.start)
    if (!hasBug('double-booking') && hasConflicts(findConflicts(s, input))) throw new RuleError('SLOT_TAKEN')

    const lesson: Lesson = { id: nextId('lesson', s.lessons), ...input, studentIds: [], status: 'scheduled', attendance: {}, waitlist: [] }
    s.lessons.push(lesson)
    // rule 9: every lesson owns a block with reason 'lesson'
    s.blocks.push({
      id: nextId('block', s.blocks),
      courtId: lesson.courtId,
      date: lesson.date,
      start: lesson.start,
      end: lesson.end,
      reason: 'lesson',
      lessonId: lesson.id,
      createdBy: lesson.coachId,
    })
    return lesson
  })
}

function cancelLesson(id: string, actorId: string): Lesson {
  return commit((s) => {
    getActiveUser(s, actorId)
    const lesson = s.lessons.find((l) => l.id === id)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (lesson.status !== 'scheduled') throw new RuleError('INVALID_STATE', 'Only scheduled lessons can be cancelled.')
    lesson.status = 'cancelled'
    s.blocks = s.blocks.filter((b) => b.lessonId !== id)
    for (const studentId of [...lesson.studentIds, ...lesson.waitlist]) {
      notify(s, studentId, 'lesson-cancelled', `The lesson "${lesson.title}" on ${lesson.date} was cancelled.`)
    }
    lesson.waitlist = []
    return lesson
  })
}

function completeLesson(id: string): Lesson {
  return commit((s) => {
    const lesson = s.lessons.find((l) => l.id === id)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (lesson.status !== 'scheduled') throw new RuleError('INVALID_STATE', 'Only scheduled lessons can be completed.')
    lesson.status = 'done'
    return lesson
  })
}

function enrollInLesson(lessonId: string, playerId: string): Lesson {
  return commit((s) => {
    getActiveUser(s, playerId)
    const lesson = s.lessons.find((l) => l.id === lessonId)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (lesson.status !== 'scheduled') throw new RuleError('INVALID_STATE', 'This lesson is not open for enrollment.')
    if (lesson.studentIds.includes(playerId)) throw new RuleError('ALREADY_ENROLLED') // rule 10
    if (lesson.studentIds.length >= lesson.capacity) throw new RuleError('LESSON_FULL') // rule 10
    lesson.studentIds.push(playerId)
    notify(s, playerId, 'lesson-enrolled', `You are enrolled in ${lesson.title}.`)
    return lesson
  })
}

function leaveLesson(lessonId: string, playerId: string): Lesson {
  return commit((s) => {
    getActiveUser(s, playerId)
    const lesson = s.lessons.find((l) => l.id === lessonId)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (!lesson.studentIds.includes(playerId)) throw new RuleError('INVALID_STATE', 'You are not enrolled in this lesson.')
    lesson.studentIds = lesson.studentIds.filter((id) => id !== playerId)
    delete lesson.attendance[playerId]
    promoteFromWaitlist(s, lesson)
    return lesson
  })
}

function joinWaitlist(lessonId: string, playerId: string): Lesson {
  return commit((s) => {
    getActiveUser(s, playerId)
    const lesson = s.lessons.find((l) => l.id === lessonId)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (lesson.status !== 'scheduled') throw new RuleError('INVALID_STATE', 'This lesson is not open for enrollment.')
    if (lesson.studentIds.includes(playerId)) throw new RuleError('ALREADY_ENROLLED')
    if (lesson.waitlist.includes(playerId)) throw new RuleError('ALREADY_WAITLISTED')
    if (lesson.studentIds.length < lesson.capacity) throw new RuleError('INVALID_STATE', 'This lesson still has seats. Enroll instead.')
    lesson.waitlist.push(playerId)
    return lesson
  })
}

function leaveWaitlist(lessonId: string, playerId: string): Lesson {
  return commit((s) => {
    const lesson = s.lessons.find((l) => l.id === lessonId)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (!lesson.waitlist.includes(playerId)) throw new RuleError('INVALID_STATE', 'You are not on the waitlist.')
    lesson.waitlist = lesson.waitlist.filter((id) => id !== playerId)
    return lesson
  })
}

export type LessonPatch = Partial<Pick<Lesson, 'title' | 'capacity' | 'courtId' | 'date' | 'start' | 'end'>>

/** Admin or the lesson's coach: edits a scheduled lesson and moves its court block with it. */
function updateLesson(id: string, patch: LessonPatch, actorId: string): Lesson {
  return commit((s) => {
    const actor = getActiveUser(s, actorId)
    const lesson = s.lessons.find((l) => l.id === id)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (actor.role !== 'admin' && lesson.coachId !== actor.id) throw new RuleError('INVALID_STATE', 'Only the coach or an admin can edit this lesson.')
    if (lesson.status !== 'scheduled') throw new RuleError('INVALID_STATE', 'Only scheduled lessons can be edited.')

    const next = { ...lesson, ...patch }
    if (next.capacity < lesson.studentIds.length) {
      throw new RuleError('VALIDATION', `Capacity cannot be lower than the ${lesson.studentIds.length} enrolled students.`)
    }
    const moved = (['courtId', 'date', 'start', 'end'] as const).some((k) => next[k] !== lesson[k])
    if (moved) {
      const court = getCourt(s, next.courtId)
      if (!court.active) throw new RuleError('COURT_INACTIVE')
      assertTimeRange(next.start, next.end)
      if (toMin(next.start) < s.settings.openHour * 60 || toMin(next.end) > s.settings.closeHour * 60) {
        throw new RuleError('INVALID_SLOT', 'Lessons must fit inside opening hours.')
      }
      assertLights(s, court, next.start)
      if (!hasBug('double-booking') && hasConflicts(findConflicts(s, next, { lessonId: id }))) throw new RuleError('SLOT_TAKEN')
      const block = s.blocks.find((b) => b.lessonId === id)
      if (block) Object.assign(block, { courtId: next.courtId, date: next.date, start: next.start, end: next.end })
    }
    Object.assign(lesson, { title: patch.title ?? lesson.title, capacity: next.capacity, courtId: next.courtId, date: next.date, start: next.start, end: next.end })
    promoteFromWaitlist(s, lesson)
    if (moved) {
      for (const studentId of lesson.studentIds) {
        notify(s, studentId, 'lesson-updated', `"${lesson.title}" is now on ${lesson.date} at ${lesson.start}.`)
      }
    }
    return lesson
  })
}

// ---------- lesson templates ----------

function saveTemplate(input: Omit<LessonTemplate, 'id'>): LessonTemplate {
  return commit((s) => {
    getActiveUser(s, input.coachId)
    assertTimeRange(input.start, input.end)
    const parsed = lessonTemplateSchema.omit({ id: true }).safeParse(input)
    if (!parsed.success) throw new RuleError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const template: LessonTemplate = { id: nextId('template', s.lessonTemplates), ...parsed.data }
    s.lessonTemplates.push(template)
    return template
  })
}

function deleteTemplate(id: string, actorId: string): void {
  commit((s) => {
    const template = s.lessonTemplates.find((x) => x.id === id)
    if (!template) throw new RuleError('NOT_FOUND', 'Template not found.')
    if (template.coachId !== actorId) throw new RuleError('INVALID_STATE', 'You can only delete your own templates.')
    s.lessonTemplates = s.lessonTemplates.filter((x) => x.id !== id)
  })
}

/** A no-show also marks the student's overlapping booked reservation as no-show. */
function setAttendance(lessonId: string, studentId: string, value: 'present' | 'no-show'): Lesson {
  return commit((s) => {
    const lesson = s.lessons.find((l) => l.id === lessonId)
    if (!lesson) throw new RuleError('NOT_FOUND', 'Lesson not found.')
    if (!lesson.studentIds.includes(studentId)) throw new RuleError('INVALID_STATE', 'That player is not enrolled.')
    lesson.attendance[studentId] = value
    if (value === 'no-show') {
      for (const r of s.reservations) {
        if (r.playerId === studentId && r.status === 'booked' && r.date === lesson.date && overlaps(r, lesson)) {
          r.status = 'no-show'
        }
      }
    }
    return lesson
  })
}

// ---------- notes ----------

function addNote(input: Omit<Note, 'id' | 'createdAt'>): Note {
  return commit((s) => {
    getActiveUser(s, input.coachId)
    getUser(s, input.playerId)
    const note: Note = { id: nextId('note', s.notes), ...input, createdAt: clock.now().toISOString() }
    s.notes.push(note)
    return note
  })
}

// ---------- notifications ----------

function markNotificationRead(id: string): void {
  commit((s) => {
    const n = s.notifications.find((x) => x.id === id)
    if (n) n.read = true
  })
}

function markAllNotificationsRead(userId: string): void {
  commit((s) => {
    s.notifications.forEach((n) => {
      if (n.userId === userId) n.read = true
    })
  })
}

// ---------- users ----------

/** Rule 11: deactivating a user cancels their future reservations. */
function setUserActive(id: string, active: boolean): User {
  return commit((s) => {
    const user = getUser(s, id)
    user.active = active
    if (!active) cancelFutureReservations(s, id, 'user deactivated')
    return user
  })
}

function setUserRole(id: string, role: Role): User {
  return commit((s) => {
    const user = getUser(s, id)
    user.role = role
    return user
  })
}

// ---------- courts ----------

function createCourt(input: Pick<Court, 'name' | 'surface' | 'lights'>): Court {
  return commit((s) => {
    const court: Court = { id: nextId('court', s.courts), active: true, ...input }
    s.courts.push(court)
    return court
  })
}

function updateCourt(id: string, patch: Partial<Omit<Court, 'id'>>): Court {
  return commit((s) => {
    const court = getCourt(s, id)
    Object.assign(court, patch)
    return court
  })
}

function deleteCourt(id: string): void {
  commit((s) => {
    getCourt(s, id)
    const now = clock.now()
    const busy =
      s.reservations.some((r) => r.courtId === id && r.status === 'booked' && isFutureReservation(r, now)) ||
      s.lessons.some((l) => l.courtId === id && l.status === 'scheduled' && at(l.date, l.start) > now)
    if (busy) throw new RuleError('COURT_IN_USE')
    s.courts = s.courts.filter((c) => c.id !== id)
    s.blocks = s.blocks.filter((b) => b.courtId !== id)
  })
}

// ---------- settings ----------

function updateSettings(patch: Partial<Settings>): Settings {
  return commit((s) => {
    const result = settingsSchema.safeParse({ ...s.settings, ...patch })
    if (!result.success) {
      throw new RuleError('VALIDATION', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    s.settings = result.data
    return s.settings
  })
}

export const actions = {
  bookReservation,
  bookRecurring,
  cancelReservation,
  cancelSeries,
  moveReservation,
  markNoShow,
  createBlock,
  moveBlock,
  deleteBlock,
  createLesson,
  cancelLesson,
  completeLesson,
  enrollInLesson,
  leaveLesson,
  joinWaitlist,
  leaveWaitlist,
  updateLesson,
  saveTemplate,
  deleteTemplate,
  setAttendance,
  addNote,
  markNotificationRead,
  markAllNotificationsRead,
  setUserActive,
  setUserRole,
  createCourt,
  updateCourt,
  deleteCourt,
  updateSettings,
}

