import type { Message, Part } from "@/lib/opencode/model"
import { blocksOnForm } from "@/lib/opencode/tools"

type MessageRecord = {
  info: Message
  parts: Part[]
}

const RECOVERY_DELAYS_MS = [0, 500, 1500] as const

/**
 * v2 has no `form` tool: a form is raised by the tool that blocks on it, which
 * today is `question`.
 */
const isActiveFormTool = (part: Part): boolean => {
  if (part.type !== "tool" || !blocksOnForm(part.tool)) return false
  const status = part.state.status
  return status === "pending" || status === "running"
}

/**
 * A persisted running form tool without a matching pending-request record
 * is the cold-start recovery signal. Only inspect the current turn so an old,
 * stale tool cannot trigger network work after the user has continued chatting.
 */
export function hasActiveFormToolInCurrentTurn(messages: readonly MessageRecord[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.info.role === "user") return false
    if (message.parts.some(isActiveFormTool)) return true
  }
  return false
}

export async function recoverPendingFormWithRetry(
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
