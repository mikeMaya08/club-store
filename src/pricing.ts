import { hasBug } from './config'
import type { Settings } from './types'

export const isPeak = (s: Settings, start: string) => start >= s.peakStart && start < s.peakEnd

/** The price a slot SHOULD cost. Use this for display. */
export const priceFor = (s: Settings, start: string) => (isPeak(s, start) ? s.peakPrice : s.basePrice)

/** The price the store actually charges (honours `?bug=wrong-price`). */
export const chargedPrice = (s: Settings, start: string) => (hasBug('wrong-price') ? s.basePrice : priceFor(s, start))
