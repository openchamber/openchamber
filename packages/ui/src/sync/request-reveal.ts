import React from "react"


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

let pendingPageSessionID: string | null = null
let pendingPageID: string | null = null

export const revealWaitingPage = (sessionID: string, pageID?: string): void => {
  pendingPageSessionID = sessionID
  pendingPageID = pageID ?? null
  notify()
}

export const pendingWaitingPageID = (): string | null => pendingPageID

export const isWaitingPageRevealPending = (sessionID: string | null): boolean => (
  sessionID !== null && pendingPageSessionID === sessionID
)

export const takeWaitingPageReveal = (sessionID: string | null): boolean => {
  if (!isWaitingPageRevealPending(sessionID)) return false
  pendingPageSessionID = null
  return true
}

export const releaseWaitingPageRevealOutside = (sessionID: string | null): void => {
  if (pendingPageSessionID !== sessionID) pendingPageSessionID = null
}

const getPendingRequestID = () => pendingRequestID

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
