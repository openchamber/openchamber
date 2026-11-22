/**
 * The note that hands a session to another model, as OpenCode stores it.
 *
 * "Continue with another model" stops a session's turn, switches the session
 * to the model the user picked, and sends "Continue". The new model reads the
 * whole transcript, but nothing in it says that the model changed (OpenCode
 * turns a switch between two models into no request content at all, core
 * `session/runner/to-llm-message.ts`) or why the previous model stopped. This
 * note says both. It is admitted as a synthetic message that does not wake the
 * session, right before the prompt that does.
 *
 * The text is model-facing English; the user sees it only by opening the
 * notice row. The metadata names both models, so the timeline can title the
 * row "Continued with <model>" (`./session-notices`).
 */

import { z } from "zod"

import type { Message, Metadata } from "./model"
import { formatModelRef, type ModelRefLike } from "./modelRef"

/** What happens to the shell commands and subagents the session started. */
export const CONTINUE_WORK_MODES = ["stop", "keep"] as const
export type ContinueWorkMode = (typeof CONTINUE_WORK_MODES)[number]

/** Where the previous model was when the user moved the session on. */
export type HandoffStop =
  | { kind: "retrying"; attempt?: number; error?: string }
  | { kind: "failed"; error?: string }
  | { kind: "waiting"; on: "question" | "permission" }
  | { kind: "working"; tools: string[] }
  | { kind: "replying" }
  | { kind: "idle" }

/** Work the session started that runs outside its turn: a shell command or a subagent. */
export type HandoffWork =
  | { kind: "shell"; shellID: string; command: string }
  | { kind: "subagent"; sessionID: string; description?: string }

export type ModelHandoff = {
  to: ModelRefLike
  from?: ModelRefLike
  mode: ContinueWorkMode
}

/** The synthetic message that precedes "Continue": what the model reads, the notice label, and the metadata that names the models. */
export type HandoffNote = { text: string; description: string; metadata: Metadata }

const HANDOFF_METADATA_KEY = "openchamberModelHandoff"

// A provider error can carry a whole response body; the note needs the gist.
const MAX_ERROR_LENGTH = 500

const quoted = (model: ModelRefLike): string => `\`${formatModelRef(model)}\``

const sameModel = (left: ModelRefLike, right: ModelRefLike): boolean => (
  left.providerID === right.providerID && left.modelID === right.modelID
)

const clip = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length > MAX_ERROR_LENGTH ? `${trimmed.slice(0, MAX_ERROR_LENGTH)}…` : trimmed
}

const describeStop = (stop: HandoffStop): string => {
  switch (stop.kind) {
    case "retrying": {
      const attempt = stop.attempt ? ` (attempt ${stop.attempt})` : ""
      const error = stop.error ? ` after this error: ${clip(stop.error)}` : ""
      return `The previous model stopped while it waited to retry its last request${attempt}${error}.`
    }
    case "failed":
      return stop.error
        ? `The previous model's last turn failed with this error: ${clip(stop.error)}.`
        : "The previous model's last turn failed."
    case "waiting":
      return stop.on === "question"
        ? "The previous model stopped while it waited for the user to answer its question. That question was cancelled."
        : "The previous model stopped while it waited for the user to approve a tool call. That request was cancelled."
    case "working":
      return stop.tools.length > 0
        ? `The previous model stopped while it was running ${stop.tools.join(", ")}.`
        : "The previous model stopped while it was running a tool."
    case "replying":
      return "The previous model stopped in the middle of its reply."
    case "idle":
      return "The previous model had finished its last reply."
  }
}

const describeWork = (work: HandoffWork): string => (
  work.kind === "shell"
    ? `the command \`${work.command}\` (shell ID: ${work.shellID})`
    : `the subagent ${work.description ? `"${work.description}" ` : ""}(sessionID: ${work.sessionID})`
)

const describeRunningWork = (mode: ContinueWorkMode, work: readonly HandoffWork[]): string | null => {
  if (work.length === 0) return null
  const list = work.map(describeWork).join("; ")
  return mode === "stop"
    ? `The user also stopped the work it had running: ${list}.`
    : `Its work keeps running and reports back in this conversation when it finishes: ${list}. Do not start it again or poll it; carry on and use each result when it arrives.`
}

const toMetadata = (model: ModelRefLike): Metadata => (
  model.variant
    ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
    : { providerID: model.providerID, modelID: model.modelID }
)

/**
 * The synthetic message that precedes "Continue". `from` is the model the
 * session ran on before the switch, when known.
 */
export function modelHandoffNote(input: {
  from?: ModelRefLike
  to: ModelRefLike
  stop: HandoffStop
  mode: ContinueWorkMode
  work: readonly HandoffWork[]
}): HandoffNote {
  const opening = input.from && !sameModel(input.from, input.to)
    ? `The user switched this session from ${quoted(input.from)} to ${quoted(input.to)}, which is you, and asked you to continue.`
    : `The user asked you, ${quoted(input.to)}, to continue this session.`
  const lines = [
    opening,
    describeStop(input.stop),
    describeRunningWork(input.mode, input.work),
    "Pick up the task where the previous model left off. Everything it did is in the conversation above; check the current state of the files before you redo a step.",
  ].filter((line): line is string => line !== null)
  const handoff: Metadata = { to: toMetadata(input.to), mode: input.mode }
  if (input.from) handoff.from = toMetadata(input.from)
  return {
    text: lines.join("\n"),
    description: `Continued with ${formatModelRef(input.to)}`,
    metadata: { [HANDOFF_METADATA_KEY]: handoff },
  }
}

const modelSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
})

const handoffMetadataSchema = z.object({
  [HANDOFF_METADATA_KEY]: z.object({
    to: modelSchema,
    from: modelSchema.optional(),
    mode: z.enum(CONTINUE_WORK_MODES),
  }),
})

/** The handoff a message records, or undefined for any other message. */
export function readModelHandoff(message: Message): ModelHandoff | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = handoffMetadataSchema.safeParse(message.metadata ?? {})
  return parsed.success ? parsed.data[HANDOFF_METADATA_KEY] : undefined
}
