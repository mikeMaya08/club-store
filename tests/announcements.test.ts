import { describe, expect, it } from 'vitest'
import { STORAGE_KEY, actions, announcementsFor, isAnnouncementActive, reset, seed } from '../src'
import { localStore } from '../src/storage'
import { TODAY, TOMORROW, expectCode, state, useFreshClub } from './helpers'

useFreshClub()

const post = (over: Partial<Parameters<typeof actions.createAnnouncement>[0]> = {}, actorId = 'admin-1') =>
  actions.createAnnouncement({ title: 'Closed Monday', body: 'The club is closed on Monday.', audience: 'all', ...over }, actorId)
const visible = (userId: string) => announcementsFor(state(), userId, TODAY).map((a) => a.id)

describe('announcements: creating', () => {
  it('creates an announcement with defaults and trims the text', () => {
    const a = post({ title: '  Hello  ', body: ' World ' })
    expect(a).toMatchObject({ id: 'announcement-1', title: 'Hello', body: 'World', audience: 'all', pinned: false, authorId: 'admin-1', dismissedBy: [] })
    expect(a.expiresOn).toBeUndefined()
    expect(state().announcements).toHaveLength(1)
  })
  it('only admins can post', () => {
    expectCode(() => post({}, 'coach-1'), 'INVALID_STATE')
    expectCode(() => post({}, 'player-1'), 'INVALID_STATE')
  })
  it('rejects an empty title, an empty body and text that is too long', () => {
    expectCode(() => post({ title: '   ' }), 'VALIDATION')
    expectCode(() => post({ body: '' }), 'VALIDATION')
    expectCode(() => post({ title: 'x'.repeat(81) }), 'VALIDATION')
    expectCode(() => post({ body: 'x'.repeat(501) }), 'VALIDATION')
    expect(state().announcements).toHaveLength(0)
  })
  it('rejects an unknown audience and an expiry date in the past', () => {
    expectCode(() => post({ audience: 'everyone' as never }), 'VALIDATION')
    expectCode(() => post({ expiresOn: '2026-10-09' }), 'VALIDATION')
    expect(() => post({ expiresOn: TODAY })).not.toThrow()
  })
  it('notifies the active users of the audience, and nobody else', () => {
    actions.setUserActive('player-2', false)
    post({ audience: 'players' })
    const to = state().notifications.filter((n) => n.type === 'announcement').map((n) => n.userId)
    expect(to).toContain('player-1')
    expect(to).not.toContain('player-2') // inactive
    expect(to).not.toContain('coach-1')
    expect(to).not.toContain('admin-1')
  })
  it('an "all" announcement notifies players and coaches', () => {
    post()
    const to = new Set(state().notifications.filter((n) => n.type === 'announcement').map((n) => n.userId))
    expect(to.has('player-1') && to.has('coach-1')).toBe(true)
    expect(to.has('admin-1')).toBe(false)
  })
  it('logs the creation in the activity log', () => {
    const a = post({ pinned: true })
    const e = state().events[state().events.length - 1]
    expect(e).toMatchObject({ type: 'announcement.created', actorId: 'admin-1', entity: 'announcement', entityId: a.id, meta: { audience: 'all', pinned: true } })
  })
})

