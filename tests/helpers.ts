import { beforeEach } from 'vitest'
import { actions, getState, reset, setConfig, type RuleCode, RuleError } from '../src'

export const NOW = '2026-10-10T10:00'
export const TODAY = '2026-10-10'
export const TOMORROW = '2026-10-11'

/** Fresh "empty" club (users + courts only) at a fixed clock before every test. */
export function useFreshClub() {
  beforeEach(() => {
    setConfig({ now: NOW, latency: 0, flaky: 0, bugs: [] })
    reset('empty')
  })
}

export function expectCode(fn: () => unknown, code: RuleCode) {
  try {
    fn()
  } catch (e) {
    if (e instanceof RuleError) {
      if (e.code !== code) throw new Error(`Expected ${code} but got ${e.code}`)
      return
    }
    throw e
  }
  throw new Error(`Expected ${code} but nothing was thrown`)
}

export const book = (over: Partial<Parameters<typeof actions.bookReservation>[0]> = {}) =>
  actions.bookReservation({ courtId: 'court-1', playerId: 'player-1', date: TOMORROW, start: '10:00', ...over })

export const state = () => getState()
