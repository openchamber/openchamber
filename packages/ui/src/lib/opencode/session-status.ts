import { z } from "zod"

// An empty status map grants idle authority; null, arrays, or malformed entries
// must never be accepted as an empty successful response by a recovery caller.
export const sessionStatusSnapshotSchema = z.record(z.string().min(1), z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
]))

// Requests the host forwards verbatim from OpenCode's ask events; the shapes
// mirror `@/types/permission` and `@/types/question` so a parsed entry is one.
const toolReferenceSchema = z.object({ messageID: z.string(), callID: z.string() }).optional()
const hostPermissionRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  permission: z.string(),
  patterns: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  always: z.array(z.string()),
  tool: toolReferenceSchema,
})
const hostQuestionRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiple: z.boolean().optional(),
  })),
  tool: toolReferenceSchema,
})

// Cross-project status kept by the OpenChamber host (web server or VS Code
// extension host) from its single upstream event stream. Entries carry the
// host's own clock so staleness is judged against `serverTime`, not the client.
export const hostSessionStatusSnapshotSchema = z.object({
  sessions: z.record(z.string().min(1), z.object({
    status: z.string(),
    lastUpdateAt: z.number(),
  })),
  // Permission and question requests the host still sees unanswered, keyed by
  // session. Optional: hosts predating the field, and the VS Code shim, omit it.
  pending: z.record(z.string().min(1), z.object({
    permissions: z.array(hostPermissionRequestSchema),
    questions: z.array(hostQuestionRequestSchema),
  })).optional(),
  serverTime: z.number(),
})

export type HostSessionStatusSnapshot = z.infer<typeof hostSessionStatusSnapshotSchema>
