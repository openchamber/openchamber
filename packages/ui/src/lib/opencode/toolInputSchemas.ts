import { z } from "zod"

export const optionalText = z.string().trim().min(1).optional().catch(undefined)
export const optionalCount = z.number().int().nonnegative().optional().catch(undefined)

export const booleanish = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
  .optional()
  .catch(undefined)
