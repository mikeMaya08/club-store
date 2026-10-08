import { format, isValid, parseISO } from 'date-fns'
import { getConfig, setConfig } from './config'

/** The club's "current time". Frozen at `?now=` when overridden, real time otherwise. */
export const clock = {
  now(): Date {
    const override = getConfig().now
    if (override) {
      const d = parseISO(override)
      if (isValid(d)) return d
    }
    return new Date()
  },
  today(): string {
    return format(clock.now(), 'yyyy-MM-dd')
  },
  set(iso: string | null) {
    setConfig({ now: iso })
  },
}
