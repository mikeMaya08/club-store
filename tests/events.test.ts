import { describe, expect, it } from 'vitest'
import { STORAGE_KEY, actions, filterEvents, reset, seed, setConfig } from '../src'
import { localStore } from '../src/storage'
import { NOW, TODAY, TOMORROW, book, expectCode, state, useFreshClub } from './helpers'

useFreshClub()

const last = () => state().events[state().events.length - 1]
const types = () => state().events.map((e) => e.type)
const lessonInput = { coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '10:00', end: '11:00', title: 'Drills', capacity: 2 }

describe('activity log: reservations', () => {
  it('logs a booking with actor, partner, summary and details', () => {
    const r = book({ partnerId: 'player-2' })
    expect(last()).toMatchObject({
      type: 'reservation.booked', actorId: 'player-1', subjectId: 'player-2', entity: 'reservation', entityId: r.id,
      meta: { courtId: 'court-1', date: TOMORROW, start: '10:00', price: 250 },
    })
    expect(last().summary).toContain('Lucía Fernández booked Court 1')
    expect(last().createdAt.startsWith(TODAY)).toBe(true)
  })
  it('logs one event for a whole weekly series', () => {
    actions.bookRecurring({ courtId: 'court-1', playerId: 'player-1', date: TOMORROW, start: '10:00', weeks: 4 })
    expect(types()).toEqual(['reservation.series_booked'])
    expect(last().meta).toMatchObject({ weeks: 4, price: 1000 })
  })
  it('logs cancellations by the player and by an admin', () => {
    const a = book()
    const b = book({ playerId: 'player-2', start: '12:00' })
    actions.cancelReservation(a.id, 'player-1')
    actions.cancelReservation(b.id, 'admin-1', { force: true })
    const cancelled = state().events.filter((e) => e.type === 'reservation.cancelled')
    expect(cancelled.map((e) => e.actorId)).toEqual(['player-1', 'admin-1'])
    expect(cancelled[1]).toMatchObject({ subjectId: 'player-2' })
  })
  it('logs series cancellation, moves and no-shows', () => {
    const list = actions.bookRecurring({ courtId: 'court-1', playerId: 'player-1', date: TOMORROW, start: '10:00', weeks: 2 })
    actions.cancelSeries(list[0].seriesId!, 'player-1')
    const r = book({ start: '14:00', playerId: 'player-2' })
    actions.moveReservation(r.id, { start: '15:00' }, 'admin-1')
    actions.markNoShow(r.id, 'admin-1')
    expect(types()).toEqual(['reservation.series_booked', 'reservation.series_cancelled', 'reservation.booked', 'reservation.moved', 'reservation.no_show'])
    expect(state().events.find((e) => e.type === 'reservation.moved')!.summary).toContain('from Court 1 on 2026-10-11 at 14:00 to Court 1 on 2026-10-11 at 15:00')
  })
})

describe('activity log: cascades', () => {
  it('a block logs itself and every reservation it cancels, attributed to the admin', () => {
    book({ start: '10:00' })
    book({ start: '11:00', playerId: 'player-2' })
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '10:00', end: '12:00', reason: 'tournament', createdBy: 'admin-1' })
    const after = state().events.slice(2)
    expect(after.map((e) => e.type)).toEqual(['block.created', 'reservation.cancelled', 'reservation.cancelled'])
    expect(after.every((e) => e.actorId === 'admin-1')).toBe(true)
    expect(after[1].meta.reason).toBe('blocked by club')
  })
  it('deactivating a user logs the change and the cancelled reservations', () => {
    book()
    actions.setUserActive('player-1', false, 'admin-1')
    expect(types().slice(1)).toEqual(['user.deactivated', 'reservation.cancelled'])
    expect(state().events.slice(1).every((e) => e.actorId === 'admin-1' && e.subjectId === 'player-1')).toBe(true)
  })
  it('falls back to "system" when no actor is passed', () => {
    actions.setUserRole('player-3', 'coach')
    expect(last()).toMatchObject({ type: 'user.role_changed', actorId: 'system', meta: { from: 'player', to: 'coach' } })
  })
  it('waitlist promotion is a system event', () => {
    const lesson = actions.createLesson(lessonInput)
    actions.enrollInLesson(lesson.id, 'player-1')
    actions.enrollInLesson(lesson.id, 'player-2')
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.leaveLesson(lesson.id, 'player-1')
    expect(types().slice(-2)).toEqual(['lesson.left', 'lesson.waitlist_promoted'])
    const promoted = state().events.find((e) => e.type === 'lesson.waitlist_promoted')!
    expect(promoted).toMatchObject({ actorId: 'system', subjectId: 'player-3' })
  })
  it('a lesson no-show logs the attendance and the reservation it flips', () => {
    const lesson = actions.createLesson(lessonInput)
    actions.enrollInLesson(lesson.id, 'player-1')
    book({ courtId: 'court-2', start: '10:00' })
    actions.setAttendance(lesson.id, 'player-1', 'no-show')
    const tail = state().events.slice(-2)
    expect(tail.map((e) => e.type)).toEqual(['attendance.marked', 'reservation.no_show'])
    expect(tail.every((e) => e.actorId === 'coach-1')).toBe(true)
  })
})

