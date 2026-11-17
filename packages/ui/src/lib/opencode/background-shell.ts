
import { z } from "zod"

import type { Message, Metadata, ToolPart } from "./model"

export type RunningShell = {
  id: string
  sessionID: string
  command: string
  file: string
  startedAt: number
}

export type ShellEnd =
  | { kind: "exited"; status: "exited" | "timeout" | "killed"; exit?: number }
  | { kind: "removed" }

export type ShellCompletion = {
  shellID: string
  state: "completed" | "cancelled" | "error"
  exit?: number
  signal?: string
  timeout?: boolean
  output: string
  endedAt: number
}

const callMetadataSchema = z.object({
  status: z.literal("running"),
  shellID: z.string().min(1),
})

export function readBackgroundShellID(part: ToolPart): string | undefined {
  if (part.state.status !== "completed") return undefined
  return readBackgroundShellIDFromMetadata(part.state.metadata)
}

export function readBackgroundShellIDFromMetadata(metadata: Metadata | undefined): string | undefined {
  const parsed = callMetadataSchema.safeParse(metadata ?? {})
  return parsed.success ? parsed.data.shellID : undefined
}

const runningCallMetadataSchema = z.object({ shellID: z.string().min(1) })

export function readRunningShellID(part: ToolPart): string | undefined {
  if (part.state.status !== "running") return undefined
  const parsed = runningCallMetadataSchema.safeParse(part.state.metadata ?? {})
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

export function findShellCompletion(messages: readonly Message[], shellID: string): ShellCompletion | undefined {
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

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/tool/plugin/shell.ts Removing a shell reports Shell.NotFoundError to the agent, so a cancellation note precedes removal.


const CANCELLATION_METADATA_KEY = "openchamberShellCancellation"

const cancellationMetadataSchema = z.object({
  [CANCELLATION_METADATA_KEY]: z.union([
    z.object({ shellIDs: z.array(z.string().min(1)).min(1) }),
    z.object({ shellID: z.string().min(1) }).transform((value) => ({ shellIDs: [value.shellID] })),
  ]),
})

export type StoppedShell = { shellID: string; command: string }

export type ShellToStop = StoppedShell & { shellDirectory: string }

const describeStoppedShell = (shell: StoppedShell): string => `\`${shell.command}\` (shell ID: ${shell.shellID})`

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

export function readShellCancellation(message: Message): { shellIDs: string[]; stoppedAt: number } | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = cancellationMetadataSchema.safeParse(message.metadata ?? {})
  return parsed.success ? { shellIDs: parsed.data[CANCELLATION_METADATA_KEY].shellIDs, stoppedAt: message.time.created } : undefined
}

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

export function runningShellFromWire(info: ShellInfoWire): RunningShell | undefined {
  if (info.status !== "running") return undefined
  const owner = shellOwnerSchema.safeParse(info.metadata)
  if (!owner.success) return undefined
  return { id: info.id, sessionID: owner.data.sessionID, command: info.command, file: info.file, startedAt: info.time.started }
}
