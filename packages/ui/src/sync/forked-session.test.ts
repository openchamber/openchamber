import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { applyForkedSession, noteForkedSessionPatched, type ForkedSessionDeps } from "./forked-session"

const fork: Session = {
  id: "ses_fork",
  projectID: "proj_1",
  directory: "/repo",
  title: "Forked",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const deps = (overrides: Partial<ForkedSessionDeps> = {}) => {
  const applied: Session[] = []
  const reads: Array<[string, string | undefined]> = []
  const value: ForkedSessionDeps = {
    isKnown: () => false,
    isCreatingLocally: () => false,
    getSession: async (sessionID, directory) => {
      reads.push([sessionID, directory])
      return fork
    },
    isCurrent: () => true,
    apply: (info) => applied.push(info),
    ...overrides,
  }
  return { value, applied, reads }
}

const event = { sessionID: "ses_fork", parentID: "ses_parent", directory: "/repo" }

describe("applyForkedSession", () => {
  test("reads an unknown fork in its directory and applies it", async () => {
    const d = deps()
    await applyForkedSession(event, d.value)
    expect(d.reads).toEqual([["ses_fork", "/repo"]])
    expect(d.applied).toEqual([fork])
  })

  test("skips a fork this client already holds", async () => {
    const d = deps({ isKnown: () => true })
    await applyForkedSession(event, d.value)
    expect(d.reads).toEqual([])
    expect(d.applied).toEqual([])
  })

  test("applies nothing when the read fails", async () => {
    const d = deps({ getSession: async () => { throw new Error("offline") } })
    await applyForkedSession(event, d.value)
    expect(d.applied).toEqual([])
  })

  test("drops the read after a runtime switch", async () => {
    const d = deps({ isCurrent: () => false })
    await applyForkedSession(event, d.value)
    expect(d.applied).toEqual([])
  })

  test("leaves a fork this client is creating through /btw to that flow", async () => {
    const d = deps({ isCreatingLocally: (parentID) => parentID === "ses_parent" })
    await applyForkedSession(event, d.value)
    expect(d.reads).toEqual([])
    expect(d.applied).toEqual([])
  })

  test("reads the fork again when it was patched during the read", async () => {
    const marked: Session = { ...fork, title: "Marked" }
    let reads = 0
    const d = deps({
      getSession: async () => {
        reads += 1
        if (reads === 1) {
          noteForkedSessionPatched("ses_fork")
          return fork
        }
        return marked
      },
    })
    await applyForkedSession(event, d.value)
    expect(reads).toBe(2)
    expect(d.applied).toEqual([marked])
  })
})
