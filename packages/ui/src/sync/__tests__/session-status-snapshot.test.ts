import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Session } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import {
  applySessionStatusSnapshot,
  getSessionWatchdogFreshnessAt,
  getSessionWatchdogFreshnessLineage,
  needsSnapshotAfterStatusPoll,
} from "../sync-context"

type StatusSnapshot = Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function streamingMessage() {
  // Trailing assistant message with no `time.completed` → actively streaming.
  return [{ id: "msg_1", role: "assistant", time: { created: 1 } }] as unknown as State["message"][string]
}

function completedMessage() {
  return [{ id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } }] as unknown as State["message"][string]
}

const BUSY: SessionStatus = { type: "busy" }

describe("applySessionStatusSnapshot", () => {
  describe("monotonic mode (periodic poll)", () => {
    test("does NOT lower a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "monotonic")
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("does NOT lower a busy session even when the snapshot reports it idle", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      applySessionStatusSnapshot(store, { ses_a: { type: "idle" } }, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("raises an idle/unknown session to busy when the snapshot reports it active (missed event)", () => {
      const store = createDirectoryStore({ session_status: {} })
      const changed = applySessionStatusSnapshot(store, { ses_a: { type: "busy" } }, ["ses_a"], "monotonic")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("seeds freshness when the snapshot reports an active session", () => {
      const store = createDirectoryStore({ session_status: {} })
      const freshness: string[] = []

      applySessionStatusSnapshot(
        store,
        { ses_a: { type: "busy" } },
        ["ses_a"],
        "monotonic",
        (sessionId) => freshness.push(sessionId),
      )

      expect(freshness).toEqual(["ses_a"])
    })

    test("updates busy → retry from the snapshot", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const retry: SessionStatus = { type: "retry", attempt: 2, message: "x", next: 30 }
      applySessionStatusSnapshot(store, { ses_a: { type: "retry", attempt: 2, message: "x", next: 30 } }, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual(retry)
    })
  })

  describe("authoritative mode (reconnect / escalated resync)", () => {
    test("lowers a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: completedMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("snapshot is the source of truth: lowers to idle even if the trailing message looks unfinished", () => {
      // The live /session/status snapshot wins over derived message state — a
      // stale/lost message.updated must never pin a session busy after the
      // server says idle. (Recovery from a missed idle event.)
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: streamingMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })
  })
})

describe("needsSnapshotAfterStatusPoll", () => {
  test("escalates when the store says busy but the snapshot omits it", () => {
    const store = createDirectoryStore({
      session_status: { ses_a: BUSY },
      message: { ses_a: completedMessage() },
    })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)
  })

  test("escalates regardless of a still-streaming trailing message (snapshot drives recovery)", () => {
    const store = createDirectoryStore({
      session_status: { ses_a: BUSY },
      message: { ses_a: streamingMessage() },
    })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)
  })

  test("does NOT escalate when the snapshot confirms the session is active", () => {
    const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", { type: "busy" })).toBe(false)
  })

  test("does NOT escalate when the store already considers the session idle", () => {
    const store = createDirectoryStore({ session_status: {} })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(false)
  })
})

describe("getSessionWatchdogFreshnessAt", () => {
  test("prefers a session-scoped timestamp over unrelated directory activity in the same directory", () => {
    const freshnessBySessionByDirectory = new Map<string, Map<string, number>>([
      ["dir_a", new Map<string, number>([["ses_a", 1_000]])],
    ])
    const freshnessByDirectory = new Map<string, number>([["dir_a", 9_000]])

    expect(
      getSessionWatchdogFreshnessAt("dir_a", "ses_a", freshnessBySessionByDirectory, freshnessByDirectory),
    ).toBe(1_000)
  })

  test("falls back to directory freshness until a session has its own timestamp", () => {
    const freshnessBySessionByDirectory = new Map<string, Map<string, number>>()
    const freshnessByDirectory = new Map<string, number>([["dir_a", 9_000]])

    expect(
      getSessionWatchdogFreshnessAt("dir_a", "ses_a", freshnessBySessionByDirectory, freshnessByDirectory),
    ).toBe(9_000)
  })
})

describe("getSessionWatchdogFreshnessLineage", () => {
  test("includes ancestor sessions for delegated child activity", () => {
    const sessions = new Map<string, Session>([
      ["child", { id: "child", parentID: "parent" } as Session],
      ["parent", { id: "parent", parentID: "root" } as Session],
      ["root", { id: "root" } as Session],
    ])

    const lineage = getSessionWatchdogFreshnessLineage("dir_a", "child", (_directory, sessionId) => sessions.get(sessionId))

    expect(lineage).toEqual(["child", "parent", "root"])
  })
})
