import { describe, expect, test, beforeEach, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Event, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"

const listPendingQuestionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const listPendingPermissionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const todoPersistWrites: Array<{ directory: string; sessionID: string; todos: unknown }> = []
let pendingQuestionsResponse: QuestionRequest[] = []
let pendingPermissionsResponse: PermissionRequest[] = []
let pendingQuestionsShouldThrow = false
let pendingPermissionsShouldThrow = false

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingQuestions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingQuestionsCalls.push(opts ?? {})
      if (pendingQuestionsShouldThrow) throw new Error("question.list failed: simulated")
      return pendingQuestionsResponse
    }),
    listPendingPermissions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingPermissionsCalls.push(opts ?? {})
      if (pendingPermissionsShouldThrow) throw new Error("permission.list failed: simulated")
      return pendingPermissionsResponse
    }),
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({ isSessionAutoAccepting: () => false }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: {
    getState: () => ({
      setSessionTodos: (directory: string, sessionID: string, todos: unknown) => {
        todoPersistWrites.push({ directory, sessionID, todos })
      },
    }),
  },
}))

mock.module("sonner", () => ({
  toast: {
    dismiss: () => undefined,
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

import { INITIAL_STATE, type State } from "../types"
import { ChildStoreManager, type DirectoryStore } from "../child-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
const {
  createEventRoutingIndex,
  handleEvent,
  resyncBlockingRequestsForActiveDirectory,
  resyncBlockingRequestsForDirectory,
  setActiveSession,
} = await import("../sync-context")

function buildQuestion(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_a",
    questions: [{ question: "Continue?", header: "Q", options: [{ label: "Yes", description: "" }] }],
    ...overrides,
  } as QuestionRequest
}

function buildPermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_a",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  } as PermissionRequest
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

describe("resyncBlockingRequestsForDirectory", () => {
  beforeEach(() => {
    listPendingQuestionsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []
    pendingQuestionsShouldThrow = false
    pendingPermissionsShouldThrow = false
    todoPersistWrites.length = 0
    setActiveSession("", "")
  })

  test("calls listPendingQuestions and listPendingPermissions exactly once for the directory", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(listPendingQuestionsCalls).toHaveLength(1)
    expect(listPendingQuestionsCalls[0]).toEqual({ directories: ["/repo"] })
    expect(listPendingPermissionsCalls).toHaveLength(1)
    expect(listPendingPermissionsCalls[0]).toEqual({ directories: ["/repo"] })
  })

  test("resume recovery refreshes blocking requests only for the active materialized directory", async () => {
    const childStores = new ChildStoreManager()
    childStores.ensureChild("/resume-active", { bootstrap: false }).setState({
      session: [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    })
    childStores.ensureChild("/resume-inactive", { bootstrap: false }).setState({
      session: [{ id: "ses_b", title: "ses_b", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    })
    pendingQuestionsResponse = [buildQuestion()]

    await resyncBlockingRequestsForActiveDirectory("/resume-active", childStores)

    expect(listPendingQuestionsCalls).toEqual([{ directories: ["/resume-active"] }])
    expect(listPendingPermissionsCalls).toEqual([{ directories: ["/resume-active"] }])
    expect(childStores.getChild("/resume-active")?.getState().question.ses_a?.[0]?.id).toBe("que_1")
    expect(childStores.getChild("/resume-inactive")?.getState().question.ses_b).toBe(undefined)
  })

  test("resume recovery does not materialize or fetch an unopened directory", async () => {
    const childStores = new ChildStoreManager()

    await resyncBlockingRequestsForActiveDirectory("/unopened", childStores)

    expect(childStores.getChild("/unopened")).toBe(undefined)
    expect(listPendingQuestionsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  test("merges newly fetched questions/permissions into the directory store", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_1")
  })

  test("preserves an in-flight SSE-delivered question whose signature changed during the fetch", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_initial" }] },
    })
    pendingQuestionsResponse = []

    const promise = resyncBlockingRequestsForDirectory("/repo", store)
    store.setState({
      question: { ses_a: [{ ...buildQuestion(), id: "que_sse_arrived" }] },
    })
    await promise

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_sse_arrived")
  })

  test("clears stale entries when API returns no pending requests and signature unchanged", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_stale" }] },
    })
    pendingQuestionsResponse = []
    pendingPermissionsResponse = []

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toEqual(undefined)
  })

  test("ignores questions for sessions the directory does not know about", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [{ ...buildQuestion(), sessionID: "ses_unknown" }]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_unknown"]).toEqual(undefined)
  })

  test("returns early without fetching when no candidate sessions are known", async () => {
    const store = createDirectoryStore({ session: [] })
    await resyncBlockingRequestsForDirectory("/repo", store)
    expect(listPendingQuestionsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  test("recovers an explicit session candidate before directory bootstrap materializes it", async () => {
    const store = createDirectoryStore({ session: [] })
    pendingQuestionsResponse = [buildQuestion()]

    await resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"], { includePermissions: false })

    expect(listPendingQuestionsCalls).toEqual([{ directories: ["/repo"] }])
    expect(listPendingPermissionsCalls).toHaveLength(0)
    expect(store.getState().question.ses_a?.[0]?.id).toBe("que_1")
  })

  test("limits explicit question-only recovery to the requested session", async () => {
    const store = createDirectoryStore({
      session: [
        { id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" },
        { id: "ses_b", title: "ses_b", time: { created: 1, updated: 1 }, version: "1" },
      ] as State["session"],
    })
    pendingQuestionsResponse = [
      buildQuestion(),
      buildQuestion({ id: "que_b", sessionID: "ses_b" }),
    ]

    await resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"], { includePermissions: false })

    expect(store.getState().question.ses_a?.[0]?.id).toBe("que_1")
    expect(store.getState().question.ses_b).toBe(undefined)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  // Regression: prior to the fix, listPendingQuestions silently returned [] on
  // fetch failure, indistinguishable from a successful empty server response.
  // The resync then walked the candidate set and deleted any question that
  // wasn't in the (empty) result — wiping legitimate in-flight prompts on a
  // transient network blip. The client method now throws on failure and the
  // outer try/catch preserves existing state.
  test("preserves existing questions when listPendingQuestions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      question: { ses_a: [{ ...buildQuestion(), id: "que_in_flight" }] },
    })
    pendingQuestionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_in_flight")
  })

  test("preserves existing permissions when listPendingPermissions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      permission: { ses_a: [{ ...buildPermission(), id: "perm_in_flight" }] },
    })
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_in_flight")
  })

  test("permission fetch failure does not block question resync (and vice versa)", async () => {
    const store = createDirectoryStore({})
    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    // Question block ran successfully despite permission block failing.
    expect(store.getState().question["ses_a"]).toHaveLength(1)
    expect(store.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(listPendingPermissionsCalls).toHaveLength(1)
  })

  test("routes a directory-less todo snapshot to its active session during a multi-store routing-index gap", () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/target", { bootstrap: false })
    childStores.ensureChild("/other", { bootstrap: false })
    const todos = [
      { content: "Finish plan", status: "completed", priority: "high" },
      { content: "Implement changes", status: "in_progress", priority: "high" },
    ]
    const event = {
      type: "todo.updated",
      properties: { sessionID: "ses_a", todos },
    } as Event
    const routingIndex = createEventRoutingIndex()

    expect(childStores.children.size).toBe(2)
    expect(routingIndex.sessionDirectoryById.size).toBe(0)
    for (const candidate of childStores.children.values()) {
      const state = candidate.getState()
      expect(state.session).toEqual([])
      expect(state.message.ses_a).toBe(undefined)
      expect(state.session_status.ses_a).toBe(undefined)
    }

    let storeWrites = 0
    const unsubscribe = store.subscribe(() => {
      storeWrites += 1
    })
    setActiveSession("/target", "ses_a")
    handleEvent("global", event, childStores, routingIndex, getRuntimeKey())

    expect(store.getState().todo.ses_a).toEqual(todos)
    expect(todoPersistWrites).toEqual([{ directory: "/target", sessionID: "ses_a", todos }])
    expect(storeWrites).toBe(1)

    const stateAfterFirstSnapshot = store.getState()
    const duplicateTodos = todos.map((todo) => ({ ...todo }))
    const duplicateEvent = {
      type: "todo.updated",
      properties: { sessionID: "ses_a", todos: duplicateTodos },
    } as Event
    expect(duplicateTodos).not.toBe(todos)
    expect(duplicateTodos).toEqual(todos)

    handleEvent("global", duplicateEvent, childStores, routingIndex, getRuntimeKey())

    expect(store.getState()).toBe(stateAfterFirstSnapshot)
    expect(todoPersistWrites).toEqual([{ directory: "/target", sessionID: "ses_a", todos }])
    expect(storeWrites).toBe(1)
    unsubscribe()
    childStores.disposeAll()
  })
})
