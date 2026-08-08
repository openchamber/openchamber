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
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { QuestionInfo, QuestionRequest } from "@/types/question"

const RUNNING_STATUSES = new Set(["running", "pending"])

/**
 * True when a running `question` tool part in the given message records has no
 * matching store question (its `question.asked` SSE event was lost). A part is
 * covered when the store has a question with the same tool `callID`; when the
 * part has no callID (or the store question carries no tool reference to
 * correlate), a part is still treated as covered as long as the session has any
 * store question — the real QuestionCard is already answerable and we must not
 * retrigger recovery.
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
