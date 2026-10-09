export type RuleCode =
  | 'INVALID_SLOT'
  | 'NO_LIGHTS'
  | 'MAX_ACTIVE'
  | 'SLOT_TAKEN'
  | 'CANCEL_TOO_LATE'
  | 'COURT_INACTIVE'
  | 'USER_INACTIVE'
  | 'LESSON_FULL'
  | 'ALREADY_ENROLLED'
  | 'ALREADY_WAITLISTED'
  | 'COURT_IN_USE'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'VALIDATION'
  | 'NETWORK_ERROR'

export const RULE_MESSAGES: Record<RuleCode, string> = {
  INVALID_SLOT: 'That time is not a valid bookable slot.',
  NO_LIGHTS: 'This court has no lights, so it cannot be booked from the evening hours.',
  MAX_ACTIVE: 'You have reached the maximum number of active reservations.',
  SLOT_TAKEN: 'That slot is no longer available.',
  CANCEL_TOO_LATE: 'It is too late to cancel this reservation.',
  COURT_INACTIVE: 'This court is currently out of service.',
  USER_INACTIVE: 'Your account has been deactivated.',
  LESSON_FULL: 'This lesson is full.',
  ALREADY_ENROLLED: 'You are already enrolled in this lesson.',
  ALREADY_WAITLISTED: 'You are already on the waitlist for this lesson.',
  COURT_IN_USE: 'This court still has upcoming reservations or lessons.',
  NOT_FOUND: 'The requested item could not be found.',
  INVALID_STATE: 'This action is not allowed in the current state.',
  VALIDATION: 'Some of the data is invalid.',
  NETWORK_ERROR: 'Network error. Please try again.',
}

export class RuleError extends Error {
  readonly code: RuleCode

  constructor(code: RuleCode, message?: string) {
    super(message ?? RULE_MESSAGES[code])
    this.name = 'RuleError'
    this.code = code
  }
}

/** Human-readable text for any thrown value, suitable for a toast. */
export function errorMessage(err: unknown): string {
  if (err instanceof RuleError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}
