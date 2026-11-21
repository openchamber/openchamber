
import { z } from "zod"

import type { Message, Metadata, Part, Session, SyntheticMessage, ToolPart } from "./model"
import { isSubagentTool, subagentDescription, subagentSessionId } from "./tools"

export type SubagentRunState = "running" | "completed" | "error" | "cancelled"

export type SubagentRun = {
  childSessionID: string
  agent?: string
  state: SubagentRunState
  description?: string
  output: string
  reportedAt: number
}

const runMetadataSchema = z.object({
  source: z.literal("subagent"),
  childID: z.string().min(1),
  agent: z.string().optional(),
  state: z.enum(["running", "completed", "error", "cancelled"]),
})

const ENVELOPE = /^\s*<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/

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


const backgroundCallMetadataSchema = z.object({
  status: z.literal("running"),
  sessionID: z.string().min(1),
})

export function readBackgroundSubagentChildID(part: ToolPart): string | undefined {
  if (part.state.status !== "completed" || !isSubagentTool(part.tool)) return undefined
  const parsed = backgroundCallMetadataSchema.safeParse(part.state.metadata ?? {})
  return parsed.success ? parsed.data.sessionID : undefined
}

const foregroundCallMetadataSchema = z.object({
  status: z.enum(["completed", "error", "cancelled"]).optional(),
  sessionID: z.string().min(1),
})

export function readForegroundSubagentRun(part: ToolPart): SubagentRun | undefined {
  if (!isSubagentTool(part.tool)) return undefined
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined
  const parsed = foregroundCallMetadataSchema.safeParse(part.state.metadata ?? {})
  if (!parsed.success) return undefined
  const text = part.state.status === "completed" ? part.state.output : part.state.output || part.state.error
  const envelope = text.match(ENVELOPE)
  const state = part.state.status === "error" ? "error" : parsed.data.status ?? "completed"
  return {
    childSessionID: parsed.data.sessionID,
    state,
    description: subagentDescription(part.state.input),
    output: envelope ? envelope[1] : text,
    reportedAt: part.state.time.end,
  }
}

export function findSubagentRun(messages: readonly Message[], childSessionID: string): SubagentRun | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const run = readSubagentRun(messages[index])
    if (run?.childSessionID === childSessionID) return run
  }
  return undefined
}

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session Interrupting a child reports cancellation as failure to its parent; a user-stop note precedes interruption.

const CANCELLATION_METADATA_KEY = "openchamberSubagentCancellation"

const cancellationMetadataSchema = z.object({
  [CANCELLATION_METADATA_KEY]: z.object({ sessionID: z.string().min(1) }),
})

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

export const isSubagentCancellationNote = (message: Message): boolean => (
  message.role === "synthetic" && cancellationMetadataSchema.safeParse(message.metadata ?? {}).success
)

export function findSubagentCancellation(messages: readonly Message[], childSessionID: string): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "synthetic") continue
    const parsed = cancellationMetadataSchema.safeParse(message.metadata ?? {})
    if (parsed.success && parsed.data[CANCELLATION_METADATA_KEY].sessionID === childSessionID) return true
  }
  return false
}

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
