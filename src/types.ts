import type { z } from 'zod'
import type {
  blockSchema,
  courtSchema,
  lessonSchema,
  noteSchema,
  notificationSchema,
  reservationSchema,
  roleSchema,
  settingsSchema,
  stateSchema,
  userSchema,
} from './schema'

export type Role = z.infer<typeof roleSchema>
export type User = z.infer<typeof userSchema>
export type Court = z.infer<typeof courtSchema>
export type Reservation = z.infer<typeof reservationSchema>
export type Block = z.infer<typeof blockSchema>
export type Lesson = z.infer<typeof lessonSchema>
export type Note = z.infer<typeof noteSchema>
export type Notification = z.infer<typeof notificationSchema>
export type Settings = z.infer<typeof settingsSchema>
export type State = z.infer<typeof stateSchema>

export type AppName = 'player' | 'admin' | 'coach'
export type SeedName = 'demo' | 'empty' | 'full'
