import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient, type MessagePage } from "@/lib/opencode/client"
import type { AssistantMessage, Session, UserMessage } from "@/lib/opencode/model"
import { revertLeftFilesUnchanged } from "./revert-outcome"

const user = (id: string): UserMessage => ({ id, sessionID: "s", role: "user", time: { created: 1 } })
const turn = (id: string, start?: string): AssistantMessage => {
  const message: AssistantMessage = { id, sessionID: "s", role: "assistant", time: { created: 1 }, agent: "build", providerID: "p", modelID: "m" }
  if (start) message.snapshot = { start, files: [] }
  return message
}
const changed = [{ file: "a.txt", patch: "", additions: 1, deletions: 1, status: "modified" as const }]

// OpenCode's message pages, newest first, the way the session reads them without part shells.
let read: ReturnType<typeof spyOn<typeof opencodeClient, "getSessionMessages">> | undefined
const pages = (...newestFirst: (UserMessage | AssistantMessage)[][]) => {
  read = spyOn(opencodeClient, "getSessionMessages")
  const spy = read
  newestFirst.forEach((items, index) => {
    const page: MessagePage = { items: items.map((info) => ({ info, parts: [] })), cursor: index < newestFirst.length - 1 ? { next: `c${index + 1}` } : {} }
    spy.mockResolvedValueOnce(page)
  })
  return spy
}

// Shapes of OpenCode 2.4.1's `session.revert.stage` answers seen in live runs.
const staged = (revert: Omit<NonNullable<Session["revert"]>, "messageID">): NonNullable<Session["revert"]> => ({ messageID: "u2", ...revert })

afterEach(() => {
  read?.mockRestore()
  read = undefined
})

describe("revertLeftFilesUnchanged", () => {
  test("a folder outside Git: no snapshot anywhere, nothing restored", async () => {
    pages([turn("a2"), user("u2"), turn("a1"), user("u1")])
    expect(await revertLeftFilesUnchanged("s", staged({ files: [] }))).toBe(true)
  })

  test("Git initialized after the agent's edits: the revert has a snapshot, the reverted turn has none", async () => {
    pages([turn("a3", "tree-after-init"), user("u3")], [turn("a2"), user("u2")])
    expect(await revertLeftFilesUnchanged("s", staged({ snapshot: "tree", files: [] }))).toBe(true)
  })

  test("a Git repository where OpenCode restored the edited files reads nothing more", async () => {
    const read = pages()
    expect(await revertLeftFilesUnchanged("s", staged({ snapshot: "tree", files: changed }))).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  test("a Git repository where the reverted turns edited nothing; older turns without a snapshot do not count", async () => {
    pages([turn("a3", "tree"), user("u3"), turn("a2", "tree"), user("u2"), turn("a1"), user("u1")])
    expect(await revertLeftFilesUnchanged("s", staged({ snapshot: "tree", files: [] }))).toBe(false)
  })

  test("a snapshot that failed at revert time while every reverted turn has one", async () => {
    pages([turn("a2", "tree"), user("u2")])
    expect(await revertLeftFilesUnchanged("s", staged({ files: [] }))).toBe(false)
  })

  test("a cut OpenCode no longer lists falls back to whether the revert had a snapshot", async () => {
    pages([turn("a9", "tree"), user("u9")])
    expect(await revertLeftFilesUnchanged("s", staged({ files: [] }))).toBe(true)
  })

  test("a cut OpenCode no longer lists, with a snapshot, stays quiet", async () => {
    pages([turn("a9", "tree"), user("u9")])
    expect(await revertLeftFilesUnchanged("s", staged({ snapshot: "tree", files: [] }))).toBe(false)
  })
})
