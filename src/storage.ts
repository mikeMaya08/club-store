/** The small part of the Web Storage API this package needs. */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** In-memory fallback used in Node (tests) or when the browser blocks storage. */
class MemoryStorage implements Store {
  private data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
}

const memoryLocal = new MemoryStorage()
const memorySession = new MemoryStorage()

/** Returns the browser storage if it is usable, otherwise the in-memory fallback. */
function pick(kind: 'localStorage' | 'sessionStorage', fallback: Store): Store {
  try {
    const s = (globalThis as Record<string, unknown>)[kind] as Store | undefined
    if (s && typeof s.getItem === 'function') return s
  } catch {
    // access denied (privacy mode): use memory
  }
  return fallback
}

/** Shared by every tab and every app on the same origin: holds the club data (`club:v1`). */
export const localStore = () => pick('localStorage', memoryLocal)
/** Private to one browser tab: holds sessions and test settings (`?now`, `?bug`...). */
export const sessionStore = () => pick('sessionStorage', memorySession)
