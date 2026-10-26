/**
 * Background shell commands, as the transcript and the shell routes report them.
 *
 * OpenCode 2.x runs a `shell` call with `background: true` (or one moved to the
 * background mid-run) as a job and settles the tool call at once: its
 * metadata carries `status: "running"` and the `shellID`, and its text is a
 * "moved to the background" notice followed by instructions for the model.
 * While the command runs, `/api/shell` lists it with the originating session
 * in its metadata, and `shell.created` / `shell.exited` / `shell.deleted`
 * announce it on the event stream. When the job settles, OpenCode appends one
 * synthetic message whose metadata names the shell (`source: "shell"`) and
 * whose text wraps the result in a `<shell …>` envelope (core
 * `tool/plugin/shell.ts`, `shell/result.ts`).
 */

import { z } from "zod"

import type { Message, Metadata, ToolPart } from "./model"

/** A command the shell service is still running for a session. */
export type RunningShell = {
  id: string
  sessionID: string
  command: string
  /** File the combined output streams to. */
  file: string
  startedAt: number
}

/**
 * How the shell service reported a command's end on the event stream. A
 * command exits with a terminal status, or is removed: a running command by
 * a user's Stop (the shell route) or by aborting the turn whose tool call
 * waits on it, an exited one when OpenCode evicts it from its history.
 */
export type ShellEnd =
  | { kind: "exited"; status: "exited" | "timeout" | "killed"; exit?: number }
  | { kind: "removed" }

/** How a background command ended, from its completion message. */
export type ShellCompletion = {
  shellID: string
  state: "completed" | "cancelled" | "error"
  exit?: number
  signal?: string
  timeout?: boolean
  /** Captured output and any failure notice, without the envelope. */
  output: string
  endedAt: number
}

const callMetadataSchema = z.object({
  status: z.literal("running"),
  shellID: z.string().min(1),
})

/**
 * The shell id of a call OpenCode moved to the background, or undefined for
 * any other call. Only a settled call carries the marker.
 */
export function readBackgroundShellID(part: ToolPart): string | undefined {
  if (part.state.status !== "completed") return undefined
  return readBackgroundShellIDFromMetadata(part.state.metadata)
}

/**
 * The shell id in the metadata a call settles with when its command went to
 * the background. A call that waits for its command settles only after the
 * command ended, without this marker.
 */
export function readBackgroundShellIDFromMetadata(metadata: Metadata | undefined): string | undefined {
  const parsed = callMetadataSchema.safeParse(metadata ?? {})
  return parsed.success ? parsed.data.shellID : undefined
}

const completionMetadataSchema = z.object({
  source: z.literal("shell"),
  shellID: z.string().min(1),
  state: z.enum(["completed", "cancelled", "error"]),
  exit: z.number().optional(),
  signal: z.string().optional(),
  timeout: z.boolean().optional(),
})

const ENVELOPE = /^\s*<shell\b[^>]*>\n?([\s\S]*?)\n?<\/shell>\s*$/

/** The background command a message reports the end of, or undefined for any other message. */
export function readShellCompletion(message: Message): ShellCompletion | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = completionMetadataSchema.safeParse(message.metadata ?? {})
  if (!parsed.success) return undefined
  const envelope = message.text.match(ENVELOPE)
  return {
    shellID: parsed.data.shellID,
    state: parsed.data.state,
    exit: parsed.data.exit,
    signal: parsed.data.signal,
    timeout: parsed.data.timeout,
    output: envelope ? envelope[1] : message.text,
    endedAt: message.time.created,
  }
}

/** The completion of one background command among a session's messages. */
export function findShellCompletion(messages: readonly Message[], shellID: string): ShellCompletion | undefined {
  // The completion lands after the call, so the newest messages are checked first.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const completion = readShellCompletion(messages[index])
    if (completion?.shellID === shellID) return completion
  }
  return undefined
}

export const shellCompletionFailed = (completion: ShellCompletion): boolean => (
  completion.state !== "completed"
  || completion.timeout === true
  || completion.signal !== undefined
  || (completion.exit !== undefined && completion.exit !== 0)
)

