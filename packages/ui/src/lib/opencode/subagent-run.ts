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

import type { Message, Metadata, Session, SyntheticMessage } from "./model"

export type SubagentRunState = "running" | "completed" | "error" | "cancelled"

export type SubagentRun = {
  childSessionID: string
  agent?: string
  state: SubagentRunState
  description?: string
  /** The child's final answer (or failure text), without the envelope. */
  output: string
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
