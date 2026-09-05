import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

type V2QuestionRequestListResponse = {
  data?: { data?: unknown };
  error?: unknown;
  response?: { status?: number };
};

type V1QuestionListFn = (args?: { directory?: string }) => Promise<{ data?: unknown[] }>;

const createSdk = (options?: {
  commandList?: () => Promise<{ data: unknown[] }>
  v2QuestionRequestList?: (args?: { location?: { directory?: string } }) => Promise<V2QuestionRequestListResponse>
  v1QuestionList?: V1QuestionListFn
}) => ({
  project: { current: async () => ({ data: { id: "project-a" } }) },
  config: { get: async () => ({ data: {} }) },
  path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
  session: { status: async () => ({ data: {} }) },
  command: { list: options?.commandList ?? (async () => ({ data: [] })) },
  mcp: { status: async () => ({ data: {} }) },
  lsp: { status: async () => ({ data: [] }) },
  vcs: { get: async () => ({ data: { branch: "main" } }) },
  question: { list: options?.v1QuestionList ?? (async () => ({ data: [] })) },
  permission: { list: async () => ({ data: [] }) },
  v2: {
    question: {
      request: { list: options?.v2QuestionRequestList ?? (async () => ({ data: { data: [] }, error: undefined })) },
    },
  },
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

  test("deferred phase reads pending questions through native V2 without calling V1", async () => {
    const state = createState()
    const v2Question = {
      id: "que_v2",
      sessionID: "ses_v2",
      questions: [
        {
          question: "Proceed with the plan?",
          header: "Build",
          options: [
            { label: "Yes", description: "Proceed" },
            { label: "No", description: "Cancel" },
          ],
        },
      ],
tool: undefined,
    }
    const v2ListArgs: Array<{ location?: { directory?: string } } | undefined> = []
    const v1ListCalls: Array<{ directory?: string } | undefined> = []
    const sdk = createSdk({
      v2QuestionRequestList: async (args) => {
        v2ListArgs.push(args)
        return { data: { data: [v2Question] }, error: undefined }
      },
      v1QuestionList: async (args) => {
        v1ListCalls.push(args)
        return { data: [] }
      },
    })

    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => Object.assign(state, patch),
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    // Deferred phase runs on a setTimeout(0); give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.question["ses_v2"]?.map((q) => q.id)).toEqual(["que_v2"])
    expect(v2ListArgs).toEqual([{ location: { directory: "/repo" } }])
    expect(v1ListCalls).toEqual([])
  })

  test("deferred phase falls back to V1 question.list on a V2 5xx failure and still merges results", async () => {
    const state = createState()
    const v1Question = {
      id: "que_v1",
      sessionID: "ses_v1",
      questions: [
        {
          question: "Pick one",
          header: "Mode",
          options: [{ label: "Fast", description: "Fast" }],
        },
      ],
    }
    const v1ListCalls: Array<{ directory?: string } | undefined> = []
    const sdk = createSdk({
      v2QuestionRequestList: async () => ({
        error: { name: "ServerError", data: { message: "boom" } },
        response: new Response(null, { status: 500 }),
      }),
      v1QuestionList: async (args) => {
        v1ListCalls.push(args)
        return { data: [v1Question] }
      },
    })

    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => Object.assign(state, patch),
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.question["ses_v1"]?.map((q) => q.id)).toEqual(["que_v1"])
    expect(v1ListCalls).toEqual([{ directory: "/repo" }])
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