// --- Stopping a background command -------------------------------------------
//
// OpenCode 2.0.19 has no cancel route for a background job. `shell.remove`
// kills the process, but the completion it hands the agent is an error
// (`Shell.NotFoundError`, "nothing ran"), and agents answer that by running
// the command again. OpenChamber therefore tells the agent first, in a
// synthetic message that does not resume the session, what that error is.
// The message only corrects the reading of the error; it must not forbid
// the command, or an agent keeps avoiding it for the rest of the session.

// Stopping several commands at once writes one note for all of them, so the
// agent reads a single explanation before the completions arrive together.

const CANCELLATION_METADATA_KEY = "openchamberShellCancellation"

const cancellationMetadataSchema = z.object({
  [CANCELLATION_METADATA_KEY]: z.union([
    z.object({ shellIDs: z.array(z.string().min(1)).min(1) }),
    // Notes written before stops were grouped name one shell.
    z.object({ shellID: z.string().min(1) }).transform((value) => ({ shellIDs: [value.shellID] })),
  ]),
})

export type StoppedShell = { shellID: string; command: string }

/** A command to stop, with the directory its shell runs in. */
export type ShellToStop = StoppedShell & { shellDirectory: string }

const describeStoppedShell = (shell: StoppedShell): string => `\`${shell.command}\` (shell ID: ${shell.shellID})`

/** The note that precedes stopping background commands of one session. Model-facing text, never shown in the UI. */
export function shellCancellationNote(shells: readonly [StoppedShell, ...StoppedShell[]]) {
  const single = shells.length === 1
  return {
    text: (single
      ? [
        `The user stopped the background command ${describeStoppedShell(shells[0])}.`,
        "The completion notice for it that follows reports an error such as Shell.NotFoundError or says that nothing ran.",
        "That is how the stop shows up: the command did not fail on its own, the user cancelled it.",
        "Do not start it again just because of that notice. The command itself is fine to run later when the task or the user needs it.",
      ]
      : [
        `The user stopped these background commands together: ${shells.map(describeStoppedShell).join(", ")}.`,
        "The completion notices for them that follow report errors such as Shell.NotFoundError or say that nothing ran.",
        "That is how the stop shows up: the commands did not fail on their own, the user cancelled them.",
        "Do not start them again just because of those notices. The commands themselves are fine to run later when the task or the user needs them.",
      ]).join(" "),
    description: single ? "Background command stopped by the user" : "Background commands stopped by the user",
    metadata: { [CANCELLATION_METADATA_KEY]: { shellIDs: shells.map((shell) => shell.shellID) } } satisfies Metadata,
  }
}

/** The shells a stop note is about, or undefined for any other message. */
export function readShellCancellation(message: Message): { shellIDs: string[]; stoppedAt: number } | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = cancellationMetadataSchema.safeParse(message.metadata ?? {})
  return parsed.success ? { shellIDs: parsed.data[CANCELLATION_METADATA_KEY].shellIDs, stoppedAt: message.time.created } : undefined
}

/** When the user stopped one background command, if they did. */
export function findShellCancellation(messages: readonly Message[], shellID: string): { stoppedAt: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cancellation = readShellCancellation(messages[index])
    if (cancellation?.shellIDs.includes(shellID)) return { stoppedAt: cancellation.stoppedAt }
  }
  return undefined
}

const shellOwnerSchema = z.object({ sessionID: z.string().min(1) })

type ShellInfoWire = {
  id: string
  status: string
  command: string
  file: string
  metadata: Metadata
  time: { started: number }
}

/**
 * A running command started on behalf of a session. The shell tool tags every
 * command it spawns with the session; commands without one (a terminal the
 * TUI opened) belong to no session and are not tracked.
 */
export function runningShellFromWire(info: ShellInfoWire): RunningShell | undefined {
  if (info.status !== "running") return undefined
  const owner = shellOwnerSchema.safeParse(info.metadata)
  if (!owner.success) return undefined
  return { id: info.id, sessionID: owner.data.sessionID, command: info.command, file: info.file, startedAt: info.time.started }
}
