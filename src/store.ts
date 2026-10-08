import { clock } from './clock'
import { getConfig, hasBug } from './config'
import { RuleError } from './errors'
import { stateSchema } from './schema'
import { seed } from './seed'
import { localStore } from './storage'
import type { SeedName, State } from './types'

export const STORAGE_KEY = 'club:v1'
const VERSION = 1

type Listener = () => void
const listeners = new Set<Listener>()

let channel: BroadcastChannel | null | undefined
let attached = false
let lastRaw: string | null = null
let lastState: State | null = null
/** What the UI sees. Normally equals storage; with `stale-ui` it only moves on local writes. */
let view: State | null = null

function getChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('club') : null
    ;(channel as unknown as { unref?: () => void } | null)?.unref?.()
  }
  return channel
}

function notify() {
  listeners.forEach((l) => l())
}

function write(state: State) {
  const raw = JSON.stringify({ version: VERSION, data: state, updatedAt: clock.now().toISOString() })
  localStore().setItem(STORAGE_KEY, raw)
  lastRaw = raw
  lastState = state
}

/** Fills fields added after v0.1 so data saved by older versions keeps working. */
function normalize(data: State): State {
  data.lessonTemplates ??= []
  for (const lesson of data.lessons) lesson.waitlist ??= []
  return data
}

/** Always reads the latest persisted state (seeding it on first use). */
function readFresh(): State {
  const raw = localStore().getItem(STORAGE_KEY)
  if (raw !== null && raw === lastRaw && lastState) return lastState
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.version === VERSION) {
        lastRaw = raw
        lastState = normalize(parsed.data)
        return lastState
      }
    } catch {
      // corrupted: fall through and reseed
    }
  }
  const fresh = seed('demo')
  write(fresh)
  return fresh
}

export function getState(): State {
  if (!view) view = readFresh()
  return view
}

/** Re-reads storage after another tab wrote. A no-op while `stale-ui` is on. */
export function syncFromStorage() {
  if (hasBug('stale-ui')) return
  view = readFresh()
  notify()
}

function attachExternalListeners() {
  if (attached) return
  attached = true
  getChannel()?.addEventListener('message', syncFromStorage)
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY || e.key === null) syncFromStorage()
    })
  }
}

export function subscribe(listener: Listener) {
  attachExternalListeners()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The single write path. Runs the mutator on a copy of the freshest state, validates the
 * result, persists it and tells every other tab. If anything throws, nothing is written.
 */
export function commit<T>(mutator: (draft: State) => T): T {
  if (Math.random() < getConfig().flaky) throw new RuleError('NETWORK_ERROR')
  const draft = structuredClone(readFresh())
  const result = mutator(draft)
  const check = stateSchema.safeParse(draft)
  if (!check.success) {
    const msg = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new RuleError('VALIDATION', msg)
  }
  write(draft)
  view = draft
  notify()
  getChannel()?.postMessage('changed')
  return result
}

/** Wipes everything and loads a seed. Bypasses validation latency/flakiness on purpose. */
export function reset(name: SeedName = 'demo') {
  const fresh = seed(name)
  write(fresh)
  view = fresh
  notify()
  getChannel()?.postMessage('changed')
}

/** Forces the UI to re-read storage, e.g. after toggling `stale-ui` off. */
export function refresh() {
  view = readFresh()
  notify()
}
