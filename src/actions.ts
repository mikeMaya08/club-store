import { clock } from './clock'
import { hasBug } from './config'
import { RuleError } from './errors'
import { chargedPrice } from './pricing'
import { activeReservationCount, findConflicts, hasConflicts, isFutureReservation } from './queries'
import { settingsSchema } from './schema'
import { commit } from './store'
import { at, hoursUntil, overlaps, slotsFor, toMin } from './time'
import type { Block, Court, Lesson, Note, Reservation, Role, Settings, State, User } from './types'

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

function bookReservation(input: BookInput): Reservation {
  return commit((s) => {
    const now = clock.now()
    getActiveUser(s, input.playerId)
    const court = getCourt(s, input.courtId)
    if (!court.active) throw new RuleError('COURT_INACTIVE') // rule 7

    const slot = slotsFor(s.settings).find((x) => x.start === input.start) // rule 1
    if (!slot) throw new RuleError('INVALID_SLOT')
    if (at(input.date, slot.start) <= now) throw new RuleError('INVALID_SLOT', 'That slot is in the past.')

    assertLights(s, court, slot.start) // rule 2
    if (activeReservationCount(s, input.playerId, now) >= s.settings.maxActiveReservations) {
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
      status: 'booked',
      price: chargedPrice(s.settings, slot.start), // rule 6
      createdAt: now.toISOString(),
    }
    s.reservations.push(reservation)
    if (input.partnerId) {
      const who = getUser(s, input.playerId).name
      notify(s, input.partnerId, 'partner-added', `${who} added you as a partner on ${reservation.date} at ${reservation.start}.`)
    }
    return reservation
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

    const lesson: Lesson = { id: nextId('lesson', s.lessons), ...input, studentIds: [], status: 'scheduled', attendance: {} }
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
    for (const studentId of lesson.studentIds) {
      notify(s, studentId, 'lesson-cancelled', `The lesson "${lesson.title}" on ${lesson.date} was cancelled.`)
    }
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
    return lesson
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
  cancelReservation,
  markNoShow,
  createBlock,
  moveBlock,
  deleteBlock,
  createLesson,
  cancelLesson,
  completeLesson,
  enrollInLesson,
  leaveLesson,
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

