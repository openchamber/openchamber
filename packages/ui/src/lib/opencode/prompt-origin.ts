
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

export function readPromptOrigin(message: Message): PromptOrigin | undefined {
  if (message.role !== "user") return undefined
  return metadataSchema.safeParse(message.metadata ?? {}).data?.openchamber.promptedBy
}
