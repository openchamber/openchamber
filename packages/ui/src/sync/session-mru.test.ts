import { describe, expect, test, beforeEach } from "bun:test"
import { sessionMRU } from "./session-mru"

// The module exports a singleton; reset its internal state before each test
// by driving it through its public API.
beforeEach(() => {
  sessionMRU.resetCursor()
  // Clear the stack by removing all entries we know about; tests below
  // start from a known state by recording a single seed session first.
  // The simplest reset: record null, then pop entries via cycle + removeSession.
  sessionMRU.recordActiveSession(null)
  // Drain any remaining stack entries.
  for (let i = 0; i < 60; i++) {
    const next = sessionMRU.cycle(1)
    if (!next) break
    sessionMRU.removeSession(next)
  }
  sessionMRU.recordActiveSession(null)
})

describe("sessionMRU.recordActiveSession", () => {
  test("tracks the current session without pushing it to the stack", () => {
    sessionMRU.recordActiveSession("a")
    expect(sessionMRU.getCurrentSessionId()).toBe("a")
    expect(sessionMRU.getStackSnapshot()).toEqual([])

    sessionMRU.recordActiveSession("b")
    expect(sessionMRU.getCurrentSessionId()).toBe("b")
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])
  })

  test("does not push when the same id is re-recorded", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("b")
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])
  })

  test("deduplicates: re-activating a stacked session moves it to current and removes from stack", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    // Stack: [b, a], current: c
    expect(sessionMRU.getStackSnapshot()).toEqual(["b", "a"])

    sessionMRU.recordActiveSession("a")
    // a is now current; stack should not contain a
    expect(sessionMRU.getCurrentSessionId()).toBe("a")
    expect(sessionMRU.getStackSnapshot()).toEqual(["c", "b"])
  })

  test("recording null pushes the previous session onto the stack", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession(null)
    expect(sessionMRU.getCurrentSessionId()).toBeNull()
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])
  })
})

describe("sessionMRU.cycle", () => {
  test("returns null when the stack is empty", () => {
    sessionMRU.recordActiveSession("a")
    expect(sessionMRU.cycle(1)).toBeNull()
    expect(sessionMRU.cycle(-1)).toBeNull()
  })

  test("forward cycle walks the stack in MRU order and wraps around", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    sessionMRU.recordActiveSession("d")
    // Stack (MRU first): [c, b, a], current: d

    expect(sessionMRU.cycle(1)).toBe("c")
    expect(sessionMRU.cycle(1)).toBe("b")
    expect(sessionMRU.cycle(1)).toBe("a")
    // Wraps around to the front of the snapshot.
    expect(sessionMRU.cycle(1)).toBe("c")
  })

  test("backward cycle starts at the oldest entry and wraps around", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    sessionMRU.recordActiveSession("d")
    // Stack (MRU first): [c, b, a], current: d

    expect(sessionMRU.cycle(-1)).toBe("a")
    expect(sessionMRU.cycle(-1)).toBe("b")
    expect(sessionMRU.cycle(-1)).toBe("c")
    // Wraps around to the back of the snapshot.
    expect(sessionMRU.cycle(-1)).toBe("a")
  })

  test("cycle-induced setCurrentSession calls do not mutate the real stack", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    // Stack: [a], current: b

    const target = sessionMRU.cycle(1)
    expect(target).toBe("a")
    // Simulate setCurrentSession(target) by recording it as active.
    // The cycle path detects this and avoids mutating the stack.
    sessionMRU.recordActiveSession(target!)

    // Stack should be unchanged: [a] is still in the stack snapshot for
    // continued cycling, even though currentSessionId is now "a".
    expect(sessionMRU.getCurrentSessionId()).toBe("a")
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])

    // The cycling snapshot should still be available: pressing forward again
    // wraps to the only entry.
    expect(sessionMRU.cycle(1)).toBe("a")
  })

  test("external session change (not from cycling) commits the cycle", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    // Stack: [b, a], current: c

    // Start cycling: c -> b
    expect(sessionMRU.cycle(1)).toBe("b")
    sessionMRU.recordActiveSession("b")
    // Stack unchanged: [b, a], current: b (cycle-induced, not committed)

    // External session change (e.g., user clicks a different session):
    sessionMRU.recordActiveSession("z")

    // The cycle should be committed: b (the cycle-start session) should now be
    // at the front of the stack, and z is current.
    expect(sessionMRU.getCurrentSessionId()).toBe("z")
    expect(sessionMRU.getStackSnapshot()[0]).toBe("b")
    expect(sessionMRU.getStackSnapshot()).toContain("a")
    expect(sessionMRU.isCycling()).toBe(false)
  })

  test("cursor reset by external recordActiveSession restarts the cycle from the top", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    sessionMRU.recordActiveSession("d")
    // Stack: [c, b, a], current: d

    expect(sessionMRU.cycle(1)).toBe("c")
    sessionMRU.recordActiveSession("c") // cycle-induced

    // User clicks "x" in the sidebar — external change commits cycle.
    sessionMRU.recordActiveSession("x")
    expect(sessionMRU.isCycling()).toBe(false)

    // New cycle should start fresh from the top of the real stack.
    expect(sessionMRU.cycle(1)).toBe("c")
  })
})

