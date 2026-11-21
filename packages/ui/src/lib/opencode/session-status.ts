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
})

export type HostSessionStatusSnapshot = z.infer<typeof hostSessionStatusSnapshotSchema>