describe('announcements: who sees what', () => {
  it('filters by audience', () => {
    const all = post()
    const players = post({ audience: 'players' })
    const coaches = post({ audience: 'coaches' })
    expect(visible('player-1').sort()).toEqual([all.id, players.id].sort())
    expect(visible('coach-1').sort()).toEqual([all.id, coaches.id].sort())
  })
  it('admins get an empty list (they manage the full list)', () => {
    post()
    expect(visible('admin-1')).toEqual([])
  })
  it('hides expired announcements, but still shows them on the expiry day', () => {
    const a = post({ expiresOn: TOMORROW })
    expect(isAnnouncementActive(a, TOMORROW)).toBe(true)
    expect(isAnnouncementActive(a, '2026-10-12')).toBe(false)
    expect(announcementsFor(state(), 'player-1', TOMORROW)).toHaveLength(1)
    expect(announcementsFor(state(), 'player-1', '2026-10-12')).toHaveLength(0)
  })
  it('lists pinned first, then the newest', () => {
    const first = post({ title: 'First' })
    const pinned = post({ title: 'Pinned', pinned: true })
    const newest = post({ title: 'Newest' })
    expect(visible('player-1')).toEqual([pinned.id, newest.id, first.id])
  })
  it('returns nothing for an unknown user', () => {
    post()
    expect(visible('ghost')).toEqual([])
  })
})

describe('announcements: dismissing and deleting', () => {
  it('dismissing hides it for that user only', () => {
    const a = post()
    actions.dismissAnnouncement(a.id, 'player-1')
    expect(visible('player-1')).toEqual([])
    expect(visible('player-2')).toEqual([a.id])
    expect(visible('coach-1')).toEqual([a.id])
  })
  it('dismissing twice is harmless', () => {
    const a = post()
    actions.dismissAnnouncement(a.id, 'player-1')
    actions.dismissAnnouncement(a.id, 'player-1')
    expect(state().announcements[0].dismissedBy).toEqual(['player-1'])
  })
  it('pinned announcements cannot be dismissed', () => {
    const a = post({ pinned: true })
    expectCode(() => actions.dismissAnnouncement(a.id, 'player-1'), 'INVALID_STATE')
    expect(visible('player-1')).toEqual([a.id])
  })
  it('dismissing an unknown announcement fails', () => {
    expectCode(() => actions.dismissAnnouncement('announcement-99', 'player-1'), 'NOT_FOUND')
  })
  it('an admin deletes an announcement for everyone and it is logged', () => {
    const a = post()
    actions.deleteAnnouncement(a.id, 'admin-1')
    expect(state().announcements).toHaveLength(0)
    expect(visible('player-1')).toEqual([])
    expect(state().events[state().events.length - 1]).toMatchObject({ type: 'announcement.deleted', entityId: a.id })
  })
  it('non-admins cannot delete, and unknown ids fail', () => {
    const a = post()
    expectCode(() => actions.deleteAnnouncement(a.id, 'coach-1'), 'INVALID_STATE')
    expectCode(() => actions.deleteAnnouncement('announcement-99', 'admin-1'), 'NOT_FOUND')
    expect(state().announcements).toHaveLength(1)
  })
  it('ids are not reused after a delete', () => {
    post()
    const b = post({ title: 'B' })
    actions.deleteAnnouncement('announcement-1', 'admin-1')
    expect(post({ title: 'C' }).id).toBe('announcement-3')
    expect(b.id).toBe('announcement-2')
  })
})

describe('announcements: seed and old data', () => {
  it('the demo seed has announcements for every audience plus an expired one', () => {
    reset('demo')
    const all = state().announcements
    expect(all.map((a) => a.audience).sort()).toEqual(['all', 'all', 'coaches', 'players'])
    expect(all.some((a) => a.pinned)).toBe(true)
    expect(announcementsFor(state(), 'player-1', TODAY).map((a) => a.id)).toEqual(['announcement-1', 'announcement-2'])
    expect(announcementsFor(state(), 'coach-1', TODAY).map((a) => a.id)).toEqual(['announcement-1', 'announcement-3'])
  })
  it('the empty and full seeds have none', () => {
    expect(seed('empty').announcements).toEqual([])
    expect(seed('full').announcements).toEqual([])
  })
  it('data saved before announcements existed still loads', () => {
    const old: Record<string, unknown> = { ...seed('empty') }
    delete old.announcements
    localStore().setItem(STORAGE_KEY, JSON.stringify(old))
    expect(state().announcements).toEqual([])
    expect(() => post()).not.toThrow()
  })
})
