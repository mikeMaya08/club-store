import { actions } from './actions'
import { getConfig } from './config'

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<R> : never }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Same operations as `actions`, but async: they wait `?latency=` ms first, so apps
 * can show loading states. Apps should call `api.*`; tests can use `actions.*` directly.
 */
export const api = Object.fromEntries(
  Object.entries(actions).map(([name, fn]) => [
    name,
    async (...args: unknown[]) => {
      const ms = getConfig().latency
      if (ms > 0) await wait(ms)
      return (fn as (...a: unknown[]) => unknown)(...args)
    },
  ]),
) as Async<typeof actions>
