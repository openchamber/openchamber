/**
 * A command the user runs from a code block of the agent's reply.
 *
 * OpenCode runs it as a user shell command, the way `!command` does, and hands
 * the agent the output without waking it. The chat adds two synthetic messages
 * around that run, both hidden from the timeline: a note before it that ties
 * the shell message to the block, so the block finds its run again after a
 * reload, and a continuation after it that starts the agent's next turn.
 * `session.shell` takes no metadata, so the note is the only durable link.
 */

import { z } from "zod"

import { findShellCompletion, type ShellCompletion } from "./background-shell"
import type { Message, Metadata } from "./model"

const NOTE_METADATA_KEY = "openchamberReplyCommand"
const CONTINUATION_METADATA_KEY = "openchamberReplyCommandContinuation"

const RUNNABLE_LANGUAGES = new Set(["bash", "sh", "shell", "zsh"])

export const isRunnableLanguage = (language: string): boolean => RUNNABLE_LANGUAGES.has(language.toLowerCase())

const noteSchema = z.object({
  replyMessageID: z.string().min(1),
  command: z.string().min(1),
  shellMessageID: z.string().min(1),
  continuationID: z.string().min(1),
})

export type ReplyCommandNote = z.infer<typeof noteSchema>

/** No description: a labelled synthetic message draws as a notice row. */
export function replyCommandNote(note: ReplyCommandNote) {
  return {
    text: `The user is running this command from your reply:\n${note.command}`,
    metadata: { [NOTE_METADATA_KEY]: note } satisfies Metadata,
  }
}

export function replyCommandContinuation(note: ReplyCommandNote) {
  return {
    text: "The command the user ran from your reply has ended; its output is above. Continue from it.",
    metadata: { [CONTINUATION_METADATA_KEY]: { shellMessageID: note.shellMessageID } } satisfies Metadata,
  }
}

function readReplyCommandNote(message: Message): ReplyCommandNote | undefined {
  if (message.role !== "synthetic") return undefined
  const raw = message.metadata?.[NOTE_METADATA_KEY]
  if (raw === undefined) return undefined
  const parsed = noteSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

const continuedShellMessageID = (message: Message): string | undefined => {
  if (message.role !== "synthetic") return undefined
  const raw = message.metadata?.[CONTINUATION_METADATA_KEY]
  if (raw === undefined) return undefined
  const parsed = z.object({ shellMessageID: z.string() }).safeParse(raw)
  return parsed.success ? parsed.data.shellMessageID : undefined
}

export type ShellMessage = Extract<Message, { role: "shell" }>

export type ReplyCommandRun = {
  note: ReplyCommandNote
  shell: ShellMessage
  /** How the command ended, once OpenCode handed the output to the agent. */
  completion?: ShellCompletion
  /** The agent has been asked to continue from this run. */
  continued: boolean
}

/** The newest run of `command` from the reply, or null while it has none. */
export function findReplyCommandRun(messages: readonly Message[], replyMessageID: string, command: string): ReplyCommandRun | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const note = readReplyCommandNote(messages[index])
    if (note?.replyMessageID !== replyMessageID || note.command !== command) continue
    // OpenCode orders the shell by the id minted before the note went out, so
    // it can sort ahead of the note.
    const shell = messages.find((message): message is ShellMessage => message.role === "shell" && message.id === note.shellMessageID)
    // A note whose command never started leaves the block as if it never ran.
    if (!shell) continue
    return {
      note,
      shell,
      completion: findShellCompletion(messages, shell.shellID),
      continued: messages.some((message) => continuedShellMessageID(message) === note.shellMessageID),
    }
  }
  return null
}

/** The run still owes the agent its continuation. A command the user stopped owes none. */
export const awaitsContinuation = (run: ReplyCommandRun): boolean => (
  run.completion !== undefined && run.completion.state !== "cancelled" && !run.continued
)

/**
 * The records without the shell rows a block of a loaded reply shows itself.
 * A run whose reply is outside the loaded history keeps its row, so it stays
 * visible somewhere. Returns the input unchanged when nothing is dropped.
 */
export function dropReplyCommandRows<T extends { info: Message }>(records: T[]): T[] {
  const replyOfShell = new Map<string, string>()
  const replies = new Set<string>()
  for (const { info } of records) {
    if (info.role === "assistant") replies.add(info.id)
    const note = readReplyCommandNote(info)
    if (note) replyOfShell.set(note.shellMessageID, note.replyMessageID)
  }
  if (replyOfShell.size === 0) return records
  const kept = records.filter(({ info }) => {
    if (info.role !== "shell") return true
    const reply = replyOfShell.get(info.id)
    return reply === undefined || !replies.has(reply)
  })
  return kept.length === records.length ? records : kept
}
