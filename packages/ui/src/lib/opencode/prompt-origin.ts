/**
 * The session whose agent sent a user message, through the openchamber
 * tool's `session.create`, `session.send` or `session.fork`.
 *
 * The OpenChamber server records it on the prompt's message as
 * `metadata.openchamber.promptedBy` (`web/server/lib/openchamber-sessions`).
 * The title is what the sender was called when it sent the prompt, a fallback
 * for a reader that cannot see that session now.
 */

import { z } from "zod"

import type { Message } from "./model"

export type PromptOrigin = {
  sessionID: string
  title?: string
}

const metadataSchema = z.object({
  openchamber: z.object({
    promptedBy: z.object({
      sessionID: z.string().trim().min(1),
      title: z.string().trim().min(1).optional().catch(undefined),
    }),
  }),
})

/** The session that sent a user message, or undefined for a message the user wrote. */
export function readPromptOrigin(message: Message): PromptOrigin | undefined {
  if (message.role !== "user") return undefined
  return metadataSchema.safeParse(message.metadata ?? {}).data?.openchamber.promptedBy
}
