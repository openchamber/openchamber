
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
  completion?: ShellCompletion
  continued: boolean
}

export function findReplyCommandRun(messages: readonly Message[], replyMessageID: string, command: string): ReplyCommandRun | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const note = readReplyCommandNote(messages[index])
    if (note?.replyMessageID !== replyMessageID || note.command !== command) continue
    // external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src/session A shell ID is minted before the linking note and can sort ahead of it.
    const shell = messages.find((message): message is ShellMessage => message.role === "shell" && message.id === note.shellMessageID)
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

export const awaitsContinuation = (run: ReplyCommandRun): boolean => (
  run.completion !== undefined && run.completion.state !== "cancelled" && !run.continued
)

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
