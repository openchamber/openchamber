/**
 * Results of sessions an agent dispatched with `returnResult`, as the
 * dispatching session's transcript sees them.
 *
 * When the dispatched session's turn ends, the OpenChamber server
 * (`web/server/lib/dispatch-results`) appends one synthetic message to the
 * session that dispatched it and wakes that session. Its metadata names the
 * dispatched session (`source: "openchamber-session"`) and its text wraps the
 * answer in an `<openchamber-session …>` envelope, the way OpenCode reports a
 * background subagent (see `./subagent-run`).
 */

import { z } from "zod"

import type { Message } from "./model"

export type DispatchedSessionState = "completed" | "error" | "cancelled"

export type DispatchedSessionResult = {
  sessionID: string
  state: DispatchedSessionState
  title?: string
  /** The session's final answer (or failure text), without the envelope. */
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

/** The dispatched session a message reports the result of, or undefined for any other message. */
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
