import { clock } from './clock'
import { getConfig, parseBugs, setConfig, type Bug } from './config'
import { login } from './session'
import { getState, refresh, reset } from './store'
import type { AppName, SeedName, State } from './types'

export interface ClubDebugApi {
  readonly state: State
  reset(seed?: SeedName): void
  setBugs(bugs: Bug[]): void
  setNow(iso: string | null): void
  setLatency(ms: number): void
  setFlaky(probability: number): void
  readonly config: ReturnType<typeof getConfig>
}

declare global {
  interface Window {
    __club: ClubDebugApi
  }
}

const HOOK_PARAMS = ['reset', 'seed', 'as', 'now', 'latency', 'flaky', 'bug']

/** Turns bugs on or off. Turning `stale-ui` off also re-reads the data so the screen catches up. */
export function setBugs(bugs: Bug[]) {
  const wasStale = getConfig().bugs.includes('stale-ui')
  setConfig({ bugs })
  if (wasStale && !bugs.includes('stale-ui')) refresh()
}

/**
 * Call once before rendering an app. Applies the test hooks found in the URL
 * (`?reset=1&seed=demo&as=player-1&now=...&latency=...&flaky=...&bug=a,b`), keeps them in
 * sessionStorage, strips them from the address bar and exposes `window.__club`.
 */
export function initClub(app: AppName) {
  const params = new URLSearchParams(window.location.search)

  if (params.has('now')) clock.set(params.get('now'))
  if (params.has('latency')) setConfig({ latency: Number(params.get('latency')) || 0 })
  if (params.has('flaky')) setConfig({ flaky: Number(params.get('flaky')) || 0 })
  if (params.has('bug')) setBugs(parseBugs(params.get('bug') ?? ''))
  // Reset must run after `now`: seed dates are relative to the club clock.
  if (params.get('reset') === '1') reset((params.get('seed') as SeedName) || 'demo')
  if (params.has('as')) login(app, params.get('as') ?? '')

  if (HOOK_PARAMS.some((p) => params.has(p))) {
    HOOK_PARAMS.forEach((p) => params.delete(p))
    const qs = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
  }

  window.__club = {
    get state() {
      return getState()
    },
    get config() {
      return getConfig()
    },
    reset: (seed = 'demo') => reset(seed),
    setBugs,
    setNow: (iso) => clock.set(iso),
    setLatency: (ms) => setConfig({ latency: ms }),
    setFlaky: (p) => setConfig({ flaky: p }),
  }
}
