/**
 * Background image generations, as the transcript and the job list report them.
 *
 * OpenCode's image tool (`experimental_image_generate` in 2.2.6) starts a job
 * and settles the call at once: its metadata carries the `jobID` (`image_…`),
 * the `path` the image will be saved under (without its extension) and the
 * `model`. When the job ends, OpenCode appends one synthetic message whose
 * metadata names it (`source`: the tool's name, `jobID`, `state`). Nothing on the event stream
 * announces the job otherwise, so these two are its live start and end; the
 * job list (`job.list`, OpenCode 2.2.6+) is the authoritative view after a gap.
 */

import { z } from "zod"

import type { Message, Metadata } from "./model"

/** An image OpenCode is still generating for a session. */
export type RunningImageJob = {
  id: string
  sessionID: string
  /** Where the image is saved, without its extension. */
  path: string
  /** `providerID/modelID`. */
  model: string
  startedAt: number
}

const startMetadataSchema = z.object({
  jobID: z.string().startsWith("image_"),
  path: z.string().min(1),
  model: z.string().min(1),
})

/** The image job a settled tool call started, from its metadata, or undefined for any other call. */
export function readImageJobStart(metadata: Metadata | undefined): Omit<RunningImageJob, "sessionID" | "startedAt"> | undefined {
  const parsed = startMetadataSchema.safeParse(metadata ?? {})
  return parsed.success ? { id: parsed.data.jobID, path: parsed.data.path, model: parsed.data.model } : undefined
}

// The tool's name is its `source`: `experimental_image_generate` in OpenCode
// 2.2.6, `image_generate` once it leaves the experimental set.
const endMetadataSchema = z.object({
  source: z.string().regex(/^(experimental_)?image_generate$/),
  jobID: z.string().min(1),
})

/** The image job a synthetic message reports as ended, or undefined for any other message. */
export function readImageJobEnd(message: Message): string | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = endMetadataSchema.safeParse(message.metadata ?? {})
  return parsed.success ? parsed.data.jobID : undefined
}

type ImageJobWire = { kind: string; id: string; sessionID: string; status: string; path?: string; model?: string; time: { started: number } }

/**
 * OpenCode gives up on an image after 30 minutes. A job listed as running past
 * that belongs to an OpenCode that stopped mid-generation: 2.2.6 keeps such a
 * job running in its list after a restart, though nothing generates it.
 */
export const IMAGE_JOB_LIFETIME_MS = 31 * 60 * 1000

/** A running image job from `job.list`, or null for any other job or one past its lifetime. */
export function runningImageJobFromWire(job: ImageJobWire, now = Date.now()): RunningImageJob | null {
  if (job.kind !== "image" || job.status !== "running" || !job.path || !job.model) return null
  if (now - job.time.started > IMAGE_JOB_LIFETIME_MS) return null
  return { id: job.id, sessionID: job.sessionID, path: job.path, model: job.model, startedAt: job.time.started }
}
