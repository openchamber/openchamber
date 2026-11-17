
import { z } from "zod"

import type { Message } from "./model"

export type DispatchedSessionState = "completed" | "error" | "cancelled"

export type DispatchedSessionResult = {
  sessionID: string
  state: DispatchedSessionState
  title?: string
  output: string
  reportedAt: number
}

const metadataSchema = z.object({
  source: z.literal("openchamber-session"),
  sessionID: z.string().min(1),
  state: z.enum(["completed", "error", "cancelled"]),
  title: z.string().optional(),
})

const ENVELOPE = /^\s*<openchamber-session\b[^>]*>\n?([\s\S]*?)\n?<\/openchamber-session>\s*$/

export function readDispatchedSessionResult(message: Message): DispatchedSessionResult | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = metadataSchema.safeParse(message.metadata ?? {})
  if (!parsed.success) return undefined
  const envelope = message.text.match(ENVELOPE)
  return {
    sessionID: parsed.data.sessionID,
    state: parsed.data.state,
    title: parsed.data.title,
    output: envelope ? envelope[1] : message.text,
    reportedAt: message.time.created,
  }
}
