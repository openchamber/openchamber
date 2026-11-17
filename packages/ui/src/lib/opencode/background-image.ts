
import { z } from "zod"

import type { Message, Metadata } from "./model"

export type RunningImageJob = {
  id: string
  sessionID: string
  path: string
  model: string
  startedAt: number
}

const startMetadataSchema = z.object({
  jobID: z.string().startsWith("image_"),
  path: z.string().min(1),
  model: z.string().min(1),
})

export function readImageJobStart(metadata: Metadata | undefined): Omit<RunningImageJob, "sessionID" | "startedAt"> | undefined {
  const parsed = startMetadataSchema.safeParse(metadata ?? {})
  return parsed.success ? { id: parsed.data.jobID, path: parsed.data.path, model: parsed.data.model } : undefined
}

const endMetadataSchema = z.object({
  source: z.string().regex(/^(experimental_)?image_generate$/),
  jobID: z.string().min(1),
})

export function readImageJobEnd(message: Message): string | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = endMetadataSchema.safeParse(message.metadata ?? {})
  return parsed.success ? parsed.data.jobID : undefined
}

type ImageJobWire = { kind: string; id: string; sessionID: string; status: string; path?: string; model?: string; time: { started: number } }

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src A restarted server can retain running image jobs after generation stops; jobs expire after 30 minutes.
export const IMAGE_JOB_LIFETIME_MS = 31 * 60 * 1000

export function runningImageJobFromWire(job: ImageJobWire, now = Date.now()): RunningImageJob | null {
  if (job.kind !== "image" || job.status !== "running" || !job.path || !job.model) return null
  if (now - job.time.started > IMAGE_JOB_LIFETIME_MS) return null
  return { id: job.id, sessionID: job.sessionID, path: job.path, model: job.model, startedAt: job.time.started }
}
