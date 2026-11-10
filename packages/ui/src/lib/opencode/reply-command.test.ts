import { describe, expect, test } from "bun:test"

import type { Message, Metadata } from "./model"
import {
  awaitsContinuation,
  dropReplyCommandRows,
  findReplyCommandRun,
  isRunnableLanguage,
  replyCommandContinuation,
  replyCommandNote,
  type ReplyCommandNote,
} from "./reply-command"

const base = { sessionID: "ses_1", time: { created: 1 } }
const note: ReplyCommandNote = { replyMessageID: "msg_reply", command: "ls", shellMessageID: "msg_shell", continuationID: "msg_more" }

const synthetic = (id: string, fields: { text: string; metadata: Metadata }): Message => ({ ...base, id, role: "synthetic", ...fields })
// SAFETY: these readers look only at an assistant message's role and id.
const reply = { ...base, id: "msg_reply", role: "assistant" } as Message
const noteMessage = synthetic("msg_note", replyCommandNote(note))
const shell = (id = "msg_shell", shellID = "sh_1"): Message => ({ ...base, id, role: "shell", shellID, command: "ls", status: "exited" })
const completion = (state: string): Message =>
  synthetic("msg_done", { text: "<shell>\nout\n</shell>", metadata: { source: "shell", shellID: "sh_1", state } })
const continuation = synthetic("msg_more", replyCommandContinuation(note))

describe("isRunnableLanguage", () => {
  test("takes shell fences only", () => {
    expect(["bash", "SH", "shell", "zsh"].every(isRunnableLanguage)).toBe(true)
    expect(["", "text", "console", "python"].some(isRunnableLanguage)).toBe(false)
  })
})

describe("findReplyCommandRun", () => {
  test("finds the run of this command from this reply only", () => {
    const messages = [reply, noteMessage, shell()]
    expect(findReplyCommandRun(messages, "msg_reply", "ls")?.shell.id).toBe("msg_shell")
    expect(findReplyCommandRun(messages, "msg_reply", "pwd")).toBeNull()
    expect(findReplyCommandRun(messages, "msg_other", "ls")).toBeNull()
  })

  test("a note whose command never started is no run", () => {
    expect(findReplyCommandRun([reply, noteMessage], "msg_reply", "ls")).toBeNull()
  })

  test("the newest run wins, and one that never started falls back to the one before it", () => {
    const second = { ...note, shellMessageID: "msg_shell_2", continuationID: "msg_more_2" }
    const rerun = [synthetic("msg_note_2", replyCommandNote(second)), shell("msg_shell_2", "sh_2")]
    expect(findReplyCommandRun([reply, noteMessage, shell(), ...rerun], "msg_reply", "ls")?.shell.id).toBe("msg_shell_2")
    expect(findReplyCommandRun([reply, noteMessage, shell(), rerun[0]], "msg_reply", "ls")?.shell.id).toBe("msg_shell")
  })
})

describe("awaitsContinuation", () => {
  const run = (...later: Message[]) => findReplyCommandRun([reply, noteMessage, shell(), ...later], "msg_reply", "ls")!

  test("waits for the output to reach the agent", () => {
    expect(awaitsContinuation(run())).toBe(false)
    expect(awaitsContinuation(run(completion("completed")))).toBe(true)
  })

  test("a failed command continues too, a stopped one does not", () => {
    expect(awaitsContinuation(run(completion("error")))).toBe(true)
    expect(awaitsContinuation(run(completion("cancelled")))).toBe(false)
  })

  test("is settled once the continuation is in", () => {
    expect(awaitsContinuation(run(completion("completed"), continuation))).toBe(false)
  })
})

describe("dropReplyCommandRows", () => {
  const records = (...infos: Message[]) => infos.map((info) => ({ info }))

  test("drops the row of a run its reply shows", () => {
    const input = records(reply, noteMessage, shell())
    expect(dropReplyCommandRows(input).map(({ info }) => info.id)).toEqual(["msg_reply", "msg_note"])
  })

  test("keeps a typed command and a run whose reply is not loaded", () => {
    const typed = records(reply, shell("msg_typed"))
    expect(dropReplyCommandRows(typed)).toBe(typed)
    const paged = records(noteMessage, shell())
    expect(dropReplyCommandRows(paged)).toBe(paged)
  })
})
