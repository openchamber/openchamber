import type { Message } from "@/lib/opencode/model"
import { readShellCompletion } from "@/lib/opencode/background-shell"
import { readSubagentRun } from "@/lib/opencode/subagent-run"
import { readDispatchedSessionResult } from "@/lib/opencode/dispatched-session"
import { readWorkflowReport } from "@/lib/workflows/report"
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
    // A locally visible cut may not be persisted yet. Never widen it on retry.
    return fork()
  }
}

/**
 * Records that start something new after a turn. OpenCode 1 carried a
 * compaction and a shell run as user messages; OpenCode 2 gives them their own
 * roles, so they have to be named here or a fork after an answer copies them.
 */
const TURN_BOUNDARY_ROLES = new Set<Message["role"]>(["user", "compaction", "shell"])

export const isTurnBoundary = (message: Message): boolean =>
  TURN_BOUNDARY_ROLES.has(message.role)
  || readSubagentRun(message) !== undefined
  || readShellCompletion(message) !== undefined
  || readDispatchedSessionResult(message) !== undefined
  || readWorkflowReport(message) !== undefined

/**
 * Where a revert or fork of a user message cuts the transcript: at the first
 * of its context carriers, so the carriers leave together with the message.
 * Cutting at the message itself would leave them in place, and the next prompt
 * would be sent with the reverted context attached a second time.
 */
export function transcriptCutForMessage(messages: readonly Message[], messageID: string): string {
  const index = messages.findIndex((message) => message.id === messageID)
  // Only a prompt has carriers; any other target (a subagent run report) is cut at itself.
  if (messages[index]?.role !== "user") return messageID
  let first = index
  while (first > 0 && messages[first - 1].role === "synthetic") first -= 1
  return first >= 0 ? messages[first].id : messageID
}

/**
 * Where a fork that keeps `messageID` cuts the transcript. OpenCode's fork
 * `before` leaves out the message it names, so the cut is the first record
 * after `messageID` that starts something new (a prompt with its context
 * carriers, a compaction, a shell run, a background subagent's report or
 * command's completion, a dispatched session's result or a workflow report).
 * `undefined` means nothing does: the whole transcript is copied.
 */
export function transcriptCutAfterMessage(messages: readonly Message[], messageID: string): string | undefined {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index < 0) throw new Error("Fork source message is not loaded")
  const boundary = messages.slice(index + 1).find(isTurnBoundary)
  return boundary ? transcriptCutForMessage(messages, boundary.id) : undefined
}
