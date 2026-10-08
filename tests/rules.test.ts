import { describe, expect, it } from 'vitest'
import { actions, setConfig } from '../src'
import { TODAY, TOMORROW, book, expectCode, state, useFreshClub } from './helpers'

useFreshClub()

describe('rule 1: slots', () => {
  it('books a valid hourly slot and computes the end', () => {
    const r = book({ start: '07:00' })
    expect(r.end).toBe('08:00')
    expect(r.status).toBe('booked')
  })
  it('rejects times that are not slot boundaries', () => {
    expectCode(() => book({ start: '07:30' }), 'INVALID_SLOT')
  })
  it('rejects slots outside opening hours', () => {
    expectCode(() => book({ start: '06:00' }), 'INVALID_SLOT')
    expectCode(() => book({ start: '22:00' }), 'INVALID_SLOT')
  })
  it('accepts the last slot of the day', () => {
    expect(book({ start: '21:00' }).end).toBe('22:00')
  })
  it('rejects slots in the past', () => {
    expectCode(() => book({ date: TODAY, start: '09:00' }), 'INVALID_SLOT')
  })
})

describe('rule 2: lights', () => {
  it('blocks courts without lights from 19:00', () => {
    expectCode(() => book({ courtId: 'court-5', start: '19:00' }), 'NO_LIGHTS')
    expectCode(() => book({ courtId: 'court-5', start: '21:00' }), 'NO_LIGHTS')
  })
  it('allows courts without lights before 19:00', () => {
    expect(book({ courtId: 'court-5', start: '18:00' }).status).toBe('booked')
  })
  it('allows lit courts in the evening', () => {
    expect(book({ courtId: 'court-1', start: '19:00' }).status).toBe('booked')
  })
})

describe('rule 3: max active reservations', () => {
  it('rejects the third future booking', () => {
    book({ start: '08:00' })
    book({ start: '09:00' })
    expectCode(() => book({ start: '10:00' }), 'MAX_ACTIVE')
  })
  it('does not count cancelled reservations', () => {
    const first = book({ start: '08:00' })
    book({ start: '09:00' })
    actions.cancelReservation(first.id, 'player-1')
    expect(book({ start: '10:00' }).status).toBe('booked')
  })
  it('does not count other players', () => {
    book({ start: '08:00' })
    book({ start: '09:00' })
    expect(book({ start: '10:00', playerId: 'player-2' }).status).toBe('booked')
  })
  it('respects the setting', () => {
    actions.updateSettings({ maxActiveReservations: 1 })
    book({ start: '08:00' })
    expectCode(() => book({ start: '09:00' }), 'MAX_ACTIVE')
  })
})

describe('rule 4: no double booking', () => {
  it('rejects the same slot twice', () => {
    book()
    expectCode(() => book({ playerId: 'player-2' }), 'SLOT_TAKEN')
  })
  it('allows the same hour on another court or day', () => {
    book()
    expect(book({ playerId: 'player-2', courtId: 'court-2' })).toBeTruthy()
    expect(book({ playerId: 'player-3', date: '2026-10-12' })).toBeTruthy()
  })
  it('frees the slot after a cancellation', () => {
    const r = book()
    actions.cancelReservation(r.id, 'player-1')
    expect(book({ playerId: 'player-2' }).status).toBe('booked')
  })
  it('rejects slots covered by a block', () => {
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '09:00', end: '12:00', reason: 'maintenance', createdBy: 'admin-1' })
    expectCode(() => book({ start: '10:00' }), 'SLOT_TAKEN')
  })
  it('rejects slots covered by a lesson', () => {
    actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'Drills', capacity: 4 })
    expectCode(() => book({ start: '10:00' }), 'SLOT_TAKEN')
  })
  it('is skipped with bug=double-booking', () => {
    setConfig({ bugs: ['double-booking'] })
    book()
    expect(book({ playerId: 'player-2' }).status).toBe('booked')
    expect(state().reservations).toHaveLength(2)
  })
})

