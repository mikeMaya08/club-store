import { describe, expect, it } from 'vitest'
import { actions, setConfig } from '../src'
import { STORAGE_KEY } from '../src'
import { localStore } from '../src/storage'
import { TODAY, TOMORROW, book, expectCode, state, useFreshClub } from './helpers'

useFreshClub()

const lessonInput = { coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'Drills', capacity: 2 }
const fullLesson = () => {
  const lesson = actions.createLesson(lessonInput)
  actions.enrollInLesson(lesson.id, 'player-1')
  actions.enrollInLesson(lesson.id, 'player-2')
  return lesson
}

describe('lesson waitlist', () => {
  it('only allows joining a full lesson', () => {
    const lesson = actions.createLesson(lessonInput)
    expectCode(() => actions.joinWaitlist(lesson.id, 'player-3'), 'INVALID_STATE')
  })
  it('queues players in order', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.joinWaitlist(lesson.id, 'player-4')
    expect(state().lessons[0].waitlist).toEqual(['player-3', 'player-4'])
  })
  it('rejects duplicates and enrolled players', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    expectCode(() => actions.joinWaitlist(lesson.id, 'player-3'), 'ALREADY_WAITLISTED')
    expectCode(() => actions.joinWaitlist(lesson.id, 'player-1'), 'ALREADY_ENROLLED')
  })
  it('rejects inactive users', () => {
    const lesson = fullLesson()
    actions.setUserActive('player-3', false)
    expectCode(() => actions.joinWaitlist(lesson.id, 'player-3'), 'USER_INACTIVE')
  })
  it('promotes the first waiting player when someone leaves, and notifies them', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.joinWaitlist(lesson.id, 'player-4')
    actions.leaveLesson(lesson.id, 'player-1')
    const l = state().lessons[0]
    expect(l.studentIds).toEqual(['player-2', 'player-3'])
    expect(l.waitlist).toEqual(['player-4'])
    expect(state().notifications.some((n) => n.userId === 'player-3' && n.type === 'waitlist-promoted')).toBe(true)
  })
  it('skips deactivated players when promoting', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.joinWaitlist(lesson.id, 'player-4')
    actions.setUserActive('player-3', false)
    actions.leaveLesson(lesson.id, 'player-1')
    expect(state().lessons[0].studentIds).toEqual(['player-2', 'player-4'])
  })
  it('lets a player leave the waitlist', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.leaveWaitlist(lesson.id, 'player-3')
    expect(state().lessons[0].waitlist).toEqual([])
    expectCode(() => actions.leaveWaitlist(lesson.id, 'player-3'), 'INVALID_STATE')
  })
  it('notifies the waitlist when the lesson is cancelled', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.cancelLesson(lesson.id, 'coach-1')
    expect(state().notifications.some((n) => n.userId === 'player-3' && n.type === 'lesson-cancelled')).toBe(true)
    expect(state().lessons[0].waitlist).toEqual([])
  })
  it('promotes when the capacity grows', () => {
    const lesson = fullLesson()
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.updateLesson(lesson.id, { capacity: 3 }, 'admin-1')
    expect(state().lessons[0].studentIds).toContain('player-3')
  })
})

