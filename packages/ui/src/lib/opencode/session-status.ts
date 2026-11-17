import { z } from "zod"

// v2 reports active loops globally. A malformed response cannot prove idle.
export const activeSessionSnapshotSchema = z.record(z.string().min(1), z.object({ type: z.literal("running") }))

// Requests the host forwards from OpenCode's own events. Only the fields the
// cross-directory index needs are parsed; zod drops the rest, so a parsed
// entry is exactly the projection `sync/global-blocking-requests.ts` stores.
const hostPermissionRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  action: z.string(),
  resources: z.array(z.string()),
  // The tray decides whether to offer "Allow always" from these patterns, so a
  // seeded request has to keep them or it looks unsavable.
  save: z.array(z.string()).optional(),
})
const hostFormRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  title: z.string(),
})
// A page an agent showed that waits for the user's answer: same projection.
const hostPageRequestSchema = hostFormRequestSchema

// Cross-project status kept by the OpenChamber host (web server or VS Code
// extension host) from its single upstream event stream. Entries carry the
// host's own clock so staleness is judged against `serverTime`, not the client.
export const hostSessionStatusSnapshotSchema = z.object({
  sessions: z.record(z.string().min(1), z.object({
    status: z.string(),
    lastUpdateAt: z.number(),
  })),
  // Permission requests and forms the host still sees unanswered, keyed by
  // session. Optional: hosts predating the field, and the VS Code shim, omit it.
  pending: z.record(z.string().min(1), z.object({
    permissions: z.array(hostPermissionRequestSchema),
    forms: z.array(hostFormRequestSchema),
    // Hosts predating waiting pages, and the VS Code shim, omit it.
    pages: z.array(hostPageRequestSchema).optional().default([]),
  })).optional(),
  serverTime: z.number(),
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
