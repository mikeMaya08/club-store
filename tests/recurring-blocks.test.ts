import { describe, expect, it } from 'vitest'
import { actions, previewRecurringBlock, setConfig, type RecurringBlockInput } from '../src'
import { TOMORROW, book, expectCode, state, useFreshClub } from './helpers'

useFreshClub()

const input: RecurringBlockInput = { courtId: 'court-1', date: TOMORROW, start: '08:00', end: '10:00', reason: 'maintenance', createdBy: 'admin-1', weeks: 4 }
const series = (over: Partial<RecurringBlockInput> = {}) => actions.createRecurringBlock({ ...input, ...over })

describe('createRecurringBlock', () => {
  it('creates one block per week that share a seriesId', () => {
    const { blocks, cancelled } = series()
    expect(blocks.map((b) => b.date)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01'])
    expect(new Set(blocks.map((b) => b.seriesId)).size).toBe(1)
    expect(blocks.map((b) => b.id)).toEqual(['block-1', 'block-2', 'block-3', 'block-4'])
    expect(cancelled).toBe(0)
    expect(blocks.every((b) => b.start === '08:00' && b.end === '10:00' && b.reason === 'maintenance')).toBe(true)
  })
  it('gives each series its own id', () => {
    const a = series()
    const b = series({ courtId: 'court-2' })
    expect(a.blocks[0].seriesId).toBe('blockseries-1')
    expect(b.blocks[0].seriesId).toBe('blockseries-2')
  })
  it('makes the slots unavailable to players', () => {
    series()
    expectCode(() => book({ start: '09:00' }), 'SLOT_TAKEN')
    expectCode(() => book({ date: '2026-10-25', start: '08:00' }), 'SLOT_TAKEN')
    expect(book({ date: '2026-10-12', start: '09:00' }).status).toBe('booked') // a day that is not part of the series
  })
  it('cancels the reservations of every week and notifies each player (rule 8)', () => {
    book({ start: '09:00' })
    book({ date: '2026-10-25', start: '08:00', playerId: 'player-2' })
    book({ date: '2026-10-18', start: '11:00', playerId: 'player-3' }) // outside the blocked hours
    const { cancelled } = series()
    expect(cancelled).toBe(2)
    const s = state()
    expect(s.reservations.filter((r) => r.status === 'cancelled').map((r) => r.cancelReason)).toEqual(['blocked by club', 'blocked by club'])
    expect(s.reservations.find((r) => r.playerId === 'player-3')?.status).toBe('booked')
    expect(s.notifications.filter((n) => n.type === 'reservation-cancelled').map((n) => n.userId).sort()).toEqual(['player-1', 'player-2'])
  })
  it('is all-or-nothing and names the week that conflicts', () => {
    actions.createBlock({ courtId: 'court-1', date: '2026-10-25', start: '09:00', end: '11:00', reason: 'tournament', createdBy: 'admin-1' })
    const reservation = book({ start: '08:00' })
    try {
      series()
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { code: string }).code).toBe('SLOT_TAKEN')
      expect((e as Error).message).toContain('2026-10-25')
    }
    expect(state().blocks).toHaveLength(1)
    expect(state().reservations.find((r) => r.id === reservation.id)?.status).toBe('booked') // nothing was cancelled
  })
  it('rejects weeks that overlap a lesson', () => {
    actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: '2026-10-18', start: '09:00', end: '10:00', title: 'Drills', capacity: 2 })
    expectCode(() => series(), 'SLOT_TAKEN')
    expect(state().blocks).toHaveLength(1) // only the lesson's own block
  })
  it('validates the number of weeks, the reason and the time range', () => {
    expectCode(() => series({ weeks: 1 }), 'VALIDATION')
    expectCode(() => series({ weeks: 13 }), 'VALIDATION')
    expectCode(() => series({ weeks: 2.5 }), 'VALIDATION')
    expectCode(() => series({ reason: 'lesson' }), 'INVALID_STATE')
    expectCode(() => series({ start: '10:00', end: '08:00' }), 'INVALID_SLOT')
  })
  it('needs an active admin and an existing court', () => {
    actions.setUserActive('admin-1', false)
    expectCode(() => series(), 'USER_INACTIVE')
    expectCode(() => series({ createdBy: 'ghost' }), 'NOT_FOUND')
    expectCode(() => series({ courtId: 'court-99', createdBy: 'coach-1' }), 'NOT_FOUND')
  })
  it('logs one series event plus a cancellation per affected reservation, as the admin', () => {
    book({ start: '09:00' })
    series()
    const tail = state().events.slice(1)
    expect(tail.map((e) => e.type)).toEqual(['block.series_created', 'reservation.cancelled'])
    expect(tail.every((e) => e.actorId === 'admin-1')).toBe(true)
    expect(tail[0].meta).toMatchObject({ seriesId: 'blockseries-1', weeks: 4, reason: 'maintenance' })
  })
})

