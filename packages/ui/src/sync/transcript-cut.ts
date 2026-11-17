import type { Message } from "@/lib/opencode/model"
import { readShellCompletion } from "@/lib/opencode/background-shell"
import { readSubagentRun } from "@/lib/opencode/subagent-run"
import { readDispatchedSessionResult } from "@/lib/opencode/dispatched-session"
import { readWorkflowReport } from "@/lib/workflows/report"
import { readShareAnswer } from "@/lib/share-pages/answer"
import { isOpencodeNotFound, opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"

export async function forkAtTranscriptCut(
  sessionID: string,
  before: string | undefined,
  directory: string | null | undefined,
  expectedRuntimeKey: string,
) {
  const fork = () => {
    if (getRuntimeKey() !== expectedRuntimeKey) throw new Error("runtime changed")
    return opencodeClient.forkSession(sessionID, { before, directory })
  }
  try {
    return await fork()
  } catch (error) {
    if (!before || !isOpencodeNotFound(error)) throw error
    return fork()
  }
}

const TURN_BOUNDARY_ROLES = new Set<Message["role"]>(["user", "compaction", "shell"])

export const isTurnBoundary = (message: Message): boolean =>
  TURN_BOUNDARY_ROLES.has(message.role)
  || readSubagentRun(message) !== undefined
  || readShellCompletion(message) !== undefined
  || readDispatchedSessionResult(message) !== undefined
  || readWorkflowReport(message) !== undefined
  || readShareAnswer(message) !== undefined

export function transcriptCutForMessage(messages: readonly Message[], messageID: string): string {
  const index = messages.findIndex((message) => message.id === messageID)
  if (messages[index]?.role !== "user") return messageID
  let first = index
  while (first > 0 && messages[first - 1].role === "synthetic") first -= 1
  return first >= 0 ? messages[first].id : messageID
}

export function transcriptCutAfterMessage(messages: readonly Message[], messageID: string): string | undefined {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index < 0) throw new Error("Fork source message is not loaded")
  const boundary = messages.slice(index + 1).find(isTurnBoundary)
  return boundary ? transcriptCutForMessage(messages, boundary.id) : undefined
}
