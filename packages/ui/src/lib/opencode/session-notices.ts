/**
 * Session notices: the labelled messages OpenCode, a plugin or OpenChamber
 * puts into a session that the timeline shows as a one-line info row.
 *
 * A notice is a `synthetic` message with a `description`, or the `system`
 * message OpenCode writes when the session's instructions change. OpenCode's
 * own TUI shows every such message; the timeline shows the subset below and
 * hides the rest. A message without a description is never a notice.
 * Expanding a row shows the text the model received.
 *
 * Shown:
 * - A plugin's notice: any synthetic message with a description that no rule
 *   below claims (a quota plugin's "waiting for quota reset"). The row reads
 *   the plugin's description as it is.
 * - "Continuing after restart" (`metadata.notice: "restart"`): the OpenCode
 *   server restarted mid-turn and the agent carries on.
 * - A `!command` that could not start (`source: "shell"`, `state: "error"`,
 *   no `shellID`): otherwise the failure shows nowhere.
 * - "Moved to <folder>": an "Instructions updated" whose sources include the
 *   environment (`core/environment`), which changes when the session moves to
 *   a worktree, a project or back from a removed worktree. The folder is the
 *   `Working directory` line of the text OpenCode gave the model.
 *
 * Hidden, and why:
 * - The rest about the session's instructions, as noise the maintainer saw in
 *   real sessions (2026-10-19): "Instructions updated" without the
 *   environment (AGENTS.md and config instruction files, skills, MCP servers,
 *   Code Mode, references or the date changed) and "Loaded <files>"
 *   (`metadata.instruction.paths`, an AGENTS.md of a folder the agent entered).
 * - Composer context (an inline comment, terminal output, a linked issue):
 *   it folds into the user message as context chips.
 * - A background subagent's report and a dispatched session's result: they
 *   render as their own rows already (`subagent-run`, `dispatched-session`).
 * - A background shell command's completion: it finishes the shell call's
 *   own row (`background-shell`).
 * - OpenChamber's notes to the agent that the user stopped a subagent or a
 *   background command: the row of that call already says stopped.
 * - "ACP embedded context": editor context an ACP client sends; it is the
 *   user's own attachment, not news.
 */

import { z } from "zod"

import { readContextPart } from "@/lib/messages/contextParts"

import { readShellCancellation, readShellCompletion } from "./background-shell"
import { readDispatchedSessionResult } from "./dispatched-session"
import { readWorkflowReport } from "@/lib/workflows/report"
import type { Message, Metadata, Part, ToolPart } from "./model"
import { isSubagentCancellationNote, readSubagentRun } from "./subagent-run"

export type SessionNotice =
  | { kind: "plugin"; label: string; text: string }
  | { kind: "restart"; text: string }
  | { kind: "command-failed"; command: string; text: string }
  | { kind: "moved"; folder: string | null; text: string }

const HIDDEN_DESCRIPTIONS = new Set(["ACP embedded context"])

const restartSchema = z.object({ notice: z.literal("restart") })
const instructionsLoadedSchema = z.object({ instruction: z.object({ paths: z.array(z.string()) }) })
const failedCommandSchema = z.object({ source: z.literal("shell"), state: z.literal("error") })

const instructionsUpdatedSchema = z.object({ notice: z.literal("instructions"), instructionSources: z.array(z.string()) })
const ENVIRONMENT_SOURCE = "core/environment"
const WORKING_DIRECTORY_LINE = /^\s*Working directory: (.+)$/m

const readMove = (message: Extract<Message, { role: "system" }>): SessionNotice | undefined => {
  const parsed = instructionsUpdatedSchema.safeParse(message.metadata ?? {})
  if (!parsed.success || !parsed.data.instructionSources.includes(ENVIRONMENT_SOURCE)) return undefined
  const folder = message.text.match(WORKING_DIRECTORY_LINE)?.[1]?.trim() || null
  return { kind: "moved", folder, text: message.text }
}

