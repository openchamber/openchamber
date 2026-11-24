const confirmedDestinations = new Map<string, string | null>()

export async function requestSessionMove(sessionId: string, send: () => Promise<void>): Promise<string | null> {
  confirmedDestinations.set(sessionId, null)
  try {
    await send()
    return confirmedDestinations.get(sessionId) ?? null
  } finally {
    confirmedDestinations.delete(sessionId)
  }
}

export function noteSessionMoveEvent(sessionId: string, destinationDirectory: string): void {
  if (confirmedDestinations.has(sessionId)) confirmedDestinations.set(sessionId, destinationDirectory)
}
