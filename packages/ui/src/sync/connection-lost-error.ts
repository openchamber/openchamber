/**
 * A call was refused before it left the browser: the client↔host connection
 * was still reconnecting when the grace window ran out. Nothing reached the
 * server, so a caller that reports "could not submit" misleads the user into
 * looking for a server-side failure that never happened.
 *
 * `reason` and `everConnected` let a surface word the refusal in the user's
 * language; `message` stays the English sentence callers without a
 * translation of their own (the composer, `/btw`) already show.
 */
export class ConnectionLostError extends Error {
  readonly reason: string | null
  readonly everConnected: boolean

  constructor(details: { reason: string | null; everConnected: boolean }) {
    const suffix = details.reason
      ? ` (${details.reason})`
      : details.everConnected
        ? ""
        : " (never connected)"
    super(`Connection lost${suffix}. Please wait for reconnection.`)
    this.name = "ConnectionLostError"
    this.reason = details.reason
    this.everConnected = details.everConnected
  }
}
