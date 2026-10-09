# club-store

Shared package for the **Baseline Tennis Club** QA sandbox: types, zod schemas, business rules,
deterministic seeds, localStorage persistence, cross-tab sync, React hooks and test hooks.
There is no backend: the "database" is `localStorage['club:v1']`.

Used by `club-player`, `club-admin` and `club-coach`. It is the only link between those repos.

## Scripts

| Script              | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm install`       | Installs and builds `dist/` (via `prepare`)          |
| `npm run build`     | `tsup` → `dist/index.js` (ESM) + `dist/index.d.ts`   |
| `npm run dev`       | `tsup --watch` (apps pick up changes automatically)  |
| `npm test`          | Vitest: every rule and every `RuleError` code (128 tests)        |
| `npm run typecheck` | `tsc --noEmit`                                       |

## Using it from an app

Local development (repos cloned side by side):

```json
"club-store": "file:../club-store"
```

Deployment (Vercel installs from git over https; `prepare` builds it. Use `git+https`, because the `github:` shorthand makes npm try SSH, which CI machines don't have):

```json
"club-store": "git+https://github.com/mikeMaya08/club-store.git#v0.3.0"
```

Apps must add `resolve.dedupe: ['react', 'react-dom']` in `vite.config.ts` so the linked package
shares the app's copy of React.

## API overview

```ts
import { actions, api, useClub, useSession, initClub, slotStatus, priceFor, RuleError } from 'club-store'
```

- `actions.*`: synchronous operations; each is one `commit()`.
- `api.*`: the same operations, async, honouring `?latency=`. Apps should call these.
- `commit(mutator)`: the single write path (validate with zod → persist → broadcast on `BroadcastChannel('club')`, plus the `storage` event fallback).
- `useClub(selector)`: `useSyncExternalStore` slice; re-renders when any tab writes.
- `useSession(app)`: fake login, session in `sessionStorage['club:session:<app>']`.
- `slotStatus`, `findConflicts`, `priceFor`, `slotsFor`: shared read helpers.
- `clock.now()`: the club's current time (`?now=` override).
- `seed('demo' | 'empty' | 'full')`, `reset(name)`.

### Rules and error codes

| Rule                                               | Code                |
| -------------------------------------------------- | ------------------- |
| Slot not on the hourly grid / outside hours / past | `INVALID_SLOT`      |
| Court without lights at/after `lightsRequiredFrom` | `NO_LIGHTS`         |
| Too many future booked reservations                | `MAX_ACTIVE`        |
| Overlaps reservation, block or lesson              | `SLOT_TAKEN`        |
| Cancelling inside `cancelHoursLimit`               | `CANCEL_TOO_LATE`   |
| Inactive court / user                              | `COURT_INACTIVE`, `USER_INACTIVE` |
| Lesson full / already enrolled / already waitlisted | `LESSON_FULL`, `ALREADY_ENROLLED`, `ALREADY_WAITLISTED` |
| Deleting a court with future reservations/lessons  | `COURT_IN_USE`      |
| Other                                              | `NOT_FOUND`, `INVALID_STATE`, `VALIDATION`, `NETWORK_ERROR` |

Extra behaviour: blocks cancel overlapping reservations and notify players; lessons own a block;
deactivating a user cancels their future reservations; a lesson no-show also marks an overlapping
booked reservation as `no-show`.

### Added in v0.2.0

- **Lesson waitlist:** `joinWaitlist` (only for full lessons) / `leaveWaitlist`. When a seat frees up (`leaveLesson`, capacity increase) the first active waiting player is enrolled automatically and notified (`waitlist-promoted`).
- **Weekly recurring bookings:** `bookRecurring({ ..., weeks: 2-8 })` is all-or-nothing, error messages name the failing week. A whole series (`seriesId`) counts as **one** active reservation for `maxActiveReservations`. `cancelSeries` cancels every occurrence still outside the cancellation window.
- **`moveReservation(id, { courtId?, date?, start? }, adminId)`:** admin-only, re-checks every booking rule, recalculates end and price, notifies the player.
- **`updateLesson(id, patch, actorId)`:** admin or the lesson's coach; moves the lesson's court block together with it.
- **Lesson templates:** `saveTemplate` / `deleteTemplate` (coach-owned, stored in the state).
- Data saved by v0.1 is upgraded on read (`waitlist`, `lessonTemplates`).

### Added in v0.3.0: activity log

Every action writes an event to `state.events` **inside the same `commit`**, so an event exists if and only if the action happened (a failed action logs nothing). The log keeps the latest 500 events.

```ts
{ id: 'evt-12', type: 'reservation.cancelled', actorId: 'admin-1', subjectId: 'player-3',
  entity: 'reservation', entityId: 'res-7', summary: '...', meta: { reason: 'blocked by club' }, createdAt: '...' }
