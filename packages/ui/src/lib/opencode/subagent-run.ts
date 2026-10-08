/**
 * Background subagent runs, as the parent session's transcript sees them.
 *
 * OpenCode 2.x runs a command configured with `subagent: true`, and a
 * `subagent` tool call with `background: true`, as a job in a child session.
 * The parent's transcript gets nothing when the job starts. When the job
 * settles, OpenCode appends one synthetic message whose metadata names the
 * child (`source: "subagent"`) and whose text wraps the result in a
 * `<subagent …>` envelope (core `session/subagent-completion.ts`).
 *
 * While the job runs the only record of it is the child session itself, so a
 * running entry is built here from that record, in the same shape as the
 * completion, and the timeline renders both through one path.
 */

import { z } from "zod"

import type { Message, Metadata, Part, Session, SyntheticMessage, ToolPart } from "./model"
import { isSubagentTool, subagentSessionId } from "./tools"

export type SubagentRunState = "running" | "completed" | "error" | "cancelled"

export type SubagentRun = {
  childSessionID: string
  agent?: string
  state: SubagentRunState
  description?: string
  /** The child's final answer (or failure text), without the envelope. */
  output: string
  /** When the report arrived (for a running entry, when the child started). */
  reportedAt: number
}

const runMetadataSchema = z.object({
  source: z.literal("subagent"),
  childID: z.string().min(1),
  agent: z.string().optional(),
  state: z.enum(["running", "completed", "error", "cancelled"]),
})

const ENVELOPE = /^\s*<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/

/** The subagent run a message reports, or undefined for any other message. */
export function readSubagentRun(message: Message): SubagentRun | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = runMetadataSchema.safeParse(message.metadata ?? {})
  if (!parsed.success) return undefined
  const envelope = message.text.match(ENVELOPE)
  return {
    childSessionID: parsed.data.childID,
    agent: parsed.data.agent,
    state: parsed.data.state,
    description: message.description,
    output: envelope ? envelope[1] : message.text,
    reportedAt: message.time.created,
  }
}

const RUNNING_ID_PREFIX = "subagent-run:"

/**
 * A timeline entry for a job that is still running. It exists only on the
 * client: its id is not a message OpenCode knows, so nothing may revert or
 * fork from it.
 */
export function runningSubagentRunMessage(parentSessionID: string, child: Session): SyntheticMessage {
  const metadata: Metadata = { source: "subagent", childID: child.id, state: "running" }
  if (child.agent) metadata.agent = child.agent
  return {
    id: `${RUNNING_ID_PREFIX}${child.id}`,
    sessionID: parentSessionID,
    role: "synthetic",
    time: { created: child.time.created },
    text: "",
    description: child.title,
    metadata,
  }
}

export const isRunningSubagentRunMessage = (messageID: string): boolean => messageID.startsWith(RUNNING_ID_PREFIX)

// --- Subagent calls that went to the background ------------------------------
//
// A `subagent` tool call the model sent with `background: true`, or one the
// user moved there (`session.background`), settles at once with
// `metadata.status: "running"` and the child in `metadata.sessionID`. The
// report arrives later as the synthetic message above. The call already has
// a row in the transcript, so the report belongs on that row rather than in a
// row of its own.

const backgroundCallMetadataSchema = z.object({
  status: z.literal("running"),
  sessionID: z.string().min(1),
})

/** The child session of a subagent call that went to the background, or undefined for any other call. */
export function readBackgroundSubagentChildID(part: ToolPart): string | undefined {
  if (part.state.status !== "completed" || !isSubagentTool(part.tool)) return undefined
  const parsed = backgroundCallMetadataSchema.safeParse(part.state.metadata ?? {})
  return parsed.success ? parsed.data.sessionID : undefined
}

/** The report of one child session among a session's messages. */
export function findSubagentRun(messages: readonly Message[], childSessionID: string): SubagentRun | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const run = readSubagentRun(messages[index])
    if (run?.childSessionID === childSessionID) return run
  }
  return undefined
}

// --- Stopping a subagent -----------------------------------------------------
//
// OpenCode 2.0.23 has no route that cancels a subagent job. Interrupting the
// child session ends its job as cancelled, and the agent hears about it as a
// failure: a foreground call fails with "Subagent cancelled", a background
// one reports `state="cancelled"`. Agents answer a failed subagent by
// starting it again, so OpenChamber tells the agent first, in a synthetic
// message that does not resume the session, that the stop was the user's.
// Like the shell note, it corrects the reading of the failure and must not
// forbid the work.

const CANCELLATION_METADATA_KEY = "openchamberSubagentCancellation"

const cancellationMetadataSchema = z.object({
  [CANCELLATION_METADATA_KEY]: z.object({ sessionID: z.string().min(1) }),
})

/** The note that precedes stopping a subagent. Model-facing text, never shown in the UI. */
export function subagentCancellationNote(input: { childSessionID: string; description: string | undefined }) {
  const named = input.description ? `the subagent "${input.description}"` : "a subagent"
  return {
    text: [
      `The user stopped ${named} (sessionID: ${input.childSessionID}).`,
      "The result for it that follows reports that the subagent was cancelled.",
      "That is how the stop shows up: the subagent did not fail on its own, the user cancelled it.",
      "Do not start it again just because of that result. The same work is fine to delegate later when the task or the user needs it.",
    ].join(" "),
    description: "Subagent stopped by the user",
    metadata: { [CANCELLATION_METADATA_KEY]: { sessionID: input.childSessionID } } satisfies Metadata,
  }
}

/** Whether the user stopped the subagent running in one child session. */
export function findSubagentCancellation(messages: readonly Message[], childSessionID: string): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "synthetic") continue
    const parsed = cancellationMetadataSchema.safeParse(message.metadata ?? {})
    if (parsed.success && parsed.data[CANCELLATION_METADATA_KEY].sessionID === childSessionID) return true
  }
  return false
}

/**
 * The records with only the subagent reports of `subagent: true` commands
 * that started inside them. A report never opens a row of its own at the end
 * of the chat for a subagent the transcript already shows, or started before
 * the loaded history: the first finishes its call's row, the second is
 * reachable from the session's subagent list. A command run leaves no call,
 * so its report is its only trace; it is recognised as a child that started
 * within the loaded records while no call in them names it. A child whose
 * start is unknown is treated as outside. Returns the input unchanged when
 * nothing is dropped.
 */
export function keepCommandSubagentReports<T extends { info: Message; parts: Part[] }>(
  records: T[],
  childStartedAt: (childSessionID: string) => number | undefined,
): T[] {
  if (!records.some((record) => readSubagentRun(record.info) !== undefined)) return records
  const called = new Set<string>()
  for (const record of records) {
    if (record.info.role !== "assistant") continue
    for (const part of record.parts) {
      if (part.type !== "tool" || !isSubagentTool(part.tool) || part.state.status === "pending") continue
      const childID = subagentSessionId(part.state.metadata)
      if (childID) called.add(childID)
    }
  }
  const loadedSince = records[0]?.info.time.created ?? 0
  const kept = records.filter((record) => {
    const run = readSubagentRun(record.info)
    if (!run) return true
    if (called.has(run.childSessionID)) return false
    const startedAt = childStartedAt(run.childSessionID)
    return startedAt !== undefined && startedAt >= loadedSince
  })
  return kept.length === records.length ? records : kept
}