/** The notice a message carries, or undefined when the timeline does not show it. */
export function readSessionNotice(message: Message): SessionNotice | undefined {
  if (message.role === "system") return readMove(message)
  if (message.role !== "synthetic") return undefined
  const description = message.description?.trim()
  if (!description) return undefined
  const metadata = message.metadata ?? {}
  if (readContextPart({ type: "text", metadata: message.metadata })) return undefined
  if (readSubagentRun(message) || readDispatchedSessionResult(message) || readWorkflowReport(message)) return undefined
  if (readShellCompletion(message) || readShellCancellation(message) || isSubagentCancellationNote(message)) return undefined
  if (HIDDEN_DESCRIPTIONS.has(description) || instructionsLoadedSchema.safeParse(metadata).success) return undefined
  const text = message.text
  if (restartSchema.safeParse(metadata).success) return { kind: "restart", text }
  if (failedCommandSchema.safeParse(metadata).success) return { kind: "command-failed", command: description, text }
  return { kind: "plugin", label: description, text }
}

// --- Notice rows inside a turn's Activity -----------------------------------
//
// A notice that lands while the agent works belongs to that run, so it
// renders as a row of the step it followed, like a tool call. The row is a
// tool part only OpenChamber makes: Activity counts, trims and folds it with
// the step's other rows, and `MessageBody` draws it as a notice.

const SESSION_NOTICE_TOOL = "openchamber-session-notice"

const NOTICE_METADATA_KEY = "openchamberSessionNotice"

const noticeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plugin"), label: z.string(), text: z.string() }),
  z.object({ kind: z.literal("restart"), text: z.string() }),
  z.object({ kind: z.literal("command-failed"), command: z.string(), text: z.string() }),
  z.object({ kind: z.literal("moved"), folder: z.string().nullable(), text: z.string() }),
])

const noticePartMetadataSchema = z.object({ [NOTICE_METADATA_KEY]: noticeSchema })

/** Whether a notice row sits before the step's own parts (it came before the step) or after them. */
export type SessionNoticePlacement = "before" | "after"

const PLACEMENT_METADATA_KEY = "openchamberSessionNoticePlacement"

const placementMetadataSchema = z.object({ [PLACEMENT_METADATA_KEY]: z.enum(["before", "after"]) })

/** The Activity row for a notice message, owned by the step `ownerMessageID`. */
export function sessionNoticePart(
  message: Message,
  notice: SessionNotice,
  ownerMessageID: string,
  placement: SessionNoticePlacement,
): ToolPart {
  const created = message.time.created
  return {
    id: `notice:${message.id}`,
    sessionID: message.sessionID,
    messageID: ownerMessageID,
    type: "tool",
    callID: message.id,
    tool: SESSION_NOTICE_TOOL,
    state: {
      status: "completed",
      input: {},
      output: notice.text,
      metadata: { [NOTICE_METADATA_KEY]: notice, [PLACEMENT_METADATA_KEY]: placement } satisfies Metadata,
      time: { start: created, end: created },
    },
  }
}

/** The notice an Activity row stands for, or undefined for any other part. */
export function readSessionNoticePart(part: ToolPart): SessionNotice | undefined {
  if (part.tool !== SESSION_NOTICE_TOOL || part.state.status !== "completed") return undefined
  const parsed = noticePartMetadataSchema.safeParse(part.state.metadata ?? {})
  return parsed.success ? parsed.data[NOTICE_METADATA_KEY] : undefined
}

/** Whether a part is a notice row `sessionNoticePart` made. */
export const isSessionNoticePart = (part: Part): boolean => part.type === "tool" && part.tool === SESSION_NOTICE_TOOL

/** Where a notice row sits among its step's parts, or undefined for any other part. */
export function sessionNoticePlacement(part: Part): SessionNoticePlacement | undefined {
  if (!isSessionNoticePart(part) || part.type !== "tool" || part.state.status !== "completed") return undefined
  const parsed = placementMetadataSchema.safeParse(part.state.metadata ?? {})
  return parsed.success ? parsed.data[PLACEMENT_METADATA_KEY] : undefined
}
