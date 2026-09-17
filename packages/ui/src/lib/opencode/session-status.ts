import { z } from "zod"

// An empty status map grants idle authority; null, arrays, or malformed entries
// must never be accepted as an empty successful response by a recovery caller.
export const sessionStatusSnapshotSchema = z.record(z.string().min(1), z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
]))
