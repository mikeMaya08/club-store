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
| `npm test`          | Vitest: every rule and every `RuleError` code        |
| `npm run typecheck` | `tsc --noEmit`                                       |

## Using it from an app

Local development (repos cloned side by side):

```json
"club-store": "file:../club-store"
```

Deployment (Netlify installs from git; `prepare` builds it):

```json
"club-store": "github:<org>/club-store#v0.1.0"
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
| Lesson full / already enrolled                     | `LESSON_FULL`, `ALREADY_ENROLLED` |
| Deleting a court with future reservations/lessons  | `COURT_IN_USE`      |
| Other                                              | `NOT_FOUND`, `INVALID_STATE`, `VALIDATION`, `NETWORK_ERROR` |

Extra behaviour: blocks cancel overlapping reservations and notify players; lessons own a block;
deactivating a user cancels their future reservations; a lesson no-show also marks an overlapping
booked reservation as `no-show`.

### Seeds

- `demo`: 6 courts (2 without lights, 1 inactive), 1 admin, 2 coaches, 12 players, 40 reservations in ±7 days, 4 lessons (`lesson-3` is full), notes, notifications. Dates are relative to the club clock, so use `?now=` for fully fixed data.
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
| `?bug=a,b`               | `double-booking`, `stale-ui`, `wrong-price`, `cancel-anytime`, `slow-render` |

`window.__club` exposes `{ state, reset(seed), setBugs([]), setNow(iso) }` (plus `setLatency`, `setFlaky`, `config`).

`wrong-price` only changes the **charged** price; `priceFor()` (used for display) stays correct,
so the mismatch is detectable. `slow-render` is applied by the player app (`hasBug('slow-render')`).
