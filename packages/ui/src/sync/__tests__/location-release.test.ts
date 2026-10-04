import { afterEach, describe, expect, test } from "bun:test"
import { createLocationRelease, directoryUse, isWorktreeDirectory, type DirectoryUse } from "../location-release"
import { replaceGlobalSessionStatusById } from "../global-session-status"
import { replaceDirectoryShells, resetBackgroundShells } from "../background-shells"
import type { WorktreeMetadata } from "@/types/worktree"

// Leaving a chat or worktree directory releases its OpenCode location (and with
// it the directory's MCP servers) once nothing there still needs it.

const CHAT = "/home/u/.config/openchamber/chats/2026-10-03/session-a"
const OTHER_CHAT = "/home/u/.config/openchamber/chats/2026-10-03/session-b"
const WORKTREE = "/repo/app-worktrees/feature"
const PROJECT = "/repo/app"
const CHAT_DELAY = 30_000
const WORKTREE_DELAY = 300_000

type ManualTimer = { run: () => void; ms: number; cleared: boolean }

function harness(options: { busy?: Set<string>; unknown?: Set<string>; failRelease?: boolean } = {}) {
  const timers: ManualTimer[] = []
  const released: string[] = []
  const busy = options.busy ?? new Set<string>()
  const unknown = options.unknown ?? new Set<string>()
  const current = { value: PROJECT }
  const release = createLocationRelease<ManualTimer>({
    releaseDelayMs: (directory) => {
      if (directory.includes("/chats/")) return CHAT_DELAY
      return directory === WORKTREE ? WORKTREE_DELAY : null
    },
    isCurrentDirectory: (directory) => directory === current.value,
    directoryUse: (directory): DirectoryUse => {
      if (unknown.has(directory)) return "unknown"
      return busy.has(directory) ? "busy" : "free"
    },
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
  const fire = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run()
  }
  return { release, released, fire, timers, busy, move }
}

describe("location release", () => {
  test("leaving an idle chat releases its location after the chat delay", () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    expect(h.released).toEqual([])
    expect(h.timers.map((timer) => timer.ms)).toEqual([CHAT_DELAY])
    h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("leaving an idle worktree releases it after the longer worktree delay", () => {
    const h = harness()
    h.move(WORKTREE)
    h.move(PROJECT)
    expect(h.timers.map((timer) => timer.ms)).toEqual([WORKTREE_DELAY])
    h.fire()
    expect(h.released).toEqual([WORKTREE])
  })

  test("a project directory is never released", () => {
    const h = harness()
    h.move(CHAT)
    h.fire()
    expect(h.released).toEqual([])
  })

  test("coming back before the delay keeps the directory running", () => {
    const h = harness()
    h.move(CHAT)
    h.move(OTHER_CHAT)
    h.move(WORKTREE)
    h.move(CHAT)
    h.fire()
    // Only the directories just left are released; the one returned to is not.
    expect(h.released).toEqual([OTHER_CHAT, WORKTREE])
  })

  test("busy work is released once it settles, rechecked at the directory's own delay", () => {
    const h = harness({ busy: new Set([WORKTREE]) })
    h.move(WORKTREE)
    h.move(PROJECT)
    h.fire()
    expect(h.timers.map((timer) => timer.ms)).toEqual([WORKTREE_DELAY])
    h.fire()
    expect(h.released).toEqual([])
    h.busy.delete(WORKTREE)
    h.fire()
    expect(h.released).toEqual([WORKTREE])
  })

  test("returning to a busy directory stops looking at it", () => {
    const h = harness({ busy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    h.fire()
    h.move(CHAT)
    h.busy.delete(CHAT)
    h.fire()
    expect(h.released).toEqual([])
  })

  test("a directory this window cannot see is left to OpenCode, not polled", () => {
    const h = harness({ unknown: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    h.fire()
    expect(h.timers).toHaveLength(0)
    expect(h.released).toEqual([])
  })

  test("dispose drops every pending release and ignores later moves", () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    h.release.dispose()
    h.fire()
    h.move(OTHER_CHAT)
    h.move(PROJECT)
    h.fire()
    expect(h.released).toEqual([])
  })

  test("a failed release does not surface", async () => {
    const h = harness({ failRelease: true })
    h.move(CHAT)
    h.move(PROJECT)
    h.fire()
    await Promise.resolve()
    expect(h.released).toEqual([CHAT])
  })
})

describe("directoryUse", () => {
  const idle = { session_status: {}, permission: {}, form: {} }

  afterEach(() => {
    replaceGlobalSessionStatusById(new Map())
    resetBackgroundShells()
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
})
