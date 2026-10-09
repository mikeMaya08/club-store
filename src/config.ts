import { sessionStore } from './storage'

export const BUGS = ['double-booking', 'stale-ui', 'wrong-price', 'cancel-anytime', 'slow-render', 'missing-events'] as const
export type Bug = (typeof BUGS)[number]

/** Test knobs, persisted in sessionStorage so they survive reloads within a tab. */
export interface ClubConfig {
  now: string | null
  latency: number
  flaky: number
  bugs: Bug[]
}

const KEY = 'club:config'
const DEFAULTS: ClubConfig = { now: null, latency: 0, flaky: 0, bugs: [] }

function load(): ClubConfig {
  try {
    const raw = sessionStore().getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // ignore corrupted config
  }
  return { ...DEFAULTS }
}

let config: ClubConfig = load()
const listeners = new Set<() => void>()

export const getConfig = () => config

export function setConfig(patch: Partial<ClubConfig>) {
  config = { ...config, ...patch }
  try {
    sessionStore().setItem(KEY, JSON.stringify(config))
  } catch {
    // storage unavailable: keep in memory only
  }
  listeners.forEach((l) => l())
}

export function subscribeConfig(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const hasBug = (bug: Bug) => config.bugs.includes(bug)

export const parseBugs = (list: string): Bug[] =>
  list
    .split(',')
    .map((b) => b.trim())
    .filter((b): b is Bug => (BUGS as readonly string[]).includes(b))