describe('activity log: other actions', () => {
  it('covers lessons, templates, notes, courts and settings', () => {
    const lesson = actions.createLesson(lessonInput)
    actions.updateLesson(lesson.id, { title: 'Renamed', capacity: 3 }, 'admin-1')
    actions.completeLesson(lesson.id, 'coach-1')
    const tpl = actions.saveTemplate({ coachId: 'coach-1', name: 'T', title: 'X', start: '10:00', end: '11:00', capacity: 2 })
    actions.deleteTemplate(tpl.id, 'coach-1')
    actions.addNote({ coachId: 'coach-1', playerId: 'player-1', text: 'ok', rating: 4 })
    actions.createCourt({ name: 'Court 7', surface: 'clay', lights: true }, 'admin-1')
    actions.updateCourt('court-1', { lights: false }, 'admin-1')
    actions.deleteCourt('court-2', 'admin-1')
    actions.updateSettings({ peakPrice: 500 }, 'admin-1')
    const b = actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '15:00', end: '16:00', reason: 'maintenance', createdBy: 'admin-1' })
    actions.moveBlock(b.id, { start: '16:00', end: '17:00' }, 'admin-1')
    actions.deleteBlock(b.id, 'admin-1')
    expect(types()).toEqual([
      'lesson.created', 'lesson.updated', 'lesson.completed', 'template.saved', 'template.deleted', 'note.added',
      'court.created', 'court.updated', 'court.deleted', 'settings.updated', 'block.created', 'block.moved', 'block.deleted',
    ])
    expect(state().events.find((e) => e.type === 'settings.updated')!.summary).toContain('peakPrice = 500')
    expect(state().events.find((e) => e.type === 'lesson.updated')!.meta.changed).toBe('title,capacity')
  })
  it('logs enroll, leave, waitlist leave, lesson cancel and user reactivation', () => {
    const lesson = actions.createLesson(lessonInput)
    actions.enrollInLesson(lesson.id, 'player-1')
    actions.enrollInLesson(lesson.id, 'player-2')
    actions.joinWaitlist(lesson.id, 'player-3')
    actions.leaveWaitlist(lesson.id, 'player-3')
    actions.leaveLesson(lesson.id, 'player-1')
    actions.cancelLesson(lesson.id, 'coach-1')
    actions.setUserActive('player-4', false, 'admin-1')
    actions.setUserActive('player-4', true, 'admin-1')
    expect(types()).toEqual(['lesson.created', 'lesson.enrolled', 'lesson.enrolled', 'lesson.waitlist_joined', 'lesson.waitlist_left', 'lesson.left', 'lesson.cancelled', 'user.deactivated', 'user.activated'])
  })
})

describe('activity log: guarantees', () => {
  it('a failing action logs nothing', () => {
    book()
    expectCode(() => book({ playerId: 'player-2' }), 'SLOT_TAKEN')
    expect(state().events).toHaveLength(1)
  })
  it('does not log no-op updates', () => {
    actions.updateCourt('court-1', { lights: true }, 'admin-1')
    actions.updateSettings({ peakPrice: 400 }, 'admin-1')
    expect(state().events).toHaveLength(0)
  })
  it('keeps only the latest 500 events and keeps ids increasing', () => {
    const r = book()
    for (let i = 0; i < 260; i++) {
      actions.moveReservation(r.id, { start: i % 2 ? '10:00' : '11:00' }, 'admin-1')
      actions.markNotificationRead('none')
    }
    for (let i = 0; i < 260; i++) actions.moveReservation(r.id, { start: i % 2 ? '12:00' : '13:00' }, 'admin-1')
    const ids = state().events.map((e) => Number(e.id.slice(4)))
    expect(ids).toHaveLength(500)
    expect(ids[0]).toBe(ids[ids.length - 1] - 499)
  })
  it('bug=missing-events skips cancellations only', () => {
    setConfig({ bugs: ['missing-events'] })
    const r = book()
    actions.cancelReservation(r.id, 'player-1')
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '15:00', end: '16:00', reason: 'maintenance', createdBy: 'admin-1' })
    expect(types()).toEqual(['reservation.booked', 'block.created'])
  })
  it('data saved before the log existed is upgraded on read', () => {
    const old = JSON.parse(localStore().getItem(STORAGE_KEY)!)
    delete old.data.events
    localStore().setItem(STORAGE_KEY, JSON.stringify(old))
    book()
    expect(state().events).toHaveLength(1)
  })
})

describe('filterEvents', () => {
  it('filters by type, actor, involved user, entity and day, newest first', () => {
    const a = book()
    book({ playerId: 'player-2', start: '12:00', partnerId: 'player-1' })
    actions.cancelReservation(a.id, 'player-1')
    const all = filterEvents(state().events)
    expect(all.map((e) => e.type)).toEqual(['reservation.cancelled', 'reservation.booked', 'reservation.booked'])
    expect(filterEvents(state().events, { types: ['reservation.cancelled'] })).toHaveLength(1)
    expect(filterEvents(state().events, { actorId: 'player-2' })).toHaveLength(1)
    expect(filterEvents(state().events, { involvingUserId: 'player-1' })).toHaveLength(3)
    expect(filterEvents(state().events, { entity: 'block' })).toHaveLength(0)
    expect(filterEvents(state().events, { from: TOMORROW })).toHaveLength(0)
    expect(filterEvents(state().events, { from: TODAY, to: TODAY })).toHaveLength(3)
  })
})

describe('demo seed activity', () => {
  it('has a chronological history that does not run ahead of the clock', () => {
    const s = seed('demo')
    expect(s.events.length).toBeGreaterThan(40)
    expect(s.events[0].id).toBe('evt-1')
    const times = s.events.map((e) => e.createdAt)
    expect([...times].sort()).toEqual(times)
    expect(times.every((t) => t <= new Date(NOW).toISOString())).toBe(true)
    expect(s.events.some((e) => e.type === 'lesson.created')).toBe(true)
  })
  it('empty and full seeds start without activity', () => {
    expect(seed('empty').events).toEqual([])
    expect(seed('full').events).toEqual([])
    reset('demo')
    expect(state().events.length).toBeGreaterThan(0)
  })
})
