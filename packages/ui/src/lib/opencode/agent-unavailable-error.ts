/** A send named an agent the session's folder does not have; nothing was sent. */
export class AgentUnavailableError extends Error {
  constructor(readonly agent: string, readonly directory: string | undefined) {
    super(`Agent '${agent}' is not available in ${directory ?? "the session's folder"}`)
    this.name = "AgentUnavailableError"
  }
}
