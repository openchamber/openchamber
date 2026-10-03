import { afterEach, describe, expect, test } from "bun:test"
import { chatDirectoryUse, createChatLocationRelease, type ChatDirectoryUse } from "../chat-location-release"
import { replaceGlobalSessionStatusById } from "../global-session-status"
import { replaceDirectoryShells, resetBackgroundShells } from "../background-shells"

// Leaving a chat directory releases its OpenCode location (and with it the
// chat's MCP servers) once nothing there still needs it.

const CHAT = "/home/u/.config/openchamber/chats/2026-10-03/session-a"
const OTHER_CHAT = "/home/u/.config/openchamber/chats/2026-10-03/session-b"
const PROJECT = "/repo/app"

type ManualTimer = { run: () => void; cleared: boolean }

function harness(options: { busy?: Set<string>; unknown?: Set<string>; failRelease?: boolean } = {}) {
  const timers: ManualTimer[] = []
  const released: string[] = []
  const busy = options.busy ?? new Set<string>()
  const unknown = options.unknown ?? new Set<string>()
  const current = { value: PROJECT }
  const release = createChatLocationRelease<ManualTimer>({
    isChatDirectory: (directory) => directory.includes("/chats/"),
    isCurrentDirectory: (directory) => directory === current.value,
    directoryUse: (directory): ChatDirectoryUse => {
      if (unknown.has(directory)) return "unknown"
      return busy.has(directory) ? "busy" : "free"
    },
    release: async (directory) => {
      released.push(directory)
      if (options.failRelease) throw new Error("404")
    },
    delayMs: 30_000,
    timers: {
      set: (run) => {
        const timer = { run, cleared: false }
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

describe("chat location release", () => {
  test("leaving an idle chat releases its location after the delay", () => {
    const h = harness()
    h.move(CHAT)
    h.move(PROJECT)
    expect(h.released).toEqual([])
    h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("a project directory is never released", () => {
    const h = harness()
    h.move(CHAT)
    h.fire()
    expect(h.released).toEqual([])
  })

  test("coming back before the delay keeps the chat running", () => {
    const h = harness()
    h.move(CHAT)
    h.move(OTHER_CHAT)
    h.move(CHAT)
    h.fire()
    // Only the chat just left is released; the one returned to is not.
    expect(h.released).toEqual([OTHER_CHAT])
  })

  test("a busy chat is released once it settles, not while it works", () => {
    const h = harness({ busy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    h.fire()
    h.fire()
    expect(h.released).toEqual([])
    h.busy.delete(CHAT)
    h.fire()
    expect(h.released).toEqual([CHAT])
  })

  test("returning to a busy chat stops looking at it", () => {
    const h = harness({ busy: new Set([CHAT]) })
    h.move(CHAT)
    h.move(PROJECT)
    h.fire()
    h.move(CHAT)
    h.busy.delete(CHAT)
    h.fire()
    expect(h.released).toEqual([])
  })

  test("a chat this window cannot see is left to OpenCode, not polled", () => {
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

describe("chatDirectoryUse", () => {
  const idle = { session_status: {}, permission: {}, form: {} }

  afterEach(() => {
    replaceGlobalSessionStatusById(new Map())
    resetBackgroundShells()
  })

  test("a directory whose state this window does not hold is unknown", () => {
    expect(chatDirectoryUse(CHAT, undefined)).toBe("unknown")
  })

  test("an idle directory is free", () => {
    expect(chatDirectoryUse(CHAT, { ...idle, session_status: { ses_1: { type: "idle" } } })).toBe("free")
  })

  test("a running session holds it, from the directory store or the global index", () => {
    expect(chatDirectoryUse(CHAT, { ...idle, session_status: { ses_1: { type: "busy" } } })).toBe("busy")
    replaceGlobalSessionStatusById(new Map([["ses_2", { status: { type: "busy" }, directory: CHAT }]]))
    expect(chatDirectoryUse(CHAT, idle)).toBe("busy")
    expect(chatDirectoryUse(OTHER_CHAT, idle)).toBe("free")
  })

  test("a background command holds it", () => {
    replaceDirectoryShells(CHAT, [{ id: "sh_1", sessionID: "ses_1", command: "bun dev", file: "/tmp/out", startedAt: 1 }], 0)
    expect(chatDirectoryUse(CHAT, idle)).toBe("busy")
    expect(chatDirectoryUse(OTHER_CHAT, idle)).toBe("free")
  })
})
