/**
 * The records an optimistic prompt shows, apart from the action that inserts
 * them: a draft's first send shows them before its session exists, and
 * tests that mock the session actions keep these real.
 */

import type { Message, Part, SyntheticMessage, UserMessage } from "@/lib/opencode/model"
import { compact, partIds } from "@/lib/opencode/model"
import type { SyntheticContextInput } from "@/lib/opencode/client"
import { toJsonRecord } from "@/lib/opencode/json"
import { ascendingId } from "@/lib/opencode/ids"

/**
 * Ids and timestamp of an optimistic prompt, minted ahead when the prompt is
 * shown before its session exists (a draft's first send), so the records
 * `optimisticSend` inserts later are the ones already on screen.
 */
export type OptimisticPromptIds = { message: string; context: string[]; created: number }

/** Mints the ids of a prompt carrying `contextCount` non-blank context items. */
export function mintOptimisticPromptIds(contextCount: number): OptimisticPromptIds {
  // Context ids come first so they sort before the prompt the way the server
  // admits them.
  const context = Array.from({ length: contextCount }, () => ascendingId("msg"))
  return { context, message: ascendingId("msg"), created: Date.now() }
}

/** One record of an optimistic prompt, in the shape the timeline renders. */
export type OptimisticPromptRecord = { info: Message; parts: Part[] }

type OptimisticPrompt = {
  messageID: string
  context: Array<SyntheticContextInput & { id: string }>
  records: OptimisticPromptRecord[]
}

/** The records an optimistic prompt shows: its context, then the user message. */
export function buildOptimisticPrompt(input: {
  sessionId: string
  content: string
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  context?: SyntheticContextInput[]
  ids?: OptimisticPromptIds
}): OptimisticPrompt {
  // The client skips blank items, so they get no record here. Context added
  // after the ids were minted gets fresh ones.
  const context = (input.context ?? [])
    .filter((item) => item.text.trim())
    .map((item, index) => ({ ...item, id: input.ids?.context[index] ?? ascendingId("msg") }))
  const messageID = input.ids?.message ?? ascendingId("msg")

  // Part ids follow `partIds`, the same derivation the projection uses for the
  // server's echo of this message. Identical ids let the echo reconcile in
  // place instead of rendering the prompt twice.
  const parts: Part[] = [
    { id: partIds.userText(messageID), sessionID: input.sessionId, messageID, type: "text", text: input.content },
  ]
  input.files?.forEach((file, index) => {
    parts.push({
      id: partIds.userFile(messageID, index),
      sessionID: input.sessionId,
      messageID,
      type: "file",
      mime: file.mime,
      url: file.url,
      filename: file.filename,
    })
  })

  // A user message carries no model or agent in the v2 domain model: the turn's
  // provider and agent belong to the assistant message the server produces.
  const created = input.ids?.created ?? Date.now()
  const message: UserMessage = {
    id: messageID,
    role: "user",
    sessionID: input.sessionId,
    // A user message never completes a turn; only assistant messages carry
    // `time.completed`, and readers treat its presence as "turn finished".
    time: { created },
  }

  // The context records carry the prompt's timestamp, so the timeline folds
  // them onto the prompt from the first frame.
  const records: OptimisticPromptRecord[] = context.map((item) => {
    const synthetic: SyntheticMessage = compact({
      id: item.id,
      role: "synthetic",
      sessionID: input.sessionId,
      time: { created },
      text: item.text,
      description: item.description,
      metadata: item.metadata ? toJsonRecord(item.metadata) : undefined,
    })
    return { info: synthetic, parts: [] }
  })
  records.push({ info: message, parts })
  return { messageID, context, records }
}
