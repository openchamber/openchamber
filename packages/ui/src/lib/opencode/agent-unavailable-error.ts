export class AgentUnavailableError extends Error {
  constructor(readonly agent: string, readonly directory: string | undefined) {
    super(`Agent '${agent}' is not available in ${directory ?? "the session's folder"}`)
    this.name = "AgentUnavailableError"
  }
}
