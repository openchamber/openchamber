import type { Message, Session } from "@/lib/opencode/model"
import { findMessagePageItem } from "@/lib/opencode/messagePaging"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { revertToMessage } from "./session-actions"
import { getSyncSessionDirectory } from "./sync-refs"

const hasNoSnapshot = (message: Message) => message.role === "assistant" && !message.snapshot?.start

export async function revertLeftFilesUnchanged(sessionId: string, staged: NonNullable<Session["revert"]>, directory?: string | null): Promise<boolean> {
  if (staged.files?.length) return false
  const found = await findMessagePageItem(sessionId, ({ info }) => info.id === staged.messageID || hasNoSnapshot(info), { order: "desc" }, directory)
  return found ? hasNoSnapshot(found.info) : !staged.snapshot
}

export async function revertAndReportFiles(sessionId: string, messageId: string): Promise<{ filesUnchanged: boolean }> {
  const isCurrentRuntime = captureRuntimeInstance()
  const staged = await revertToMessage(sessionId, messageId, { refresh: true })
  let filesUnchanged = !staged.snapshot
  try {
    filesUnchanged = await revertLeftFilesUnchanged(sessionId, staged, getSyncSessionDirectory(sessionId))
  } catch (error) {
    console.warn("[revert] could not read the reverted turns' snapshots:", error)
  }
  if (!isCurrentRuntime()) return { filesUnchanged: false }
  if (filesUnchanged) {
    const { toast } = await import("sonner")
    const { useI18nStore, formatMessage } = await import("@/lib/i18n/store")
    toast.warning(formatMessage(useI18nStore.getState().dictionary, "chat.revert.toast.filesUnchanged"))
  }
  return { filesUnchanged }
}
