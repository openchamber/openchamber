import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client"

type MessageRecord = {
  info: Message
  parts: Part[]
}

const RECOVERY_DELAYS_MS = [0, 500, 1500] as const

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
