import { describe, expect, it, vi } from 'vitest'
import {
  STORAGE_KEY,
  actions,
  api,
  clock,
  commit,
  getState,
  parseBugs,
  priceFor,
  reset,
  seed,
  setConfig,
  slotStatus,
  subscribe,
  syncFromStorage,
} from '../src'
import { localStore } from '../src/storage'
import { TODAY, TOMORROW, book, expectCode, state, useFreshClub } from './helpers'

describe('store', () => {
  useFreshClub()

  it('persists under club:v1 as { version, data, updatedAt }', () => {
    book()
    const raw = localStore().getItem(STORAGE_KEY)
    const saved = JSON.parse(raw ?? 'null')
    expect(saved.version).toBe(1)
    expect(saved.data.reservations).toHaveLength(1)
    expect(typeof saved.updatedAt).toBe('string')
  })

  it('writes nothing when the mutator throws', () => {
    expect(() =>
      commit((s) => {
        s.reservations.push({} as never)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(state().reservations).toHaveLength(0)
  })

  it('rejects invalid state with VALIDATION', () => {
    expectCode(
      () =>
        commit((s) => {
          s.users[0].email = 'not-an-email'
        }),
      'VALIDATION',
    )
    expect(state().users[0].email).toContain('@')
  })

  it('notifies subscribers on commit', () => {
    const listener = vi.fn()
    const off = subscribe(listener)
    book()
    off()
    book({ playerId: 'player-2', start: '11:00' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('throws NETWORK_ERROR when flaky=1 and succeeds when flaky=0', () => {
    setConfig({ flaky: 1 })
    expectCode(() => book(), 'NETWORK_ERROR')
    expect(state().reservations).toHaveLength(0)
    setConfig({ flaky: 0 })
    expect(book().status).toBe('booked')
  })

  it('api.* waits for the configured latency', async () => {
    setConfig({ latency: 30 })
    const t0 = Date.now()
    const r = await api.bookReservation({ courtId: 'court-1', playerId: 'player-1', date: TOMORROW, start: '10:00' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    expect(r.id).toBe('res-1')
  })

  it('stale-ui ignores external sync, normal mode applies it', () => {
    const listener = vi.fn()
    const off = subscribe(listener)
    setConfig({ bugs: ['stale-ui'] })
    syncFromStorage()
    expect(listener).not.toHaveBeenCalled()
    setConfig({ bugs: [] })
    syncFromStorage()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('generates sequential ids', () => {
    expect(book().id).toBe('res-1')
    expect(book({ playerId: 'player-2', start: '11:00' }).id).toBe('res-2')
  })
})

describe('clock', () => {
  useFreshClub()
  it('uses the ?now override', () => {
    expect(clock.now().getHours()).toBe(10)
    expect(clock.today()).toBe(TODAY)
    clock.set('2027-01-02T03:04')
    expect(clock.today()).toBe('2027-01-02')
  })
  it('falls back to real time without an override', () => {
    clock.set(null)
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000)
  })
  it('parses bug lists and drops unknown names', () => {
    expect(parseBugs('wrong-price, nope ,stale-ui')).toEqual(['wrong-price', 'stale-ui'])
  })
})

describe('slotStatus', () => {
  useFreshClub()
  const status = (courtId: string, start: string, date = TOMORROW) => slotStatus(state(), courtId, date, start, clock.now())

  it('reports every cell state', () => {
    expect(status('court-1', '10:00')).toBe('available')
    expect(status('court-1', '09:00', TODAY)).toBe('past')
    expect(status('court-4', '10:00')).toBe('inactive')
    expect(status('court-5', '19:00')).toBe('no-lights')
    book({ start: '11:00' })
    expect(status('court-1', '11:00')).toBe('taken')
    actions.createBlock({ courtId: 'court-1', date: TOMORROW, start: '12:00', end: '13:00', reason: 'maintenance', createdBy: 'admin-1' })
    expect(status('court-1', '12:00')).toBe('blocked')
    actions.createLesson({ coachId: 'coach-1', courtId: 'court-1', date: TOMORROW, start: '13:00', end: '14:00', title: 'L', capacity: 2 })
    expect(status('court-1', '13:00')).toBe('lesson')
  })

  it('shows no-lights after an admin switches lights off', () => {
    expect(status('court-1', '19:00')).toBe('available')
    actions.updateCourt('court-1', { lights: false })
    expect(status('court-1', '19:00')).toBe('no-lights')
  })

  it('priceFor ignores the wrong-price bug (display price stays correct)', () => {
    setConfig({ bugs: ['wrong-price'] })
    expect(priceFor(state().settings, '18:00')).toBe(400)
  })
})

describe('seeds', () => {
  useFreshClub()

  it('are deterministic', () => {
    expect(seed('demo')).toEqual(seed('demo'))
    expect(seed('full')).toEqual(seed('full'))
  })

  it('empty has users and courts only', () => {
    const s = seed('empty')
    expect(s.users).toHaveLength(15)
    expect(s.courts).toHaveLength(6)
    expect(s.reservations.length + s.lessons.length + s.blocks.length + s.notes.length + s.notifications.length).toBe(0)
  })

  it('demo has the promised shape', () => {
    const s = seed('demo')
    expect(s.users.filter((u) => u.role === 'admin')).toHaveLength(1)
    expect(s.users.filter((u) => u.role === 'coach')).toHaveLength(2)
    expect(s.users.filter((u) => u.role === 'player')).toHaveLength(12)
    expect(s.courts.filter((c) => !c.lights)).toHaveLength(2)
    expect(s.courts.filter((c) => !c.active)).toHaveLength(1)
    expect(s.reservations).toHaveLength(40)
    expect(s.lessons).toHaveLength(4)
    expect(s.lessons.filter((l) => l.studentIds.length >= l.capacity)).toHaveLength(1)
    expect(s.notes.length).toBeGreaterThan(0)
    expect(s.notifications.length).toBeGreaterThan(0)
    expect(s.reservations[0].id).toBe('res-1')
  })

  it('demo has no overlapping active reservations and respects the player limit', () => {
    reset('demo')
    const s = state()
    const live = s.reservations.filter((r) => r.status !== 'cancelled')
    for (const r of live) {
      const clashes = [...live, ...s.blocks.map((b) => ({ ...b, id: b.id }))].filter(
        (o) => o.id !== r.id && o.courtId === r.courtId && o.date === r.date && o.start < r.end && r.start < o.end,
      )
      expect(clashes).toEqual([])
    }
    for (const u of s.users) {
      const future = s.reservations.filter((r) => r.playerId === u.id && r.status === 'booked' && r.date + r.start > `${TODAY}10:00`)
      expect(future.length).toBeLessThanOrEqual(2)
    }
  })

  it('full books ~90% of the next 3 days', () => {
    const s = seed('full')
    const lit = s.courts.filter((c) => c.active)
    let cells = 0
    for (const c of lit) cells += (c.lights ? 15 : 12) * 3
    const ratio = s.reservations.length / cells
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(0.97)
    expect(s.reservations.every((r) => r.date > TODAY)).toBe(true)
  })

  it('full leaves player-1..6 free to book', () => {
    reset('full')
    const free = ['court-1', 'court-2', 'court-3', 'court-5', 'court-6'].flatMap((courtId) =>
      ['07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']
        .filter((start) => !state().reservations.some((r) => r.courtId === courtId && r.date === TOMORROW && r.start === start))
        .map((start) => ({ courtId, start })),
    )
    expect(free.length).toBeGreaterThan(0)
    expect(book(free[0]).status).toBe('booked')
  })
})