describe('deleteBlockSeries', () => {
  it('removes the upcoming occurrences and keeps the past ones', () => {
    const { blocks } = series({ date: '2026-10-09', weeks: 4 }) // 10-09 is before the clock (10-10 10:00); the rest are upcoming
    expect(actions.deleteBlockSeries(blocks[0].seriesId!, 'admin-1')).toBe(3)
    expect(state().blocks.map((b) => b.date)).toEqual(['2026-10-09'])
  })
  it('frees the slots again', () => {
    const { blocks } = series()
    actions.deleteBlockSeries(blocks[0].seriesId!, 'admin-1')
    expect(book({ start: '09:00' }).status).toBe('booked')
  })
  it('does not bring cancelled reservations back', () => {
    const r = book({ start: '09:00' })
    const { blocks } = series()
    actions.deleteBlockSeries(blocks[0].seriesId!, 'admin-1')
    expect(state().reservations.find((x) => x.id === r.id)?.status).toBe('cancelled')
  })
  it('reports unknown series, nothing upcoming and inactive admins', () => {
    expectCode(() => actions.deleteBlockSeries('blockseries-99', 'admin-1'), 'NOT_FOUND')
    const { blocks } = series({ date: '2026-10-01', weeks: 2 }) // both in the past
    expectCode(() => actions.deleteBlockSeries(blocks[0].seriesId!, 'admin-1'), 'NOT_FOUND')
    actions.setUserActive('admin-1', false)
    expectCode(() => actions.deleteBlockSeries(blocks[0].seriesId!, 'admin-1'), 'USER_INACTIVE')
  })
  it('logs the removal', () => {
    const { blocks } = series()
    actions.deleteBlockSeries(blocks[0].seriesId!, 'admin-1')
    expect(state().events.slice(-1)[0]).toMatchObject({ type: 'block.series_deleted', actorId: 'admin-1', meta: { seriesId: 'blockseries-1', removed: 4 } })
  })
  it('a single occurrence can still be moved or deleted on its own', () => {
    const { blocks } = series()
    expect(actions.moveBlock(blocks[1].id, { start: '12:00', end: '14:00' }, 'admin-1').seriesId).toBe(blocks[1].seriesId)
    actions.deleteBlock(blocks[2].id, 'admin-1')
    expect(state().blocks).toHaveLength(3)
  })
})

describe('previewRecurringBlock', () => {
  it('lists the dates, the weeks that would conflict and the reservations that would be cancelled', () => {
    actions.createBlock({ courtId: 'court-1', date: '2026-10-18', start: '09:00', end: '10:00', reason: 'tournament', createdBy: 'admin-1' })
    const r = book({ start: '09:00' })
    const preview = previewRecurringBlock(state(), input)
    expect(preview.dates).toHaveLength(4)
    expect(preview.conflicts).toEqual([{ date: '2026-10-18', what: 'a tournament block (09:00-10:00)' }])
    expect(preview.reservations.map((x) => x.id)).toEqual([r.id])
  })
  it('changes nothing', () => {
    book({ start: '09:00' })
    const before = JSON.stringify(state())
    previewRecurringBlock(state(), input)
    expect(JSON.stringify(state())).toBe(before)
  })
  it('predicts what createRecurringBlock then does', () => {
    book({ start: '09:00' })
    book({ date: '2026-10-25', start: '08:00', playerId: 'player-2' })
    const preview = previewRecurringBlock(state(), input)
    expect(preview.conflicts).toEqual([])
    expect(series().cancelled).toBe(preview.reservations.length)
  })
})

describe('data and bugs', () => {
  it('blocks saved before series existed keep working', () => {
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '15:00', end: '16:00', reason: 'maintenance', createdBy: 'admin-1' })
    expect(state().blocks[0].seriesId).toBeUndefined()
    expect(series().blocks[0].seriesId).toBe('blockseries-1')
  })
  it('bug=missing-events still logs the series creation but not the cancellations', () => {
    setConfig({ bugs: ['missing-events'] })
    book({ start: '09:00' })
    series()
    expect(state().events.map((e) => e.type)).toEqual(['reservation.booked', 'block.series_created'])
  })
})
