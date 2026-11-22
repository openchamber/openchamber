import { z } from "zod"

export const activeSessionSnapshotSchema = z.record(z.string().min(1), z.object({ type: z.literal("running") }))

const hostPermissionRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  action: z.string(),
  resources: z.array(z.string()),
  save: z.array(z.string()).optional(),
})
const hostFormRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  title: z.string(),
})
const hostPageRequestSchema = hostFormRequestSchema

export const hostSessionStatusSnapshotSchema = z.object({
  sessions: z.record(z.string().min(1), z.object({
    status: z.string(),
    lastUpdateAt: z.number(),
    turnStartedAt: z.number().optional(),
  })),
  pending: z.record(z.string().min(1), z.object({
    permissions: z.array(hostPermissionRequestSchema),
    forms: z.array(hostFormRequestSchema),
    pages: z.array(hostPageRequestSchema).optional().default([]),
  })).optional(),
  context: z.record(z.string().min(1), z.discriminatedUnion("state", [
    z.object({ state: z.literal("measured"), tokens: z.number().positive() }),
    z.object({ state: z.literal("compacted") }),
  ])).optional(),
  serverTime: z.number(),
  // A replaced OpenCode still runs the turns busy at its handoff, and the
  // current OpenCode's running list does not name them. Hosts predating the
  // field, and the VS Code shim, omit it.
  openCodeDraining: z.boolean().optional(),
})

export type HostSessionStatusSnapshot = z.infer<typeof hostSessionStatusSnapshotSchema>

// Session-activity v1 envelope (external observability contract, design
// #612): the web server (#524) and the VS Code extension host (#621) both
// answer /api/session-activity with this shape. `type` is the frozen
// per-session phase; every other entry field is additive, and an unknown is
// an explicit null. A payload that does not match is not activity data at
// all — consumers must read it as "no snapshot", never as a session map.
const sessionActivityV1EntrySchema = z.object({
  type: z.enum(["idle", "busy", "cooldown"]),
  lastActivityAt: z.number(),
  status: z.string().nullable(),
  model: z.object({
    modelID: z.string().nullable(),
    providerID: z.string().nullable(),
  }).nullable(),
  toolInFlight: z.null(),
})

export const sessionActivityV1SnapshotSchema = z.object({
  version: z.literal(1),
  serverTime: z.number(),
  watcherReady: z.boolean(),
  sessions: z.record(z.string().min(1), sessionActivityV1EntrySchema),
})

export type SessionActivityV1Entry = z.infer<typeof sessionActivityV1EntrySchema>
