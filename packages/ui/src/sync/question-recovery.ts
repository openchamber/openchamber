import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"
import type { QuestionInfo, QuestionRequest } from "@/types/question"

type MessageRecord = {
  info: Message
  parts: Part[]
}

const RECOVERY_DELAYS_MS = [0, 500, 1500] as const
const RUNNING_STATUSES = new Set(["running", "pending"])

const isActiveQuestionTool = (part: Part): boolean => {
  if (part.type !== "tool" || part.tool !== "question") return false
  const status = (part as ToolPart).state.status
  return status === "pending" || status === "running"
}

/**
 * A persisted running question tool without a matching pending-request record
 * is the cold-start recovery signal. Only inspect the current turn so an old,
 * stale tool cannot trigger network work after the user has continued chatting.
 */
export function hasActiveQuestionToolInCurrentTurn(messages: readonly MessageRecord[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.info.role === "user") return false
    if (message.parts.some(isActiveQuestionTool)) return true
  }
  return false
}

export async function recoverPendingQuestionWithRetry(
  recover: () => Promise<boolean>,
  options?: {
    isCancelled?: () => boolean
    sleep?: (delayMs: number) => Promise<void>
  },
): Promise<boolean> {
  const isCancelled = options?.isCancelled ?? (() => false)
  const sleep = options?.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))

  for (const delayMs of RECOVERY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs)
    if (isCancelled()) return false
    if (await recover()) return true
  }
  return false
}

/**
 * Gap detection for "stuck" question prompts (issue #2448).
 *
 * When a `question` tool part is still running/pending but the store has no
 * matching QuestionRequest (its `question.asked` SSE event was lost during a
 * gap), the read-only tool bubble used to be the only surface — the agent was
 * blocked with no answerable form. Detecting those gaps lets the caller
 * re-run the authoritative `listPendingQuestions` resync so the real question
 * lands in the store and the normal QuestionCard renders.
 */
export function hasPendingQuestionGap(
  messages: Array<{ info: Message; parts: Part[] }>,
  storeQuestions: QuestionRequest[],
): boolean {
  const matchedCallIDs = new Set<string>()
  for (const question of storeQuestions) {
    if (question.tool?.callID) matchedCallIDs.add(question.tool.callID)
  }

  for (const record of messages) {
    for (const part of record.parts) {
      if (part.type !== "tool" || part.tool !== "question") continue
      const state = part.state as { status?: string; input?: { questions?: QuestionInfo[] } }
      const status = state?.status
      if (!status || !RUNNING_STATUSES.has(status)) continue
      if (part.callID && matchedCallIDs.has(part.callID)) continue
      const questions = state?.input?.questions
      if (!questions || questions.length === 0) continue
      // No callID correlation possible and the session already has an
      // answerable form — assume this part is covered by it.
      if (!part.callID && storeQuestions.length > 0) continue
      return true
    }
  }

  return false
}
