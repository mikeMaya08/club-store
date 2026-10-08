import { useSyncExternalStore } from 'react'
import { useClub } from './hooks'
import { sessionStore } from './storage'
import type { AppName, User } from './types'

const key = (app: AppName) => `club:session:${app}`
const listeners = new Set<() => void>()

export const getSessionUserId = (app: AppName) => sessionStore().getItem(key(app))

export function login(app: AppName, userId: string) {
  sessionStore().setItem(key(app), userId)
  listeners.forEach((l) => l())
}

export function logout(app: AppName) {
  sessionStore().removeItem(key(app))
  listeners.forEach((l) => l())
}

function subscribeSession(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export type SessionStatus = 'anonymous' | 'ok' | 'inactive' | 'wrong-role'

/** Fake login for one app. The session lives in sessionStorage, so every tab can be a different user. */
export function useSession(app: AppName): { user: User | null; status: SessionStatus } {
  const userId = useSyncExternalStore(subscribeSession, () => getSessionUserId(app))
  const user = useClub((s) => s.users.find((u) => u.id === userId) ?? null)
  let status: SessionStatus = 'ok'
  if (!userId || !user) status = 'anonymous'
  else if (!user.active) status = 'inactive'
  else if (user.role !== app) status = 'wrong-role'
  return { user, status }
}
