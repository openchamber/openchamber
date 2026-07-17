import type { SessionTileClassification } from "./pruneRestoredLayout"

export type SessionExistenceFetcher = (
  sessionIds: readonly string[],
) => Promise<readonly string[]>

export const classifySessionExistence = async (
  sessionIds: readonly string[],
  fetchPresentSessionIds: SessionExistenceFetcher,
): Promise<Readonly<Record<string, SessionTileClassification>>> => {
  if (sessionIds.length === 0) return {}

  const [fetchResult] = await Promise.allSettled([
    Promise.resolve().then(() => fetchPresentSessionIds(sessionIds)),
  ])
  const classifications: Record<string, SessionTileClassification> = {}

  switch (fetchResult.status) {
    case "fulfilled": {
      const present = new Set(fetchResult.value)
      for (const sessionId of sessionIds) {
        classifications[sessionId] = present.has(sessionId) ? "present" : "missing"
      }
      return classifications
    }
    case "rejected":
      for (const sessionId of sessionIds) {
        classifications[sessionId] = "unknown-fetch-failed"
      }
      return classifications
    default:
      return fetchResult satisfies never
  }
}
