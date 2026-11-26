import { describe, expect, test } from "bun:test"
import { isLocationBusy, type LocationWorkReads } from "./location-work"

// What OpenCode still runs in a folder the window is about to release.

const CHAT = "/home/u/chats/session-a"
const OTHER = "/repo/app"

const reads = (input: {
  active?: string[]
  jobs?: { sessionID: string; childSessionID?: string }[]
  directories?: Record<string, string | null>
  failing?: "active" | "jobs" | "session"
}): LocationWorkReads => ({
  activeSessionIDs: async () => {
    if (input.failing === "active") throw new Error("503")
    return input.active ?? []
  },
  runningJobs: async () => {
    if (input.failing === "jobs") throw new Error("503")
    return input.jobs ?? []
  },
  sessionDirectory: async (sessionID) => {
    if (input.failing === "session") throw new Error("503")
    return input.directories?.[sessionID] ?? null
  },
})

describe("isLocationBusy", () => {
  test("a session in a turn there holds the folder, one elsewhere does not", async () => {
    expect(await isLocationBusy(CHAT, reads({ active: ["ses_1"], directories: { ses_1: CHAT } }))).toBe(true)
    expect(await isLocationBusy(CHAT, reads({ active: ["ses_1"], directories: { ses_1: OTHER } }))).toBe(false)
    expect(await isLocationBusy(CHAT, reads({}))).toBe(false)
  })

  test("a subagent running there holds the folder even when its parent sits elsewhere", async () => {
    const jobs = [{ sessionID: "ses_parent", childSessionID: "ses_child" }]
    expect(await isLocationBusy(CHAT, reads({ jobs, directories: { ses_parent: OTHER, ses_child: CHAT } }))).toBe(true)
    expect(await isLocationBusy(OTHER, reads({ jobs, directories: { ses_parent: OTHER, ses_child: CHAT } }))).toBe(true)
  })

  test("a background job of a session there holds the folder", async () => {
    expect(await isLocationBusy(CHAT, reads({ jobs: [{ sessionID: "ses_1" }], directories: { ses_1: CHAT } }))).toBe(true)
  })

  test("the same folder written another way still matches", async () => {
    expect(await isLocationBusy(`${CHAT}/`, reads({ active: ["ses_1"], directories: { ses_1: CHAT } }))).toBe(true)
    expect(await isLocationBusy("c:\\repo\\app", reads({ active: ["ses_1"], directories: { ses_1: "C:/repo/app" } }))).toBe(true)
  })

  test("a session deleted meanwhile is skipped", async () => {
    expect(await isLocationBusy(CHAT, reads({ active: ["ses_gone"], directories: { ses_gone: null } }))).toBe(false)
  })

  test("any read that fails makes the answer unknown, never idle", async () => {
    const busyThere = { active: ["ses_1"], directories: { ses_1: CHAT } }
    expect(await isLocationBusy(CHAT, reads({ ...busyThere, failing: "active" }))).toBe(null)
    expect(await isLocationBusy(CHAT, reads({ ...busyThere, failing: "jobs" }))).toBe(null)
    expect(await isLocationBusy(CHAT, reads({ ...busyThere, failing: "session" }))).toBe(null)
  })
})
