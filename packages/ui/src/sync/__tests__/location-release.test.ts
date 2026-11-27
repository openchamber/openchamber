import { afterEach, describe, expect, test } from "bun:test"
import { createLocationRelease, directoryUse, isWorktreeDirectory, type DirectoryUse } from "../location-release"
import { replaceGlobalSessionStatusById } from "../global-session-status"
import { replaceDirectoryShells, resetBackgroundShells } from "../background-shells"
import {
  PENDING_ASSIST_MAX_AGE_MS,
  applySessionAssistEvent,
  resetPendingSessionAssists,
  subscribeSessionAssistSettled,
} from "../pending-session-assists"
import type { WorktreeMetadata } from "@/types/worktree"

// Leaving a chat or worktree directory releases its OpenCode location (and with
// it the directory's MCP servers) once nothing there still needs it.

const CHAT = "/home/u/.config/openchamber/chats/2026-10-03/session-a"
const OTHER_CHAT = "/home/u/.config/openchamber/chats/2026-10-03/session-b"
const WORKTREE = "/repo/app-worktrees/feature"
const PROJECT = "/repo/app"
const OTHER_PROJECT = "/repo/other"
const CHAT_DELAY = 30_000
const WORKTREE_DELAY = 300_000
const PROJECT_DELAY = 900_000

type ManualTimer = { run: () => void; ms: number; cleared: boolean }

function harness(options: { busy?: Set<string>; unknown?: Set<string>; serverBusy?: Set<string>; serverUnreadable?: boolean; failRelease?: boolean } = {}) {
  const timers: ManualTimer[] = []
  const released: string[] = []
  const busy = options.busy ?? new Set<string>()
  const unknown = options.unknown ?? new Set<string>()
  const serverBusy = options.serverBusy ?? new Set<string>()
  const current = { value: PROJECT }
  const release = createLocationRelease<ManualTimer>({
    releaseDelayMs: (directory) => {
      if (directory.includes("/chats/")) return CHAT_DELAY
      return directory === WORKTREE ? WORKTREE_DELAY : PROJECT_DELAY
    },
    isCurrentDirectory: (directory) => directory === current.value,
    directoryUse: (directory): DirectoryUse => {
      if (unknown.has(directory)) return "unknown"
      return busy.has(directory) ? "busy" : "free"
    },
    isBusyOnServer: async (directory) => (options.serverUnreadable ? null : serverBusy.has(directory)),
    release: async (directory) => {
      released.push(directory)
      if (options.failRelease) throw new Error("404")
    },
    timers: {
      set: (run, ms) => {
        const timer = { run, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clear: (timer) => {
        timer.cleared = true
      },
    },
  })
  const move = (next: string) => {
    const previous = current.value
    current.value = next
    release.directoryChanged(previous, next)
  }
  // The server's answer arrives after the timer, so a release lands a few microtasks later.
  const settle = async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
  }
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run()
    await settle()
  }
  const live = () => timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)
  return { release, released, fire, settle, timers, live, busy, serverBusy, move }
}

