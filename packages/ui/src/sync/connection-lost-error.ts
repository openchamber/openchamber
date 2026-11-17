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