describe('rule 5: cancellation window', () => {
  it('rejects cancelling less than 4 hours before', () => {
    const r = book({ date: TODAY, start: '13:00' }) // 3h from 10:00
    expectCode(() => actions.cancelReservation(r.id, 'player-1'), 'CANCEL_TOO_LATE')
  })
  it('allows cancelling exactly 4 hours before', () => {
    const r = book({ date: TODAY, start: '14:00' })
    expect(actions.cancelReservation(r.id, 'player-1').status).toBe('cancelled')
  })
  it('allows cancelling well in advance', () => {
    const r = book()
    const cancelled = actions.cancelReservation(r.id, 'player-1')
    expect(cancelled.cancelReason).toBe('cancelled by player')
  })
  it('lets an admin force it', () => {
    const r = book({ date: TODAY, start: '11:00' })
    expect(actions.cancelReservation(r.id, 'admin-1', { force: true }).status).toBe('cancelled')
  })
  it('does not let one player cancel another player\'s reservation', () => {
    const r = book()
    expectCode(() => actions.cancelReservation(r.id, 'player-2'), 'INVALID_STATE')
  })
  it('is skipped with bug=cancel-anytime', () => {
    setConfig({ bugs: ['cancel-anytime'] })
    const r = book({ date: TODAY, start: '11:00' })
    expect(actions.cancelReservation(r.id, 'player-1').status).toBe('cancelled')
  })
})

describe('rule 6: price', () => {
  it('charges the base price off-peak', () => {
    expect(book({ start: '17:00' }).price).toBe(250)
    expect(book({ start: '21:00', playerId: 'player-2' }).price).toBe(250)
  })
  it('charges the peak price from 18:00 up to (not including) 21:00', () => {
    expect(book({ start: '18:00' }).price).toBe(400)
    expect(book({ start: '20:00', playerId: 'player-2' }).price).toBe(400)
  })
  it('follows settings changes', () => {
    actions.updateSettings({ peakPrice: 500 })
    expect(book({ start: '18:00' }).price).toBe(500)
  })
  it('always charges base with bug=wrong-price', () => {
    setConfig({ bugs: ['wrong-price'] })
    expect(book({ start: '18:00' }).price).toBe(250)
  })
})

describe('rule 7: inactive courts and users', () => {
  it('rejects inactive courts', () => {
    expectCode(() => book({ courtId: 'court-4' }), 'COURT_INACTIVE')
  })
  it('rejects inactive users when booking, cancelling and enrolling', () => {
    const r = book({ playerId: 'player-2', start: '12:00' })
    const lesson = actions.createLesson({ coachId: 'coach-1', courtId: 'court-2', date: TOMORROW, start: '15:00', end: '16:00', title: 'L', capacity: 2 })
    actions.setUserActive('player-1', false)
    expectCode(() => book({ playerId: 'player-1' }), 'USER_INACTIVE')
    expectCode(() => actions.cancelReservation(r.id, 'player-1'), 'USER_INACTIVE')
    expectCode(() => actions.enrollInLesson(lesson.id, 'player-1'), 'USER_INACTIVE')
  })
  it('rejects inactive coaches and admins', () => {
    actions.setUserActive('coach-1', false)
    expectCode(
      () => actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'L', capacity: 2 }),
      'USER_INACTIVE',
    )
    actions.setUserActive('admin-1', false)
    expectCode(
      () => actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', reason: 'maintenance', createdBy: 'admin-1' }),
      'USER_INACTIVE',
    )
  })
  it('rejects lessons on inactive courts', () => {
    expectCode(
      () => actions.createLesson({ coachId: 'coach-1', courtId: 'court-4', date: TOMORROW, start: '10:00', end: '11:00', title: 'L', capacity: 2 }),
      'COURT_INACTIVE',
    )
  })
})

