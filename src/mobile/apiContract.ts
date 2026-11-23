export const SUBSCRIPTION_METHODS = new Set([
  'chatStream',
  'agent.run',
  'connectors.run',
  'dev.runTests',
  'rag.index'
])

export type ApiInvoker = (path: string, args: unknown[]) => Promise<unknown>
export type ApiSubscriber = (path: string, args: unknown[]) => () => void

export interface ApiRouter {
  invoke: ApiInvoker
  subscribe: ApiSubscriber
}

function makeNode(router: ApiRouter, segments: string[]): any {
  return new Proxy(function noop() { /* replaced by proxy apply */ }, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined
      return makeNode(router, [...segments, String(property)])
    },
    apply(_target, _thisArg, args: unknown[]) {
      const path = segments.join('.')
      if (SUBSCRIPTION_METHODS.has(path)) return router.subscribe(path, args)
      return router.invoke(path, args)
    }
  })
}

/** Builds the same nested window.api shape used by the desktop renderer. */
export function createApiProxy(router: ApiRouter): Window['api'] {
  return makeNode(router, []) as Window['api']
}

export function unavailable(path: string): never {
  throw new Error(`${path} is not available in this mode.`)
}
