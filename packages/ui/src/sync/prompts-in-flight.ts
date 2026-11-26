import type { SessionStatus } from "@/lib/opencode/model"

type InFlightEntry = {
  count: number
  startedFromIdle: boolean
}

const promptsInFlight = new Map<string, InFlightEntry>()

export function trackPromptInFlight(sessionId: string, startedFromIdle = false): (accepted?: boolean) => boolean {
  const existing = promptsInFlight.get(sessionId)
  if (existing) {
    existing.count += 1
    if (startedFromIdle) existing.startedFromIdle = true
  } else {
    promptsInFlight.set(sessionId, { count: 1, startedFromIdle })
  }
  let released = false
  return (accepted = false) => {
    if (released) return false
    released = true
    const current = promptsInFlight.get(sessionId)
    if (!current) return false
    if (accepted) current.startedFromIdle = false
    current.count -= 1
    if (current.count > 0) return false
    promptsInFlight.delete(sessionId)
    return current.startedFromIdle
  }
}

export const hasPromptInFlight = (sessionId: string): boolean => promptsInFlight.has(sessionId)

export function withPromptsInFlight(
  snapshot: Record<string, SessionStatus>,
  current: Record<string, SessionStatus>,
): Record<string, SessionStatus> {
  let next = snapshot
  for (const [sessionId, status] of Object.entries(current)) {
    if (status.type === "idle" || snapshot[sessionId] || !hasPromptInFlight(sessionId)) continue
    if (next === snapshot) next = { ...snapshot }
    next[sessionId] = status
  }
  return next
}
