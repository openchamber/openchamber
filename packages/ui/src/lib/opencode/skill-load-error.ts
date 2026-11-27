import { z } from "zod"
import { OpencodeApiError } from "./client"

const skillLoadErrorSchema = z.object({ _tag: z.literal("SkillLoadError"), skill: z.string() })

export const failedSkillLoad = (error: unknown): string | null => {
  const api = error instanceof OpencodeApiError ? error
    : error instanceof Error && error.cause instanceof OpencodeApiError ? error.cause
      : null
  const parsed = skillLoadErrorSchema.safeParse(api?.cause)
  return parsed.success ? parsed.data.skill : null
}
