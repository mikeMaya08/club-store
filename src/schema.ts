import { z } from 'zod'

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const roleSchema = z.enum(['player', 'admin', 'coach'])
const level = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])

export const userSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().email(),
  role: roleSchema,
  level,
  active: z.boolean(),
  avatarColor: z.string(),
})

export const courtSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  surface: z.enum(['clay', 'hard']),
  lights: z.boolean(),
  active: z.boolean(),
})

export const reservationSchema = z.object({
  id: z.string(),
  courtId: z.string(),
  playerId: z.string(),
  partnerId: z.string().optional(),
  /** Set on every occurrence of a weekly recurring booking. */
  seriesId: z.string().optional(),
  date,
  start: time,
  end: time,
  status: z.enum(['booked', 'cancelled', 'no-show', 'completed']),
  price: z.number().nonnegative(),
  cancelReason: z.string().optional(),
  createdAt: z.string(),
})

export const blockSchema = z.object({
  id: z.string(),
  courtId: z.string(),
  date,
  start: time,
  end: time,
  reason: z.enum(['maintenance', 'tournament', 'lesson']),
  lessonId: z.string().optional(),
  createdBy: z.string(),
})

export const lessonSchema = z.object({
  id: z.string(),
  coachId: z.string(),
  courtId: z.string(),
  date,
  start: time,
  end: time,
  title: z.string().min(1),
  studentIds: z.array(z.string()),
  capacity: z.number().int().min(1),
  status: z.enum(['scheduled', 'done', 'cancelled']),
  attendance: z.record(z.string(), z.enum(['present', 'no-show'])),
  /** Players waiting for a seat, in order. */
  waitlist: z.array(z.string()).default([]),
})

export const lessonTemplateSchema = z.object({
  id: z.string(),
  coachId: z.string(),
  name: z.string().min(1),
  title: z.string().min(1),
  courtId: z.string().optional(),
  start: time,
  end: time,
  capacity: z.number().int().min(1),
})

export const noteSchema = z.object({
  id: z.string(),
  coachId: z.string(),
  playerId: z.string(),
  lessonId: z.string().optional(),
  text: z.string(),
  rating: z.number().int().min(1).max(5),
  createdAt: z.string(),
})

export const notificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.string(),
  message: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
})

export const settingsSchema = z
  .object({
    openHour: z.number().int().min(0).max(23),
    closeHour: z.number().int().min(1).max(24),
    slotMinutes: z.number().int().min(15).max(240),
    lightsRequiredFrom: time,
    peakStart: time,
    peakEnd: time,
    basePrice: z.number().min(0),
    peakPrice: z.number().min(0),
    maxActiveReservations: z.number().int().min(1),
    cancelHoursLimit: z.number().min(0),
    currency: z.string().min(1),
  })
  .superRefine((s, ctx) => {
    if (s.closeHour <= s.openHour) {
      ctx.addIssue({ code: 'custom', path: ['closeHour'], message: 'Closing hour must be after opening hour' })
    }
    if (s.peakEnd <= s.peakStart) {
      ctx.addIssue({ code: 'custom', path: ['peakEnd'], message: 'Peak end must be after peak start' })
    }
  })

export const stateSchema = z.object({
  users: z.array(userSchema),
  courts: z.array(courtSchema),
  reservations: z.array(reservationSchema),
  blocks: z.array(blockSchema),
  lessons: z.array(lessonSchema),
  lessonTemplates: z.array(lessonTemplateSchema).default([]),
  notes: z.array(noteSchema),
  notifications: z.array(notificationSchema),
  settings: settingsSchema,
})
