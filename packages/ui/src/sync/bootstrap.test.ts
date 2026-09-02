import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory, bootstrapGlobal } from "./bootstrap"
import { type GlobalState, INITIAL_STATE, type State } from "./types"

const createSdk = (options?: {
  commandList?: () => Promise<{ data: unknown[] }>
  recordCall?: (endpoint: string) => void
}) => ({
  project: {
    current: async () => ({ data: { id: "project-a" } }),
    list: async () => {
      options?.recordCall?.("project.list")
      return { data: [project] }
    },
  },
  config: { get: async () => ({ data: {} }) },
  global: {
    config: {
      get: async () => {
        options?.recordCall?.("global.config.get")
        return { data: {} }
      },
    },
  },
  path: {
    get: async () => {
      options?.recordCall?.("path.get")
      return { data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }
    },
  },
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

describe("bootstrapGlobal", () => {
  test("never enumerates projects while the visible directory is still loading", async () => {
    const calls: string[] = []
    const patches: Array<Partial<GlobalState>> = []

    await bootstrapGlobal(
      createSdk({ recordCall: (endpoint) => calls.push(endpoint) }),
      (patch) => patches.push(patch),
    )

    expect(calls.sort()).toEqual(["global.config.get", "path.get"])
    expect(patches.at(-1)).toEqual({ ready: true, error: undefined })
  })
})

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
})
