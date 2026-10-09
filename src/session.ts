import { useSyncExternalStore } from 'react'
import { useClub } from './hooks'
import { sessionStore } from './storage'
import type { AppName, User } from './types'

/** Each app has its own session key, so a tab can be a player and an admin at the same time. */
const key = (app: AppName) => `club:session:${app}`
const listeners = new Set<() => void>()

/** Id of the logged-in user of an app in this tab, or null. */
export const getSessionUserId = (app: AppName) => sessionStore().getItem(key(app))

/** Starts a session. The id is not checked here: the route guard validates the user's role and status. */
export function login(app: AppName, userId: string) {
  sessionStore().setItem(key(app), userId)
  listeners.forEach((l) => l())
}

/** Ends the session of this app in this tab. */
export function logout(app: AppName) {
  sessionStore().removeItem(key(app))
  listeners.forEach((l) => l())
}

/** Lets React re-render when `login` or `logout` is called in this tab. */
function subscribeSession(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `ok`: can use the app. `anonymous`: nobody is logged in. `inactive`: the account was deactivated.
 * `wrong-role`: the user exists but belongs to another app.
 */
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
