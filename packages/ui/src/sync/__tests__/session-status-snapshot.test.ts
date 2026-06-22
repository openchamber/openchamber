import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import {
  applySessionStatusSnapshot,
  needsSnapshotAfterStatusPoll,
  shouldUseDisconnectedTransportPhase,
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

describe("shouldUseDisconnectedTransportPhase", () => {
  test("returns true for auth-like terminal disconnect reasons", () => {
    expect(shouldUseDisconnectedTransportPhase("ws_auth_token_unavailable")).toBe(true)
    expect(shouldUseDisconnectedTransportPhase("401")).toBe(true)
    expect(shouldUseDisconnectedTransportPhase("forbidden")).toBe(true)
  })

  test("returns true when websocket closes before ready", () => {
    expect(shouldUseDisconnectedTransportPhase("ws_closed_before_ready")).toBe(true)
  })

  test("returns false for transient reconnect reasons", () => {
    expect(shouldUseDisconnectedTransportPhase("ws_closed:code=1006")).toBe(false)
    expect(shouldUseDisconnectedTransportPhase("ws_heartbeat_timeout")).toBe(false)
    expect(shouldUseDisconnectedTransportPhase(null)).toBe(false)
  })
})
