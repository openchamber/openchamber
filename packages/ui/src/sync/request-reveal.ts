import React from "react"

/**
 * "Open session" on a question or permission toast names the request it was
 * raised for. Selecting the session is not enough: when that session is
 * already open, a dock the user collapsed stays collapsed and the request
 * stays out of sight. The dock that holds the request takes it from here and
 * expands.
 *
 * The request waits until a dock holds it, so it also reaches a dock that
 * mounts or receives the request after the session switch.
 */

let pendingRequestID: string | null = null
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

export const revealRequest = (requestID: string): void => {
  pendingRequestID = requestID
  notify()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getPendingRequestID = () => pendingRequestID

/**
 * Calls `onReveal` once when a toast asks to reveal one of `requestIDs`.
 * `onReveal` should be stable.
 */
export const useRequestReveal = (requestIDs: readonly string[], onReveal: (requestID: string) => void): void => {
  const pending = React.useSyncExternalStore(subscribe, getPendingRequestID, getPendingRequestID)
  const held = pending !== null && requestIDs.includes(pending)
  React.useEffect(() => {
    if (!held || pending === null) return
    pendingRequestID = null
    notify()
    onReveal(pending)
  }, [held, pending, onReveal])
}
