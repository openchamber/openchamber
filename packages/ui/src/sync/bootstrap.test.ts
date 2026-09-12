import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

const createSdk = (options?: {
  commandList?: () => Promise<{ data: unknown[] }>
  sessionStatus?: () => Promise<{ data: State['session_status'] }>
  questionList?: () => Promise<{ data?: unknown[]; error?: unknown; response?: { status?: number } }>
}) => ({
  project: { current: async () => ({ data: { id: "project-a" } }) },
  config: { get: async () => ({ data: {} }) },
  path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
  session: { status: options?.sessionStatus ?? (async () => ({ data: {} })) },
  command: { list: options?.commandList ?? (async () => ({ data: [] })) },
  mcp: { status: async () => ({ data: {} }) },
  lsp: { status: async () => ({ data: [] }) },
  vcs: { get: async () => ({ data: { branch: "main" } }) },
  question: { list: options?.questionList ?? (async () => ({ data: [] })) },
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
    expect(state.sessionStatusReady).toBe(true)
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

  test("a failed status request cannot grant idle authority even when bootstrap completes", async () => {
    let state = createState()
    const result = await bootstrapDirectory({
      directory: '/repo',
      sdk: createSdk({ sessionStatus: async () => { throw new Error('status unavailable') } }),
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    expect(result).toBe('complete')
    expect(state.sessionStatusReady).toBe(undefined)
  })

  test("deferred phase merges fetched questions by session, replacing the pre-fetch record", async () => {
    let state = createState()
    const preExisting: QuestionRequest = { id: "que_1", sessionID: "ses_1", questions: [] }
    const fetched: QuestionRequest[] = [
      { id: "que_2", sessionID: "ses_1", questions: [] },
      {
        id: "que_1",
        sessionID: "ses_1",
        questions: [{ question: "updated?", header: "Build", options: [{ label: "Yes", description: "Go" }] }],
      },
    ]
    state = { ...state, question: { ses_1: [preExisting] } }
    const sdk = createSdk({ questionList: async () => ({ data: fetched }) })

    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    // Deferred phase runs on a setTimeout(0); give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The fetched (sorted) records replace the pre-fetch snapshot entirely.
    expect(state.question["ses_1"]?.map((q) => q.id)).toEqual(["que_1", "que_2"])
    expect(state.question["ses_1"]?.[0]?.questions).toEqual(fetched[1].questions)
  })

  test("deferred phase deletes a session's questions when they disappear and the signature is unchanged", async () => {
    let state = createState()
    const que1: QuestionRequest = { id: "que_1", sessionID: "ses_1", questions: [] }
    const que3: QuestionRequest = { id: "que_3", sessionID: "ses_2", questions: [] }
    state = {
      ...state,
      question: {
        ses_1: [que1],
        ses_2: [que3],
      },
    }
    const sdk = createSdk({ questionList: async () => ({ data: [] }) })

    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Both sessions vanished from the fetched list and nothing changed in
    // between, so the signature guard allows the delete.
    expect(state.question).toEqual({})
  })

  test("deferred phase preserves in-flight question changes when the signature changed (stale guard)", async () => {
    let state = createState()
    const que1: QuestionRequest = { id: "que_1", sessionID: "ses_1", questions: [] }
    const que2: QuestionRequest = { id: "que_2", sessionID: "ses_1", questions: [] }
    state = { ...state, question: { ses_1: [que1] } }
    const sdk = createSdk({
      questionList: async () => {
        // Simulate an event landing while the deferred fetch is in flight:
        // the session gains a second question before the fetch resolves.
        state = { ...state, question: { ...state.question, ses_1: [que1, que2] } }
        return { data: [] }
      },
    })

    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The fetched list is empty, but the in-flight change altered the
    // signature, so the disappearance must NOT be treated as authoritative.
    expect(state.question["ses_1"]?.map((q) => q.id)).toEqual(["que_1", "que_2"])
  })

  test("deferred phase retries a transient question.list failure and still merges", async () => {
    let state = createState()
    const que1: QuestionRequest = { id: "que_1", sessionID: "ses_1", questions: [] }
    let calls = 0
    let resolveSecondCall!: () => void
    const secondCall = new Promise<void>((resolve) => { resolveSecondCall = resolve })
    const sdk = createSdk({
      questionList: async () => {
        calls += 1
        if (calls === 1) {
          return { error: { name: "ServerError", data: { message: "boom" } }, response: new Response(null, { status: 500 }) }
        }
        resolveSecondCall()
        return { data: [que1] }
      },
    })

    await bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    // retry() backs off 500ms before the second attempt; wait for it.
    await secondCall
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(state.question["ses_1"]?.map((q) => q.id)).toEqual(["que_1"])
  })
})
