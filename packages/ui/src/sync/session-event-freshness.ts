import type { Session } from "@opencode-ai/sdk/v2"

const getSessionRecencyTimestamp = (session: Session): number => {
  const updatedAt = session.time?.updated
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    return updatedAt
  }
  const createdAt = session.time?.created
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0
}

export const shouldSkipStaleSessionEvent = (currentSession: Session | null, incomingSession: Session): boolean => {
  if (!currentSession) return false
  return getSessionRecencyTimestamp(incomingSession) < getSessionRecencyTimestamp(currentSession)
}
