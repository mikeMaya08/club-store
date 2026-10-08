import { useRef, useSyncExternalStore } from 'react'
import { getConfig, subscribeConfig, type ClubConfig } from './config'
import { getState, subscribe } from './store'
import type { State } from './types'

function subscribeAll(listener: () => void) {
  const offStore = subscribe(listener)
  const offConfig = subscribeConfig(listener)
  return () => {
    offStore()
    offConfig()
  }
}

/**
 * Subscribes a component to a slice of the club state. The selector may return a new
 * array/object each time: the previous value is reused when the content is unchanged.
 */
export function useClub<T>(selector: (state: State) => T): T {
  const prev = useRef<{ value: T; json: string } | null>(null)
  const getSnapshot = () => {
    const value = selector(getState())
    const last = prev.current
    if (last && (last.value === value || last.json === JSON.stringify(value))) return last.value
    prev.current = { value, json: JSON.stringify(value) }
    return value
  }
  return useSyncExternalStore(subscribeAll, getSnapshot, getSnapshot)
}

/** Live test config: clock override, latency, flakiness and active bugs. */
export function useConfig(): ClubConfig {
  return useSyncExternalStore(subscribeConfig, getConfig, getConfig)
}
