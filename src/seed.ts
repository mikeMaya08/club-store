import { addDays, format, parseISO } from 'date-fns'
import { clock } from './clock'
import { priceFor } from './pricing'
import { at, slotsFor } from './time'
import type { ClubEvent, Court, Lesson, Reservation, Settings, SeedName, State, User } from './types'

/** Small deterministic PRNG so seeds are identical on every run. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899']

const PLAYER_NAMES = [
  'Lucía Fernández', 'Mateo Rojas', 'Valentina Cruz', 'Diego Herrera', 'Camila Ortiz', 'Santiago Vega',
  'Sofía Navarro', 'Emilio Castillo', 'Isabella Reyes', 'Andrés Molina', 'Renata Salazar', 'Joaquín Paredes',
]

export const DEFAULT_SETTINGS: Settings = {
  openHour: 7,
  closeHour: 22,
  slotMinutes: 60,
  lightsRequiredFrom: '19:00',
  peakStart: '18:00',
  peakEnd: '21:00',
  basePrice: 250,
  peakPrice: 400,
  maxActiveReservations: 2,
  cancelHoursLimit: 4,
  currency: 'MXN',
}

function makeUsers(): User[] {
  const users: User[] = [
    { id: 'admin-1', name: 'Ana Admin', email: 'ana.admin@club.test', role: 'admin', level: 5, active: true, avatarColor: COLORS[0] },
    { id: 'coach-1', name: 'Carlos Coach', email: 'carlos.coach@club.test', role: 'coach', level: 5, active: true, avatarColor: COLORS[1] },
    { id: 'coach-2', name: 'Elena Coach', email: 'elena.coach@club.test', role: 'coach', level: 5, active: true, avatarColor: COLORS[2] },
  ]
  PLAYER_NAMES.forEach((name, i) => {
    users.push({
      id: `player-${i + 1}`,
      name,
      email: `player${i + 1}@club.test`,
      role: 'player',
      level: ((i % 5) + 1) as User['level'],
      active: true,
      avatarColor: COLORS[i % COLORS.length],
    })
  })
  return users
}

function makeCourts(): Court[] {
  return [
    { id: 'court-1', name: 'Court 1', surface: 'clay', lights: true, active: true },
    { id: 'court-2', name: 'Court 2', surface: 'hard', lights: true, active: true },
    { id: 'court-3', name: 'Court 3', surface: 'clay', lights: true, active: true },
    { id: 'court-4', name: 'Court 4', surface: 'hard', lights: true, active: false },
    { id: 'court-5', name: 'Court 5', surface: 'clay', lights: false, active: true },
    { id: 'court-6', name: 'Court 6', surface: 'hard', lights: false, active: true },
  ]
}

const emptyState = (): State => ({
  users: makeUsers(),
  courts: makeCourts(),
  reservations: [],
  blocks: [],
  lessons: [],
  lessonTemplates: [],
  events: [],
  notes: [],
  notifications: [],
  settings: { ...DEFAULT_SETTINGS },
})

const BOOKABLE_COURTS = ['court-1', 'court-2', 'court-3', 'court-5', 'court-6']

export function seed(name: SeedName): State {
  const state = emptyState()
  if (name === 'demo') fillDemo(state)
  if (name === 'full') fillFull(state)
  return state
}

const day = (offset: number) => format(addDays(parseISO(clock.today()), offset), 'yyyy-MM-dd')
const iso = (date: string, time: string, shiftDays = 0) => addDays(at(date, time), shiftDays).toISOString()

function fillDemo(s: State) {
  const rand = mulberry32(42)
  const now = clock.now()
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]

  // Lessons first (each one gets its block), so reservations can avoid them.
  const lessonDefs: Array<Omit<Lesson, 'id' | 'date'> & { offset: number }> = [
    { offset: 1, coachId: 'coach-1', courtId: 'court-1', start: '17:00', end: '18:00', title: 'Beginner Drills', capacity: 4, studentIds: ['player-1', 'player-2'], status: 'scheduled', attendance: {}, waitlist: [] },
    { offset: 2, coachId: 'coach-2', courtId: 'court-3', start: '10:00', end: '11:00', title: 'Serve Clinic', capacity: 6, studentIds: ['player-3', 'player-4', 'player-5'], status: 'scheduled', attendance: {}, waitlist: [] },
    { offset: 3, coachId: 'coach-1', courtId: 'court-2', start: '17:00', end: '18:00', title: 'Advanced Rallies', capacity: 3, studentIds: ['player-6', 'player-7', 'player-8'], status: 'scheduled', attendance: {}, waitlist: [] },
    { offset: -2, coachId: 'coach-1', courtId: 'court-1', start: '17:00', end: '18:00', title: 'Footwork Basics', capacity: 4, studentIds: ['player-1', 'player-2', 'player-9'], status: 'done', attendance: { 'player-1': 'present', 'player-2': 'present', 'player-9': 'no-show' }, waitlist: [] },
  ]
  lessonDefs.forEach(({ offset, ...rest }, i) => {
    const lesson: Lesson = { id: `lesson-${i + 1}`, date: day(offset), ...rest }
    if (lesson.id === 'lesson-3') lesson.waitlist = ['player-10'] // the full lesson already has someone waiting
    s.lessons.push(lesson)
    s.blocks.push({ id: `block-${i + 1}`, courtId: lesson.courtId, date: lesson.date, start: lesson.start, end: lesson.end, reason: 'lesson', lessonId: lesson.id, createdBy: lesson.coachId })
  })
  s.blocks.push(
    { id: 'block-5', courtId: 'court-2', date: day(1), start: '08:00', end: '10:00', reason: 'maintenance', createdBy: 'admin-1' },
    { id: 'block-6', courtId: 'court-1', date: day(4), start: '09:00', end: '12:00', reason: 'tournament', createdBy: 'admin-1' },
  )

  // ~40 reservations spread over the last and next 7 days.
  const slots = slotsFor(s.settings)
  const draft: Omit<Reservation, 'id'>[] = []
  const futureBooked = new Map<string, number>()
  const taken = (courtId: string, date: string, start: string) =>
    draft.some((r) => r.courtId === courtId && r.date === date && r.start === start) ||
    s.blocks.some((b) => b.courtId === courtId && b.date === date && b.start <= start && start < b.end)

  for (let attempt = 0; attempt < 3000 && draft.length < 40; attempt++) {
    const date = day(Math.floor(rand() * 15) - 7)
    const courtId = pick(BOOKABLE_COURTS)
    const slot = pick(slots)
    const court = s.courts.find((c) => c.id === courtId)!
    if (!court.lights && slot.start >= s.settings.lightsRequiredFrom) continue
    if (taken(courtId, date, slot.start)) continue

    const playerId = `player-${1 + Math.floor(rand() * 12)}`
    const isFuture = at(date, slot.start) > now
    const roll = rand()
    let status: Reservation['status']
    if (isFuture) status = roll < 0.9 ? 'booked' : 'cancelled'
    else status = roll < 0.7 ? 'completed' : roll < 0.82 ? 'no-show' : 'cancelled'
    if (status === 'booked') {
      const count = futureBooked.get(playerId) ?? 0
      if (count >= s.settings.maxActiveReservations) continue
      futureBooked.set(playerId, count + 1)
    }
    const partnerId = rand() < 0.25 ? `player-${1 + Math.floor(rand() * 12)}` : undefined
    draft.push({
      courtId,
      playerId,
      partnerId: partnerId === playerId ? undefined : partnerId,
      date,
      start: slot.start,
      end: slot.end,
      status,
      price: priceFor(s.settings, slot.start),
      cancelReason: status === 'cancelled' ? 'cancelled by player' : undefined,
      createdAt: iso(date, slot.start, -2),
    })
  }
  draft
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .forEach((r, i) => s.reservations.push({ id: `res-${i + 1}`, ...r }))

  s.lessonTemplates.push(
    { id: 'template-1', coachId: 'coach-1', name: 'Beginner evening', title: 'Beginner Drills', start: '17:00', end: '18:00', capacity: 4 },
    { id: 'template-2', coachId: 'coach-1', name: 'Morning serve work', title: 'Serve Clinic', courtId: 'court-3', start: '09:00', end: '10:30', capacity: 6 },
  )

  const stamp = (offset: number, time: string) => iso(day(offset), time)
  s.notes.push(
    { id: 'note-1', coachId: 'coach-1', playerId: 'player-1', lessonId: 'lesson-4', text: '<p>Great <b>footwork</b> today. Keep the split step.</p>', rating: 4, createdAt: stamp(-2, '18:30') },
    { id: 'note-2', coachId: 'coach-1', playerId: 'player-2', lessonId: 'lesson-4', text: '<p>Needs to <i>recover</i> faster after the forehand.</p>', rating: 3, createdAt: stamp(-2, '18:35') },
    { id: 'note-3', coachId: 'coach-1', playerId: 'player-9', text: '<p>Missed the session. Reschedule drills.</p>', rating: 2, createdAt: stamp(-2, '18:40') },
    { id: 'note-4', coachId: 'coach-2', playerId: 'player-3', text: '<ul><li>Toss placement</li><li>Knee bend</li></ul>', rating: 5, createdAt: stamp(-5, '12:00') },
    { id: 'note-5', coachId: 'coach-2', playerId: 'player-4', text: '<p>Solid backhand. Work on second serve.</p>', rating: 4, createdAt: stamp(-6, '11:00') },
    { id: 'note-6', coachId: 'coach-1', playerId: 'player-1', text: '<p>Ready to move up a level.</p>', rating: 5, createdAt: stamp(-4, '10:00') },
  )
  const notif = (userId: string, type: string, message: string, read: boolean, offset: number) =>
    s.notifications.push({ id: `notif-${s.notifications.length + 1}`, userId, type, message, read, createdAt: stamp(offset, '09:00') })
  notif('player-1', 'lesson-enrolled', 'You are enrolled in Beginner Drills.', false, -1)
  notif('player-1', 'welcome', 'Welcome to Baseline Tennis Club!', true, -7)
  notif('player-2', 'lesson-enrolled', 'You are enrolled in Beginner Drills.', false, -1)
  notif('player-3', 'reservation-cancelled', 'Your reservation was cancelled: blocked by club.', false, -1)
  notif('player-6', 'lesson-enrolled', 'You are enrolled in Advanced Rallies.', true, -1)
  notif('admin-1', 'info', 'Weekly report is ready.', false, 0)
  notif('coach-1', 'info', 'Advanced Rallies is now full.', false, 0)
  notif('coach-2', 'info', 'Serve Clinic has 3 seats left.', true, 0)

  seedEvents(s, now)
}

/** Gives the demo an activity history that matches its reservations, lessons and notes. */
function seedEvents(s: State, now: Date) {
  const name = (id: string) => s.users.find((u) => u.id === id)?.name ?? id
  const court = (id: string) => s.courts.find((c) => c.id === id)?.name ?? id
  const events: Omit<ClubEvent, 'id'>[] = []
  for (const r of s.reservations) {
    const where = `${court(r.courtId)} on ${r.date} at ${r.start}`
    events.push({
      type: 'reservation.booked', actorId: r.playerId, subjectId: r.partnerId, entity: 'reservation', entityId: r.id,
      summary: `${name(r.playerId)} booked ${where}${r.partnerId ? ` with ${name(r.partnerId)}` : ''}`,
      meta: { courtId: r.courtId, date: r.date, start: r.start, price: r.price }, createdAt: r.createdAt,
    })
    if (r.status === 'cancelled') {
      events.push({
        type: 'reservation.cancelled', actorId: r.playerId, subjectId: r.playerId, entity: 'reservation', entityId: r.id,
        summary: `${name(r.playerId)} cancelled the reservation of ${name(r.playerId)} on ${where}`,
        meta: { reason: r.cancelReason ?? '' }, createdAt: iso(r.date, r.start, -1),
      })
    }
    if (r.status === 'no-show') {
      events.push({
        type: 'reservation.no_show', actorId: 'admin-1', subjectId: r.playerId, entity: 'reservation', entityId: r.id,
        summary: `${name('admin-1')} marked ${name(r.playerId)} as no-show on ${where}`, meta: {}, createdAt: iso(r.date, r.end),
      })
    }
  }
  for (const l of s.lessons) {
    events.push({
      type: 'lesson.created', actorId: l.coachId, entity: 'lesson', entityId: l.id,
      summary: `${name(l.coachId)} created "${l.title}" on ${court(l.courtId)} on ${l.date} at ${l.start}–${l.end}`,
      meta: { capacity: l.capacity, courtId: l.courtId, date: l.date, start: l.start }, createdAt: iso(l.date, '08:00', -5),
    })
    l.studentIds.forEach((id, i) =>
      events.push({
        type: 'lesson.enrolled', actorId: id, entity: 'lesson', entityId: l.id,
        summary: `${name(id)} enrolled in "${l.title}"`, meta: { seatsLeft: l.capacity - i - 1 }, createdAt: iso(l.date, '08:00', -4),
      }),
    )
  }
  for (const n of s.notes) {
    events.push({
      type: 'note.added', actorId: n.coachId, subjectId: n.playerId, entity: 'note', entityId: n.id,
      summary: `${name(n.coachId)} wrote a note about ${name(n.playerId)}`, meta: { rating: n.rating }, createdAt: n.createdAt,
    })
  }
  const cutoff = now.toISOString()
  events
    .filter((e) => e.createdAt <= cutoff)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((e, i) => s.events.push({ id: `evt-${i + 1}`, ...e }))
}

function fillFull(s: State) {
  const rand = mulberry32(7)
  const slots = slotsFor(s.settings)
  const fillers = ['player-7', 'player-8', 'player-9', 'player-10', 'player-11', 'player-12']
  const createdAt = clock.now().toISOString()
  let n = 0
  for (let offset = 1; offset <= 3; offset++) {
    const date = day(offset)
    for (const courtId of BOOKABLE_COURTS) {
      const court = s.courts.find((c) => c.id === courtId)!
      for (const slot of slots) {
        if (!court.lights && slot.start >= s.settings.lightsRequiredFrom) continue
        if (rand() >= 0.9) continue
        n++
        s.reservations.push({
          id: `res-${n}`, courtId, playerId: fillers[n % fillers.length], date, start: slot.start, end: slot.end,
          status: 'booked', price: priceFor(s.settings, slot.start), createdAt,
        })
      }
    }
  }
}
