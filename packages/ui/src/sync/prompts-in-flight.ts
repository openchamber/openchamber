import type { SessionStatus } from "@/lib/opencode/model"

/**
 * Sessions with a prompt request from this page that OpenCode has not answered.
 *
 * OpenCode admits a prompt only after the session's directory has started, and
 * a directory whose plugins or MCP servers start slowly holds the request open
 * that long. Until then its active-session list does not name the session, so a
 * status snapshot read in that window cannot tell that the send is pending and
 * must not lower the busy status the send set. A rejected send rolls that
 * status back itself.
 */
const promptsInFlight = new Map<string, number>()

/** Marks a prompt for `sessionId` as sent; call the returned release once it settles. */
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

/** `snapshot` with the active status `current` holds for each session whose prompt is still being sent. */
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