describe('weekly recurring bookings', () => {
  const series = (over = {}) => actions.bookRecurring({ courtId: 'court-1', playerId: 'player-1', date: TOMORROW, start: '10:00', weeks: 4, ...over })

  it('books the same slot for each week with one seriesId', () => {
    const list = series()
    expect(list.map((r) => r.date)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01'])
    expect(new Set(list.map((r) => r.seriesId)).size).toBe(1)
    expect(list.every((r) => r.status === 'booked')).toBe(true)
  })
  it('counts the whole series as one active reservation', () => {
    series()
    book({ start: '12:00' }) // second active reservation: allowed
    expectCode(() => book({ start: '13:00' }), 'MAX_ACTIVE')
  })
  it('is blocked when the player is already at the limit', () => {
    book({ start: '08:00' })
    book({ start: '09:00' })
    expectCode(() => series({ start: '12:00' }), 'MAX_ACTIVE')
  })
  it('is all-or-nothing and names the failing week', () => {
    book({ date: '2026-10-25', playerId: 'player-2' })
    try {
      series()
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code: string }).code).toBe('SLOT_TAKEN')
      expect((e as Error).message).toContain('2026-10-25')
    }
    expect(state().reservations).toHaveLength(1)
  })
  it('validates the number of weeks', () => {
    expectCode(() => series({ weeks: 1 }), 'VALIDATION')
    expectCode(() => series({ weeks: 9 }), 'VALIDATION')
  })
  it('applies the lights rule to every week', () => {
    expectCode(() => series({ courtId: 'court-5', start: '19:00' }), 'NO_LIGHTS')
  })
  it('creates unique series ids', () => {
    const a = series()
    const b = series({ playerId: 'player-2', courtId: 'court-2' })
    expect(a[0].seriesId).not.toBe(b[0].seriesId)
  })
  it('can be cancelled as a series', () => {
    const list = series()
    const result = actions.cancelSeries(list[0].seriesId!, 'player-1')
    expect(result).toEqual({ cancelled: 4, skipped: 0 })
    expect(state().reservations.every((r) => r.status === 'cancelled')).toBe(true)
  })
  it('skips occurrences inside the cancellation window and fails when none can be cancelled', () => {
    const list = series({ date: TODAY, start: '13:00' }) // first one is 3h away
    expect(actions.cancelSeries(list[0].seriesId!, 'player-1')).toEqual({ cancelled: 3, skipped: 1 })
    expectCode(() => actions.cancelSeries(list[0].seriesId!, 'player-1'), 'CANCEL_TOO_LATE')
  })
  it("does not let another player cancel someone's series", () => {
    const list = series()
    expectCode(() => actions.cancelSeries(list[0].seriesId!, 'player-2'), 'INVALID_STATE')
  })
  it('is cancelled when a block covers one week and user deactivation cancels the rest', () => {
    const list = series()
    actions.createBlock({ courtId: 'court-1', date: '2026-10-18', start: '10:00', end: '11:00', reason: 'maintenance', createdBy: 'admin-1' })
    expect(state().reservations.filter((r) => r.status === 'cancelled')).toHaveLength(1)
    actions.setUserActive('player-1', false)
    expect(state().reservations.filter((r) => r.status === 'booked' && r.seriesId === list[0].seriesId)).toHaveLength(0)
  })
})

describe('moving reservations (admin)', () => {
  it('moves to another slot, recalculating end and price', () => {
    const r = book({ start: '10:00' })
    const moved = actions.moveReservation(r.id, { courtId: 'court-2', start: '18:00' }, 'admin-1')
    expect(moved).toMatchObject({ courtId: 'court-2', start: '18:00', end: '19:00', price: 400 })
    expect(state().notifications.some((n) => n.type === 'reservation-moved' && n.userId === 'player-1')).toBe(true)
  })
  it('rejects occupied slots but ignores itself', () => {
    const a = book({ start: '10:00' })
    book({ start: '11:00', playerId: 'player-2' })
    expectCode(() => actions.moveReservation(a.id, { start: '11:00' }, 'admin-1'), 'SLOT_TAKEN')
    expect(actions.moveReservation(a.id, { start: '10:00' }, 'admin-1').start).toBe('10:00')
  })
  it('enforces slot grid, past, lights, inactive court', () => {
    const r = book({ start: '10:00' })
    expectCode(() => actions.moveReservation(r.id, { start: '10:30' }, 'admin-1'), 'INVALID_SLOT')
    expectCode(() => actions.moveReservation(r.id, { date: TODAY, start: '09:00' }, 'admin-1'), 'INVALID_SLOT')
    expectCode(() => actions.moveReservation(r.id, { courtId: 'court-5', start: '19:00' }, 'admin-1'), 'NO_LIGHTS')
    expectCode(() => actions.moveReservation(r.id, { courtId: 'court-4' }, 'admin-1'), 'COURT_INACTIVE')
  })
  it('is admin only and needs a booked reservation', () => {
    const r = book()
    expectCode(() => actions.moveReservation(r.id, { start: '12:00' }, 'player-1'), 'INVALID_STATE')
    actions.cancelReservation(r.id, 'player-1')
    expectCode(() => actions.moveReservation(r.id, { start: '12:00' }, 'admin-1'), 'INVALID_STATE')
    expectCode(() => actions.moveReservation('nope', {}, 'admin-1'), 'NOT_FOUND')
  })
  it('can be moved onto a free slot over double-booking bug', () => {
    const a = book({ start: '10:00' })
    book({ start: '11:00', playerId: 'player-2' })
    setConfig({ bugs: ['double-booking'] })
    expect(actions.moveReservation(a.id, { start: '11:00' }, 'admin-1').start).toBe('11:00')
  })
})

