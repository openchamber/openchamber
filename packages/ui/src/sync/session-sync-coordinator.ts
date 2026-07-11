/**
 * Coalesces a session materialization inside one directory-store lifecycle.
 *
 * The scope is deliberately an object (the Zustand child store). A provider
 * remount can keep the same runtime, directory, and session ids while owning a
 * brand-new store. Reusing the old provider's promise would let it complete
 * into the detached store and leave the new chat view loading forever.
 */
export class SessionSyncCoordinator {
  private readonly inFlightByScope = new WeakMap<object, Map<string, Promise<void>>>()
  private readonly generationByScope = new WeakMap<object, Map<string, number>>()

  run(input: {
    scope: object
    key: string
    request: (isStale: () => boolean) => Promise<void>
  }): Promise<void> {
    let inFlight = this.inFlightByScope.get(input.scope)
    if (!inFlight) {
      inFlight = new Map()
      this.inFlightByScope.set(input.scope, inFlight)
    }

    const existing = inFlight.get(input.key)
    if (existing) return existing

    let generations = this.generationByScope.get(input.scope)
    if (!generations) {
      generations = new Map()
      this.generationByScope.set(input.scope, generations)
    }

    const generation = (generations.get(input.key) ?? 0) + 1
    generations.set(input.key, generation)
    const isStale = () => generations?.get(input.key) !== generation

    const request = input.request(isStale)
    inFlight.set(input.key, request)
    void request.finally(() => {
      if (inFlight?.get(input.key) === request) inFlight.delete(input.key)
    }).catch(() => {
      // The caller owns the request error. Avoid creating a second unhandled
      // rejection from the promise returned by finally().
    })
    return request
  }
}

export const sessionSyncCoordinator = new SessionSyncCoordinator()