describe("sessionMRU.removeSession", () => {
  test("removes the session from the stack and current", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    // Stack: [b, a], current: c

    sessionMRU.removeSession("b")
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])

    sessionMRU.removeSession("c")
    expect(sessionMRU.getCurrentSessionId()).toBeNull()
  })

  test("resets an in-progress cycle when a snapshot entry is removed", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    // Stack: [b, a], current: c

    expect(sessionMRU.cycle(1)).toBe("b")
    expect(sessionMRU.isCycling()).toBe(true)

    // Remove "b" from the snapshot mid-cycle.
    sessionMRU.removeSession("b")
    expect(sessionMRU.isCycling()).toBe(false)
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])

    // Next cycle starts fresh from the new top of the stack.
    expect(sessionMRU.cycle(1)).toBe("a")
  })
})

describe("sessionMRU.resetCursor", () => {
  test("commits the cycle and clears cycling state", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    sessionMRU.recordActiveSession("c")
    // Stack: [b, a], current: c

    expect(sessionMRU.cycle(1)).toBe("b")
    sessionMRU.recordActiveSession("b") // cycle-induced switch
    sessionMRU.resetCursor()

    expect(sessionMRU.isCycling()).toBe(false)
    // After commit: b is current, c (cycle-start) is most-recent in stack.
    expect(sessionMRU.getCurrentSessionId()).toBe("b")
    expect(sessionMRU.getStackSnapshot()[0]).toBe("c")
  })
})

describe("sessionMRU.seedIfEmpty", () => {
  test("seeds the stack when empty so cycling works on fresh launch", () => {
    sessionMRU.recordActiveSession("current")
    expect(sessionMRU.getStackSnapshot()).toEqual([])

    sessionMRU.seedIfEmpty(["a", "b", "c"])
    expect(sessionMRU.getStackSnapshot()).toEqual(["a", "b", "c"])

    expect(sessionMRU.cycle(1)).toBe("a")
  })

  test("does not overwrite a non-empty stack", () => {
    sessionMRU.recordActiveSession("a")
    sessionMRU.recordActiveSession("b")
    // Stack: [a], current: b

    sessionMRU.seedIfEmpty(["x", "y", "z"])
    expect(sessionMRU.getStackSnapshot()).toEqual(["a"])
  })

  test("truncates to max size", () => {
    sessionMRU.recordActiveSession("current")
    const many = Array.from({ length: 100 }, (_, i) => `s${i}`)
    sessionMRU.seedIfEmpty(many)
    expect(sessionMRU.getStackSnapshot().length).toBe(50)
  })
})

describe("keyboard handler stale-skip simulation", () => {
  test("cycle skips stale entries and lands on the first live one", () => {
    sessionMRU.recordActiveSession("current")
    sessionMRU.seedIfEmpty(["stale1", "live", "stale2"])

    // Simulate what useKeyboardShortcuts does: cycle, check if stale, remove + retry
    let target: string | null = null
    const liveSessions = new Set(["live", "current"])
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = sessionMRU.cycle(1)
      if (!candidate) break
      if (!liveSessions.has(candidate)) {
        sessionMRU.removeSession(candidate)
        continue
      }
      target = candidate
      break
    }

    expect(target).toBe("live")
  })

  test("returns null when all stacked sessions are stale", () => {
    sessionMRU.recordActiveSession("current")
    sessionMRU.seedIfEmpty(["stale1", "stale2"])

    let target: string | null = null
    const liveSessions = new Set(["current"])
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = sessionMRU.cycle(1)
      if (!candidate) break
      if (!liveSessions.has(candidate)) {
        sessionMRU.removeSession(candidate)
        continue
      }
      target = candidate
      break
    }

    expect(target).toBeNull()
  })
})
