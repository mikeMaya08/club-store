import { format, isValid, parseISO } from 'date-fns'
import { getConfig, setConfig } from './config'

/** The club's "current time". Frozen at `?now=` when overridden, real time otherwise. */
export const clock = {
  /** Current time. Always use this instead of `new Date()` so tests can freeze it with `?now=`. */
  now(): Date {
    const override = getConfig().now
    if (override) {
      // an unparseable value falls through to real time instead of breaking the app
      const d = parseISO(override)
      if (isValid(d)) return d
    }
    return new Date()
  },
  /** Today's date as 'YYYY-MM-DD' in the club's clock. */
  today(): string {
    return format(clock.now(), 'yyyy-MM-dd')
  },
  /** Freezes the clock at an ISO date-time, or pass null to go back to real time. */
  set(iso: string | null) {
    setConfig({ now: iso })
  },
}
