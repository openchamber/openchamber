import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

const createSdk = (options?: {
  commandList?: () => Promise<{ data: unknown[] }>
  vcsGet?: (input?: unknown) => Promise<{ data: { branch: string; default_branch?: string } }>
}) => ({
  project: { current: async () => ({ data: { id: "project-a" } }) },
  config: { get: async () => ({ data: {} }) },
  path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
  session: { status: async () => ({ data: {} }) },
  command: { list: options?.commandList ?? (async () => ({ data: [] })) },
  mcp: { status: async () => ({ data: {} }) },
  lsp: { status: async () => ({ data: [] }) },
  vcs: { get: options?.vcsGet ?? (async () => ({ data: { branch: "main" } })) },
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
  test("scopes VCS metadata to the bootstrapped directory", async () => {
    let state = createState()
    const requests: unknown[] = []
    await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk({
        vcsGet: async (input) => {
          requests.push(input)
          return { data: { branch: "feature", default_branch: "main" } }
        },
      }),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requests).toEqual([{ directory: "/repo" }])
    expect(state.vcs).toEqual({ branch: "feature", default_branch: "main" })
    expect(state.vcs_status).toBe("complete")
  })

  test("preserves authoritative VCS metadata while rebootstrap refreshes it", async () => {
    let state: State = {
      ...createState(),
      status: "complete",
      vcs: { branch: "feature", default_branch: "main" },
      vcs_status: "complete",
    }
    let resolveSessions!: () => void
    const sessions = new Promise<void>((resolve) => {
      resolveSessions = resolve
    })
    const bootstrapping = bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: () => sessions,
    })

    expect(state.vcs_status).toBe("complete")
    expect(state.vcs).toEqual({ branch: "feature", default_branch: "main" })

    resolveSessions()
    expect(await bootstrapping).toBe("complete")
  })

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