```

- **Types** (`EVENT_TYPES`): `reservation.*` (booked, series_booked, cancelled, series_cancelled, moved, no_show), `block.*`, `lesson.*` (created, updated, cancelled, completed, enrolled, left, waitlist_joined/left/promoted), `attendance.marked`, `note.added`, `template.*`, `user.*` (activated, deactivated, role_changed), `court.*`, `settings.updated`.
- **Cascades are logged too:** a block logs `block.created` plus one `reservation.cancelled` per cancelled reservation (actor = the admin); deactivating a user logs the change and each cancelled reservation; a lesson no-show logs the attendance and the reservation it flips.
- **Actor:** most actions already take the actor. `moveBlock`, `deleteBlock`, `completeLesson`, `setAttendance`, `setUserActive`, `setUserRole`, `createCourt`, `updateCourt`, `deleteCourt` and `updateSettings` got an **optional trailing `actorId`**; without it the actor is `'system'` (waitlist promotions are always `'system'`).
- `filterEvents(events, { types, actorId, involvingUserId, entity, from, to })` returns newest first. `window.__club.state.events` is available to tests.
- **Bug `?bug=missing-events`:** cancellation events (`*cancelled`) are not logged.
- The demo seed ships with a history that matches its reservations, lessons and notes. Data saved before v0.3 is upgraded on read.

### Seeds

- `demo`: 6 courts (2 without lights, 1 inactive), 1 admin, 2 coaches, 12 players, 40 reservations in ±7 days, 4 lessons (`lesson-3` is full and has `player-10` on its waitlist), 2 lesson templates for `coach-1`, notes, notifications. Dates are relative to the club clock, so use `?now=` for fully fixed data.
- `empty`: users and courts only.
- `full`: ~90% of the next 3 days booked by `player-7..12`; `player-1..6` are free to book.

Fixed ids: `admin-1`, `coach-1..2`, `player-1..12`, `court-1..6`.

### Test hooks (`initClub(app)`, call before rendering)

Read from the URL, kept in `sessionStorage`, then stripped from the address bar:

| Param                    | Effect                                           |
| ------------------------ | ------------------------------------------------ |
| `?reset=1&seed=demo`     | Wipe and reseed (`demo` default, `empty`, `full`) |
| `?as=player-1`           | Log in directly as that user                     |
| `?now=2026-10-10T18:30`  | Freeze the club clock                            |
| `?latency=800`           | Delay every `api.*` call (ms)                    |
| `?flaky=0.2`             | 20% of commits throw `NETWORK_ERROR`             |
| `?bug=a,b`               | `double-booking`, `stale-ui`, `wrong-price`, `cancel-anytime`, `slow-render`, `missing-events` |

`window.__club` exposes `{ state, reset(seed), setBugs([]), setNow(iso) }` (plus `setLatency`, `setFlaky`, `config`).

`wrong-price` only changes the **charged** price; `priceFor()` (used for display) stays correct,
so the mismatch is detectable. `slow-render` is applied by the player app (`hasBug('slow-render')`).