describe("location release", () => {
  test("leaving an idle chat releases its location after the chat delay", async () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    expect(h.released).toEqual([])
    expect(h.live()).toEqual([CHAT_DELAY])
    await h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("leaving an idle worktree releases it after the longer worktree delay", async () => {
    const h = harness()
    h.move(WORKTREE)
    h.move(PROJECT)
    expect(h.live()).toEqual([WORKTREE_DELAY])
    await h.fire()
    expect(h.released).toEqual([WORKTREE])
  })

  // A user switching between projects held a full MCP set for each of them
  // until OpenCode's own hour-long sweep.
  test("leaving a project releases it after the longest delay", async () => {
    const h = harness()
    h.move(OTHER_PROJECT)
    expect(h.live()).toEqual([PROJECT_DELAY])
    await h.fire()
    expect(h.released).toEqual([PROJECT])
  })

  test("the directory the user is in is never released", async () => {
    const h = harness()
    h.move(CHAT)
    await h.fire()
    expect(h.released).toEqual([PROJECT])
  })

  test("coming back before the delay keeps the directory running", async () => {
    const h = harness()
    h.move(CHAT)
    h.move(OTHER_CHAT)
    h.move(WORKTREE)
    h.move(CHAT)
    await h.fire()
    // Only the directories just left are released; the one returned to is not.
    expect(h.released).toEqual([PROJECT, OTHER_CHAT, WORKTREE])
  })

  test("busy work is released once it settles, rechecked at the directory's own delay", async () => {
    const h = harness({ busy: new Set([WORKTREE]) })
    h.move(WORKTREE)
    h.move(PROJECT)
    await h.fire()
    expect(h.timers.map((timer) => timer.ms)).toEqual([WORKTREE_DELAY])
    await h.fire()
    expect(h.released).toEqual([])
    h.busy.delete(WORKTREE)
    await h.fire()
    expect(h.released).toEqual([WORKTREE])
  })

  test("returning to a busy directory stops looking at it", async () => {
    const h = harness({ busy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    h.move(CHAT)
    h.busy.delete(CHAT)
    await h.fire()
    expect(h.released).toEqual([PROJECT])
  })

  // The server writes a left chat's recap a minute after its answer, reading
  // the chat's directory. A release before that only starts it again.
  test("a chat waiting for its recap is released the moment the recap is written", async () => {
    const h = harness({ busy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    expect(h.released).toEqual([])
    h.busy.delete(CHAT)
    h.release.recheck((directory) => directory === CHAT)
    await h.settle()
    expect(h.released).toEqual([CHAT])
    await h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("a recap written before the chat delay leaves the delay as it was", async () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    h.release.recheck(() => true)
    await h.settle()
    expect(h.released).toEqual([])
    await h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("a recap written after the user came back releases nothing", async () => {
    const h = harness({ busy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    h.move(CHAT)
    h.busy.delete(CHAT)
    h.release.recheck(() => true)
    await h.settle()
    expect(h.released).toEqual([])
  })

  test("a directory this window cannot see is left to OpenCode, not polled", async () => {
    const h = harness({ unknown: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    expect(h.timers).toHaveLength(0)
    expect(h.released).toEqual([])
  })

  test("dispose drops every pending release and ignores later moves", async () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    h.release.dispose()
    await h.fire()
    h.move(OTHER_CHAT)
    h.move(PROJECT)
    await h.fire()
    expect(h.released).toEqual([])
  })

  // A window's own picture missed work another client started, or a subagent ran, and the release
  // cancelled it with "Interaction cancelled because the location shut down".
  test("work OpenCode still runs there holds a directory this window sees as idle", async () => {
    const h = harness({ serverBusy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    expect(h.released).toEqual([])
    expect(h.live()).toEqual([CHAT_DELAY])
    h.serverBusy.delete(CHAT)
    await h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("a server that cannot answer releases nothing and is not polled", async () => {
    const h = harness({ serverUnreadable: true })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    expect(h.released).toEqual([])
    expect(h.live()).toEqual([])
  })

  test("work the window sees start while the server answers holds the directory", async () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    for (const timer of h.timers.splice(0)) timer.run()
    h.busy.add(CHAT)
    await h.settle()
    expect(h.released).toEqual([])
    expect(h.live()).toEqual([CHAT_DELAY])
  })

  test("coming back while the server answers keeps the directory running", async () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    for (const timer of h.timers.splice(0)) timer.run()
    h.move(CHAT)
    await h.settle()
    expect(h.released).toEqual([])
  })

  test("a failed release does not surface", async () => {
    const h = harness({ failRelease: true })
    h.move(CHAT)
    h.move(PROJECT)
    await h.fire()
    await Promise.resolve()
    expect(h.released).toEqual([CHAT])
  })
})

describe("directoryUse", () => {
  const idle = { session_status: {}, permission: {}, form: {} }

  afterEach(() => {
    replaceGlobalSessionStatusById(new Map())
    resetBackgroundShells()
    resetPendingSessionAssists()
  })

  test("a directory whose state this window does not hold is unknown", () => {
    expect(directoryUse(CHAT, undefined)).toBe("unknown")
  })

  test("an idle directory is free", () => {
    expect(directoryUse(CHAT, { ...idle, session_status: { ses_1: { type: "idle" } } })).toBe("free")
  })

  test("a running session holds it, from the directory store or the global index", () => {
    expect(directoryUse(CHAT, { ...idle, session_status: { ses_1: { type: "busy" } } })).toBe("busy")
    replaceGlobalSessionStatusById(new Map([["ses_2", { status: { type: "busy" }, directory: CHAT }]]))
    expect(directoryUse(CHAT, idle)).toBe("busy")
    expect(directoryUse(OTHER_CHAT, idle)).toBe("free")
  })

  test("a recap the server is still to write holds it until the server says it is done", () => {
    const settled: boolean[] = []
    const unsubscribe = subscribeSessionAssistSettled((isSettled) => settled.push(isSettled(CHAT)))
    applySessionAssistEvent({ sessionID: "ses_1", directory: CHAT, pending: true }, () => null)
    expect(directoryUse(CHAT, idle)).toBe("busy")
    expect(directoryUse(OTHER_CHAT, idle)).toBe("free")
    // A failed or dropped assist ends the wait the same way.
    applySessionAssistEvent({ sessionID: "ses_1", directory: CHAT, pending: false }, () => null)
    expect(directoryUse(CHAT, idle)).toBe("free")
    expect(settled).toEqual([true])
    unsubscribe()
  })

  test("a wait whose end never arrives stops holding the directory", () => {
    const realNow = Date.now
    const announcedAt = realNow()
    applySessionAssistEvent({ sessionID: "ses_1", directory: CHAT, pending: true }, () => null, announcedAt)
    expect(directoryUse(CHAT, idle)).toBe("busy")
    const later = announcedAt + PENDING_ASSIST_MAX_AGE_MS + 1
    Date.now = () => later
    try {
      expect(directoryUse(CHAT, idle)).toBe("free")
    } finally {
      Date.now = realNow
    }
  })

  test("a background command holds it", () => {
    replaceDirectoryShells(CHAT, [{ id: "sh_1", sessionID: "ses_1", command: "bun dev", file: "/tmp/out", startedAt: 1 }], 0)
    expect(directoryUse(CHAT, idle)).toBe("busy")
    expect(directoryUse(OTHER_CHAT, idle)).toBe("free")
  })
})

describe("isWorktreeDirectory", () => {
  const worktree = (path: string): WorktreeMetadata => ({ source: "sdk", name: "feature", path, projectDirectory: PROJECT, branch: "feature", label: "feature" })

  test("a listed worktree is one, a project root listed among its own worktrees is not", () => {
    const byProject = new Map([[PROJECT, [worktree(PROJECT), worktree(WORKTREE)]]])
    expect(isWorktreeDirectory(WORKTREE, byProject)).toBe(true)
    expect(isWorktreeDirectory(`${WORKTREE}/`, byProject)).toBe(true)
    expect(isWorktreeDirectory(PROJECT, byProject)).toBe(false)
    expect(isWorktreeDirectory("/elsewhere", byProject)).toBe(false)
  })

  test("a sub-folder of a listed worktree is one, a sibling that only shares the name prefix is not", () => {
    const byProject = new Map([[PROJECT, [worktree(WORKTREE)]]])
    expect(isWorktreeDirectory(`${WORKTREE}/ai`, byProject)).toBe(true)
    expect(isWorktreeDirectory(`${WORKTREE}-other`, byProject)).toBe(false)
  })
})
