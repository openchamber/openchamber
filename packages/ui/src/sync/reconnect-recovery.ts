import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { HarnessMessage, HarnessSession } from "@openchamber/harness-contracts"

type ReconnectRecoveryState = {
  session: HarnessSession[]
  session_status?: Record<string, SessionStatus>
  message?: Record<string, HarnessMessage[]>
}

export type ViewedSessionRecoveryTarget = {
  directory: string
  sessionId: string
}

type ReconnectCandidateOptions = {
  directory?: string
  viewedSession?: ViewedSessionRecoveryTarget | null
}

export function getReconnectCandidateSessionIds(state: ReconnectRecoveryState, options?: ReconnectCandidateOptions) {
  const ids = new Set<string>()

  for (const [sessionId, status] of Object.entries(state.session_status ?? {})) {
    if (status && status.type !== "idle") ids.add(sessionId)
  }

  for (const [sessionId, messages] of Object.entries(state.message ?? {})) {
    const lastMessage = messages[messages.length - 1]
    if (
      lastMessage
      && lastMessage.role === "assistant"
      && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number"
    ) {
      ids.add(sessionId)
    }
  }

  const parentIds = new Set<string>()
  for (const session of state.session) {
    const parentId = session.parentId
    if (parentId) {
      parentIds.add(parentId)
    }
  }
  for (const pid of parentIds) {
    ids.add(pid)
  }

  const viewedSession = options?.viewedSession
  if (viewedSession?.sessionId && viewedSession.directory === options?.directory) {
    const sessionId = viewedSession.sessionId
    const sessionExists = state.session.some((session) => session.id === sessionId)
      || Object.hasOwn(state.session_status ?? {}, sessionId)
      || Object.hasOwn(state.message ?? {}, sessionId)

    if (sessionExists) {
      ids.add(sessionId)
    }
  }

  return Array.from(ids)
}
