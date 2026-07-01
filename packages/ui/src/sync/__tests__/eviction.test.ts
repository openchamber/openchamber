import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import {
  canDisposeDirectory,
  hasPendingBlockingRequests,
  pickDirectoriesToEvict,
} from "../eviction"
import { dropSessionCaches, getProtectedSessionCacheIds, pickSessionCacheEvictions } from "../session-cache"
import { INITIAL_STATE, type DirState, type State } from "../types"

const DAY_MS = 24 * 60 * 60 * 1000

function buildState(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    question: {},
    permission: {},
    ...overrides,
  }
}

function buildQuestion(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_1",
    questions: [{ question: "Continue?", header: "Q", options: [{ label: "Yes", description: "" }] }],
    ...overrides,
  } as QuestionRequest
}

function buildPermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  } as PermissionRequest
}

describe("hasPendingBlockingRequests", () => {
  test("returns false on undefined or empty state", () => {
    expect(hasPendingBlockingRequests(undefined)).toBe(false)
    expect(hasPendingBlockingRequests(buildState())).toBe(false)
  })

  test("returns true when at least one session has a pending question", () => {
    const state = buildState({ question: { ses_a: [buildQuestion()] } })
    expect(hasPendingBlockingRequests(state)).toBe(true)
  })

  test("returns true when at least one session has a pending permission", () => {
    const state = buildState({ permission: { ses_a: [buildPermission()] } })
    expect(hasPendingBlockingRequests(state)).toBe(true)
  })

  test("treats empty arrays under a session key as no pending work", () => {
    const state = buildState({ question: { ses_a: [] }, permission: { ses_b: [] } })
    expect(hasPendingBlockingRequests(state)).toBe(false)
  })
})

describe("pickDirectoriesToEvict", () => {
  test("does not evict an idle directory that has a pending question", () => {
    const stores = ["/idle-with-question", "/idle-empty"]
    const state = new Map<string, DirState>([
      ["/idle-with-question", { lastAccessAt: 0 }],
      ["/idle-empty", { lastAccessAt: 0 }],
    ])
    const list = pickDirectoriesToEvict({
      stores,
      state,
      pins: new Set(),
      max: 30,
      ttl: 1000,
      now: DAY_MS,
      hasPendingBlockingRequests: (dir) => dir === "/idle-with-question",
    })
    expect(list).toEqual(["/idle-empty"])
  })

  test("never includes a directory with pending blocking requests even under overflow pressure", () => {
    const stores = ["/active", "/overflow-with-permission", "/old-empty"]
    const state = new Map<string, DirState>([
      ["/active", { lastAccessAt: DAY_MS }],
      ["/overflow-with-permission", { lastAccessAt: DAY_MS - 100_000 }],
      ["/old-empty", { lastAccessAt: 0 }],
    ])
    const list = pickDirectoriesToEvict({
      stores,
      state,
      pins: new Set(),
      max: 1,
      ttl: 60_000,
      now: DAY_MS,
      hasPendingBlockingRequests: (dir) => dir === "/overflow-with-permission",
    })
    expect(list).not.toContain("/overflow-with-permission")
    expect(list).toContain("/old-empty")
  })

  test("falls back to legacy behavior when no predicate is provided", () => {
    const stores = ["/idle"]
    const state = new Map<string, DirState>([["/idle", { lastAccessAt: 0 }]])
    const list = pickDirectoriesToEvict({
      stores,
      state,
      pins: new Set(),
      max: 30,
      ttl: 1000,
      now: DAY_MS,
    })
    expect(list).toEqual(["/idle"])
  })
})

describe("canDisposeDirectory", () => {
  const baseInput = {
    directory: "/repo",
    hasStore: true,
    pinned: false,
    booting: false,
    loadingSessions: false,
    hasPendingBlockingRequests: false,
  }

  test("refuses to dispose a directory holding pending blocking requests", () => {
    expect(canDisposeDirectory({ ...baseInput, hasPendingBlockingRequests: true })).toBe(false)
  })

  test("permits disposal when no blocking requests are pending", () => {
    expect(canDisposeDirectory(baseInput)).toBe(true)
  })
})

describe("session cache eviction", () => {
  test("protects live and blocking sessions from per-directory cache eviction", () => {
    const protectedIds = getProtectedSessionCacheIds({
      session_status: {
        ses_busy: { type: "busy" },
        ses_idle: { type: "idle" },
      },
      session_diff: {},
      todo: {},
      message: {
        ses_streaming: [{ id: "msg_1", role: "assistant", time: { created: 1 } } as Message],
      },
      part: {},
      permission: {
        ses_permission: [buildPermission({ sessionID: "ses_permission" })],
      },
      question: {
        ses_question: [buildQuestion({ sessionID: "ses_question" })],
      },
    })

    expect(protectedIds).toEqual(new Set(["ses_busy", "ses_streaming", "ses_permission", "ses_question"]))

    const seen = new Set(["ses_old", "ses_busy", "ses_permission", "ses_question", "ses_streaming", "ses_current"])
    const evicted = pickSessionCacheEvictions({
      seen,
      keep: "ses_current",
      preserve: protectedIds,
      limit: 2,
    })

    expect(evicted).toEqual(["ses_old"])
    expect(seen.has("ses_busy")).toBe(true)
    expect(seen.has("ses_permission")).toBe(true)
    expect(seen.has("ses_question")).toBe(true)
    expect(seen.has("ses_streaming")).toBe(true)
  })

  test("drops parts for evicted messages without part session ids", () => {
    const store = buildState({
      message: {
        ses_old: [{ id: "msg_1", role: "user", time: { created: 1 } } as Message],
      },
      part: {
        msg_1: [{ id: "prt_1", messageID: "msg_1" } as Part],
      },
    })

    dropSessionCaches(store, ["ses_old"])

    expect(store.message.ses_old).toBe(undefined)
    expect(store.part.msg_1).toBe(undefined)
  })
})