describe('rule 8: blocks cancel overlapping reservations', () => {
  it('cancels overlapping reservations and notifies each player', () => {
    const a = book({ start: '10:00' })
    const b = book({ start: '11:00', playerId: 'player-2' })
    const outside = book({ start: '14:00', playerId: 'player-3' })
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '10:00', end: '12:00', reason: 'tournament', createdBy: 'admin-1' })

    const s = state()
    expect(s.reservations.find((r) => r.id === a.id)).toMatchObject({ status: 'cancelled', cancelReason: 'blocked by club' })
    expect(s.reservations.find((r) => r.id === b.id)?.status).toBe('cancelled')
    expect(s.reservations.find((r) => r.id === outside.id)?.status).toBe('booked')
    expect(s.notifications.filter((n) => n.type === 'reservation-cancelled').map((n) => n.userId).sort()).toEqual(['player-1', 'player-2'])
  })
  it('leaves other courts untouched', () => {
    const other = book({ courtId: 'court-2' })
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', reason: 'maintenance', createdBy: 'admin-1' })
    expect(state().reservations.find((r) => r.id === other.id)?.status).toBe('booked')
  })
  it('rejects blocks that overlap another block', () => {
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '10:00', end: '12:00', reason: 'maintenance', createdBy: 'admin-1' })
    expectCode(
      () => actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '11:00', end: '13:00', reason: 'tournament', createdBy: 'admin-1' }),
      'SLOT_TAKEN',
    )
  })
  it('also cancels when a block is moved onto a reservation', () => {
    const r = book({ start: '15:00' })
    const block = actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '08:00', end: '09:00', reason: 'maintenance', createdBy: 'admin-1' })
    actions.moveBlock(block.id, { start: '15:00', end: '16:00' })
    expect(state().reservations.find((x) => x.id === r.id)?.status).toBe('cancelled')
  })
})

describe('rule 9: lessons own a block', () => {
  const input = { coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'Drills', capacity: 4 }
  it('creates a block with reason lesson', () => {
    const lesson = actions.createLesson(input)
    expect(state().blocks.find((b) => b.lessonId === lesson.id)).toMatchObject({ reason: 'lesson', courtId: 'court-1', start: '10:00', end: '11:00' })
  })
  it('removes the block when the lesson is cancelled', () => {
    const lesson = actions.createLesson(input)
    actions.cancelLesson(lesson.id, 'coach-1')
    expect(state().blocks.some((b) => b.lessonId === lesson.id)).toBe(false)
    expect(state().lessons[0].status).toBe('cancelled')
    expect(book({ start: '10:00' }).status).toBe('booked')
  })
  it('rejects a lesson over an existing reservation', () => {
    book({ start: '10:00' })
    expectCode(() => actions.createLesson(input), 'SLOT_TAKEN')
  })
  it('rejects overlapping lessons', () => {
    actions.createLesson(input)
    expectCode(() => actions.createLesson({ ...input, start: '10:30', end: '11:30' }), 'SLOT_TAKEN')
  })
  it('rejects lessons outside opening hours or with a bad range', () => {
    expectCode(() => actions.createLesson({ ...input, start: '05:00', end: '06:00' }), 'INVALID_SLOT')
    expectCode(() => actions.createLesson({ ...input, start: '11:00', end: '10:00' }), 'INVALID_SLOT')
  })
  it('applies the lights rule to lessons', () => {
    expectCode(() => actions.createLesson({ ...input, courtId: 'court-5', start: '19:00', end: '20:00' }), 'NO_LIGHTS')
  })
  it('cannot move or delete lesson blocks directly', () => {
    const lesson = actions.createLesson(input)
    const block = state().blocks.find((b) => b.lessonId === lesson.id)!
    expectCode(() => actions.moveBlock(block.id, { start: '12:00', end: '13:00' }), 'INVALID_STATE')
    expectCode(() => actions.deleteBlock(block.id), 'INVALID_STATE')
  })
})

describe('rule 10: lesson enrollment', () => {
  const make = (capacity: number) =>
    actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'Drills', capacity })

  it('enrolls players up to capacity, then reports LESSON_FULL', () => {
    const lesson = make(2)
    actions.enrollInLesson(lesson.id, 'player-1')
    actions.enrollInLesson(lesson.id, 'player-2')
    expectCode(() => actions.enrollInLesson(lesson.id, 'player-3'), 'LESSON_FULL')
  })
  it('reports ALREADY_ENROLLED for repeated enrollment', () => {
    const lesson = make(3)
    actions.enrollInLesson(lesson.id, 'player-1')
    expectCode(() => actions.enrollInLesson(lesson.id, 'player-1'), 'ALREADY_ENROLLED')
  })
  it('reports ALREADY_ENROLLED (not LESSON_FULL) for an enrolled player in a full lesson', () => {
    const lesson = make(1)
    actions.enrollInLesson(lesson.id, 'player-1')
    expectCode(() => actions.enrollInLesson(lesson.id, 'player-1'), 'ALREADY_ENROLLED')
  })
  it('frees a seat when a player leaves', () => {
    const lesson = make(1)
    actions.enrollInLesson(lesson.id, 'player-1')
    actions.leaveLesson(lesson.id, 'player-1')
    expect(actions.enrollInLesson(lesson.id, 'player-2').studentIds).toEqual(['player-2'])
  })
  it('rejects enrolling in a cancelled lesson', () => {
    const lesson = make(2)
    actions.cancelLesson(lesson.id, 'coach-1')
    expectCode(() => actions.enrollInLesson(lesson.id, 'player-1'), 'INVALID_STATE')
  })
})

