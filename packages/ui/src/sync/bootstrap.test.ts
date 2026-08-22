import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

const createSdk = (options?: { commandList?: () => Promise<{ data: unknown[] }> }) => ({
  project: { current: async () => ({ data: { id: "project-a" } }) },
  config: { get: async () => ({ data: {} }) },
  path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
  session: { status: async () => ({ data: {} }) },
  command: { list: options?.commandList ?? (async () => ({ data: [] })) },
  mcp: { status: async () => ({ data: {} }) },
  lsp: { status: async () => ({ data: [] }) },
  vcs: { get: async () => ({ data: { branch: "main" } }) },
  question: { list: async () => ({ data: [] }) },
  permission: { list: async () => ({ data: [] }) },
}) as unknown as OpencodeClient

const createState = (): State => ({
  ...INITIAL_STATE,
  message: {},
  part: {},
})

const project = { id: "project-a", worktree: "/repo" } as Project

describe("bootstrapDirectory", () => {
  test("prioritizes session loading without waiting for deferred fields", async () => {
    let state = createState()
    let deferredStarted = false
    let resolveDeferred!: () => void
    const deferred = new Promise<{ data: unknown[] }>((resolve) => {
      resolveDeferred = () => resolve({ data: [] })
    })
    let resolveSessions!: () => void
    const sessions = new Promise<void>((resolve) => {
      resolveSessions = resolve
    })
    let settled = false
    const sdk = createSdk({
      commandList: async () => {
        deferredStarted = true
        return deferred
      },
    })
    const bootstrapping = bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: () => sessions,
    }).then((result) => {
      settled = true
      return result
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(deferredStarted).toBe(false)
    resolveSessions()

    expect(await bootstrapping).toBe("complete")
    expect(state.status).toBe("complete")
    expect(deferredStarted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deferredStarted).toBe(true)
    resolveDeferred()
  })

  test("reports session-list failure without clearing existing state", async () => {
    let state = { ...createState(), session: [{ id: "cached" }] as State["session"] }
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => {
        throw new Error("unavailable")
      },
    })

    expect(result).toBe("failed")
    expect(state.session.map((session) => session.id)).toEqual(["cached"])
  })

  test("rejects stale work before committing", async () => {
    const state = createState()
    let commits = 0
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: () => {
        commits += 1
      },
      isStale: () => true,
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })

    expect(result).toBe("stale")
    expect(commits).toBe(0)
  })

  test("does not re-apply a status snapshot when the status fetch failed", async () => {
    let state = createState()
    const statusCommits: unknown[] = []
    const sdk = createSdk()
    ;(sdk.session as { status: () => Promise<unknown> }).status = async () => {
      throw new Error("status unavailable")
    }
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        if (patch.session_status) statusCommits.push(patch.session_status)
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })

    expect(result).toBe("complete")
    // A failed session.status() must never clear existing global activity with
    // an empty/initialized snapshot.
    expect(statusCommits).toEqual([])
  })

  test("re-applies a successful status snapshot after the session list loads", async () => {
    let state = createState()
    const statusCommits: unknown[] = []
    const sdk = createSdk()
    ;(sdk.session as { status: () => Promise<unknown> }).status = async () => ({ data: { "child-1": { type: "busy" } } })
    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        if (patch.session_status) statusCommits.push(patch.session_status)
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })

    // Phase 1 commits it once; the post-list re-application commits it again so
    // the global status index can learn relations from the now-loaded records.
    expect(statusCommits).toEqual([
      { "child-1": { type: "busy" } },
      { "child-1": { type: "busy" } },
    ])
  })

  test("re-application preserves live status events that arrived while the session list loaded", async () => {
    let state = createState()
    const statusCommits: unknown[] = []
    const sdk = createSdk()
    ;(sdk.session as { status: () => Promise<unknown> }).status = async () => ({ data: { "child-1": { type: "busy" } } })
    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        if (patch.session_status) statusCommits.push(patch.session_status)
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => {
        // Live events land while the authoritative session list is loading:
        // child-1 settles idle and a brand-new session becomes busy.
        state = {
          ...state,
          session_status: {
            ...state.session_status,
            "child-1": { type: "idle" },
            "live-new": { type: "busy" },
          },
        }
      },
    })

    // The re-application must carry the live view, not revert child-1 to the
    // phase-1 busy snapshot or drop the newly-busy session.
    expect(state.session_status).toEqual({
      "child-1": { type: "idle" },
      "live-new": { type: "busy" },
    })
    expect(statusCommits[statusCommits.length - 1]).toEqual({
      "child-1": { type: "idle" },
      "live-new": { type: "busy" },
    })
  })

  test("re-application does not resurrect a status entry removed by a live mutation", async () => {
    let state = createState()
    const sdk = createSdk()
    ;(sdk.session as { status: () => Promise<unknown> }).status = async () => ({
      data: { "moved-1": { type: "busy" }, "kept-1": { type: "busy" } },
    })
    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => {
        // A live move/delete removes moved-1 from this directory's status view
        // while the session list loads.
        state = { ...state, session_status: { "kept-1": { type: "busy" } } }
      },
    })

    expect(state.session_status).toEqual({ "kept-1": { type: "busy" } })
  })
})
