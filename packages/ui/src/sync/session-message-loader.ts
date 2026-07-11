/**
 * App-wide single-flight coordinator for OpenCode session message pages.
 *
 * Session selection can start an imperative fetch before React commits while
 * the reactive sync hook requests the same page immediately afterwards.  Keep
 * the coordinator transport-agnostic so both paths share the exact promise.
 */

type LoadSessionMessagePageInput<T> = {
  runtimeKey: string
  directory: string
  sessionID: string
  before?: string
  request: () => Promise<T>
}

const inflight = new Map<string, Promise<unknown>>()

const pageKey = (input: Pick<LoadSessionMessagePageInput<unknown>, "runtimeKey" | "directory" | "sessionID" | "before">) =>
  `${input.runtimeKey}\n${input.directory}\n${input.sessionID}\n${input.before ?? "tail"}`

export function loadSessionMessagePage<T>(input: LoadSessionMessagePageInput<T>): Promise<T> {
  const key = pageKey(input)
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const request = input.request()
  inflight.set(key, request)
  void request.finally(() => {
    if (inflight.get(key) === request) inflight.delete(key)
  }).catch(() => {
    // The caller owns the request error. This branch only handles the promise
    // returned by finally so a rejected shared request is not reported twice.
  })
  return request
}