describe('rule 11: deactivating a user', () => {
  it('cancels future reservations only', () => {
    const future = book({ start: '10:00' })
    const other = book({ start: '10:00', playerId: 'player-2', courtId: 'court-2' })
    actions.setUserActive('player-1', false)
    const s = state()
    expect(s.reservations.find((r) => r.id === future.id)).toMatchObject({ status: 'cancelled', cancelReason: 'user deactivated' })
    expect(s.reservations.find((r) => r.id === other.id)?.status).toBe('booked')
    expect(s.users.find((u) => u.id === 'player-1')?.active).toBe(false)
  })
  it('keeps already finished reservations', () => {
    setConfig({ now: '2026-10-09T08:00' })
    const r = book({ date: '2026-10-09', start: '09:00' })
    setConfig({ now: '2026-10-09T12:00' })
    actions.setUserActive('player-1', false)
    expect(state().reservations.find((x) => x.id === r.id)?.status).toBe('booked')
  })
})

describe('other actions', () => {
  it('a no-show attendance also marks the matching reservation', () => {
    const lesson = actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'L', capacity: 3 })
    actions.enrollInLesson(lesson.id, 'player-1')
    const res = book({ courtId: 'court-2', start: '10:00' })
    const unrelated = book({ courtId: 'court-2', start: '12:00' })
    actions.setAttendance(lesson.id, 'player-1', 'no-show')
    expect(state().lessons[0].attendance['player-1']).toBe('no-show')
    expect(state().reservations.find((r) => r.id === res.id)?.status).toBe('no-show')
    expect(state().reservations.find((r) => r.id === unrelated.id)?.status).toBe('booked')
  })
  it('rejects attendance for players who are not enrolled', () => {
    const lesson = actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'L', capacity: 3 })
    expectCode(() => actions.setAttendance(lesson.id, 'player-1', 'present'), 'INVALID_STATE')
  })
  it('blocks deleting a court with future reservations', () => {
    book()
    expectCode(() => actions.deleteCourt('court-1'), 'COURT_IN_USE')
    expect(() => actions.deleteCourt('court-2')).not.toThrow()
    expect(state().courts.some((c) => c.id === 'court-2')).toBe(false)
  })
  it('validates settings', () => {
    expectCode(() => actions.updateSettings({ closeHour: 5 }), 'VALIDATION')
    expectCode(() => actions.updateSettings({ basePrice: -1 }), 'VALIDATION')
    expect(state().settings.closeHour).toBe(22)
  })
  it('returns NOT_FOUND for unknown ids', () => {
    expectCode(() => actions.cancelReservation('nope', 'player-1'), 'NOT_FOUND')
    expectCode(() => book({ courtId: 'court-99' }), 'NOT_FOUND')
    expectCode(() => book({ playerId: 'ghost' }), 'NOT_FOUND')
  })
  it('adds notes and marks notifications read', () => {
    actions.addNote({ coachId: 'coach-1', playerId: 'player-1', text: '<b>ok</b>', rating: 4 })
    expect(state().notes).toHaveLength(1)
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', reason: 'maintenance', createdBy: 'admin-1' })
    book({ start: '15:00' })
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '15:00', end: '16:00', reason: 'maintenance', createdBy: 'admin-1' })
    const notif = state().notifications[0]
    actions.markNotificationRead(notif.id)
    expect(state().notifications[0].read).toBe(true)
    actions.markAllNotificationsRead('player-1')
    expect(state().notifications.every((n) => n.read)).toBe(true)
  })
})
