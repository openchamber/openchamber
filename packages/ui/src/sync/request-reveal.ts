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

export const subscribeRequestReveal = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A page or secret card that waits for an answer sits in the transcript, so
 * "Open session" on its toast has to move the reader to it: reopened at a
 * remembered position, they would land screens above it. The session's
 * timeline serves this on entry, or right away when the session is open. The
 * call's id on the wire does not name the block in the chat, so the request
 * names the session.
 */
let pendingPageSessionID: string | null = null

export const revealWaitingPage = (sessionID: string): void => {
  pendingPageSessionID = sessionID
  notify()
}

export const isWaitingPageRevealPending = (sessionID: string | null): boolean => (
  sessionID !== null && pendingPageSessionID === sessionID
)

export const takeWaitingPageReveal = (sessionID: string | null): boolean => {
  if (!isWaitingPageRevealPending(sessionID)) return false
  pendingPageSessionID = null
  return true
}

/** Entering a session drops a request that names another one. */
export const releaseWaitingPageRevealOutside = (sessionID: string | null): void => {
  if (pendingPageSessionID !== sessionID) pendingPageSessionID = null
}

const getPendingRequestID = () => pendingRequestID

/**
 * Calls `onReveal` once when a toast asks to reveal one of `requestIDs`.
 * `onReveal` should be stable.
 */
export const useRequestReveal = (requestIDs: readonly string[], onReveal: (requestID: string) => void): void => {
  const pending = React.useSyncExternalStore(subscribeRequestReveal, getPendingRequestID, getPendingRequestID)
  const held = pending !== null && requestIDs.includes(pending)
  React.useEffect(() => {
    if (!held || pending === null) return
    pendingRequestID = null
    notify()
    onReveal(pending)
  }, [held, pending, onReveal])
}
