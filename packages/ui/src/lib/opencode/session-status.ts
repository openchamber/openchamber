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
})
const hostFormRequestSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  title: z.string(),
})

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
  })).optional(),
  serverTime: z.number(),
})

export type HostSessionStatusSnapshot = z.infer<typeof hostSessionStatusSnapshotSchema>