describe('updating lessons', () => {
  it('moves the lesson and its block, and notifies students', () => {
    const lesson = actions.createLesson(lessonInput)
    actions.enrollInLesson(lesson.id, 'player-1')
    actions.updateLesson(lesson.id, { start: '14:00', end: '15:00', courtId: 'court-2', title: 'Renamed' }, 'admin-1')
    const s = state()
    expect(s.lessons[0]).toMatchObject({ start: '14:00', courtId: 'court-2', title: 'Renamed' })
    expect(s.blocks.find((b) => b.lessonId === lesson.id)).toMatchObject({ start: '14:00', courtId: 'court-2' })
    expect(s.notifications.some((n) => n.type === 'lesson-updated' && n.userId === 'player-1')).toBe(true)
  })
  it('rejects conflicts but ignores its own slot', () => {
    const lesson = actions.createLesson(lessonInput)
    book({ courtId: 'court-2', start: '14:00' })
    expectCode(() => actions.updateLesson(lesson.id, { courtId: 'court-2', start: '14:00', end: '15:00' }, 'admin-1'), 'SLOT_TAKEN')
    expect(() => actions.updateLesson(lesson.id, { end: '11:00', title: 'Same slot' }, 'admin-1')).not.toThrow()
  })
  it('does not allow capacity below the enrolled students', () => {
    const lesson = fullLesson()
    expectCode(() => actions.updateLesson(lesson.id, { capacity: 1 }, 'admin-1'), 'VALIDATION')
  })
  it('is limited to admins and the owning coach, for scheduled lessons', () => {
    const lesson = actions.createLesson(lessonInput)
    expectCode(() => actions.updateLesson(lesson.id, { title: 'x' }, 'coach-2'), 'INVALID_STATE')
    expect(actions.updateLesson(lesson.id, { title: 'ok' }, 'coach-1').title).toBe('ok')
    actions.cancelLesson(lesson.id, 'coach-1')
    expectCode(() => actions.updateLesson(lesson.id, { title: 'y' }, 'admin-1'), 'INVALID_STATE')
  })
  it('validates lights, hours, inactive courts and NOT_FOUND', () => {
    const lesson = actions.createLesson(lessonInput)
    expectCode(() => actions.updateLesson(lesson.id, { courtId: 'court-5', start: '19:00', end: '20:00' }, 'admin-1'), 'NO_LIGHTS')
    expectCode(() => actions.updateLesson(lesson.id, { start: '05:00', end: '06:00' }, 'admin-1'), 'INVALID_SLOT')
    expectCode(() => actions.updateLesson(lesson.id, { courtId: 'court-4' }, 'admin-1'), 'COURT_INACTIVE')
    expectCode(() => actions.updateLesson('nope', {}, 'admin-1'), 'NOT_FOUND')
  })
})

describe('lesson templates', () => {
  const tpl = { coachId: 'coach-1', name: 'Evening', title: 'Beginner Drills', start: '17:00', end: '18:00', capacity: 4 }
  it('saves and deletes templates (owner only)', () => {
    const t = actions.saveTemplate(tpl)
    expect(t.id).toBe('template-1')
    expectCode(() => actions.deleteTemplate(t.id, 'coach-2'), 'INVALID_STATE')
    actions.deleteTemplate(t.id, 'coach-1')
    expect(state().lessonTemplates).toHaveLength(0)
    expectCode(() => actions.deleteTemplate(t.id, 'coach-1'), 'NOT_FOUND')
  })
  it('validates input', () => {
    expectCode(() => actions.saveTemplate({ ...tpl, end: '16:00' }), 'INVALID_SLOT')
    expectCode(() => actions.saveTemplate({ ...tpl, name: '' }), 'VALIDATION')
    expectCode(() => actions.saveTemplate({ ...tpl, capacity: 0 }), 'VALIDATION')
  })
})

describe('data saved by v0.1', () => {
  it('is upgraded on read', () => {
    const old = JSON.parse(localStore().getItem(STORAGE_KEY)!)
    delete old.data.lessonTemplates
    old.data.lessons.push({ id: 'lesson-1', coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'Old', studentIds: [], capacity: 2, status: 'scheduled', attendance: {} })
    localStore().setItem(STORAGE_KEY, JSON.stringify(old))
    expect(() => actions.enrollInLesson('lesson-1', 'player-1')).not.toThrow()
    expect(state().lessons[0].waitlist).toEqual([])
    expect(state().lessonTemplates).toEqual([])
  })
})
