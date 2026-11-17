import type { SessionStatus } from "@/lib/opencode/model"

const promptsInFlight = new Map<string, number>()

export function trackPromptInFlight(sessionId: string): () => void {
  promptsInFlight.set(sessionId, (promptsInFlight.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (promptsInFlight.get(sessionId) ?? 1) - 1
    if (remaining > 0) promptsInFlight.set(sessionId, remaining)
    else promptsInFlight.delete(sessionId)
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
