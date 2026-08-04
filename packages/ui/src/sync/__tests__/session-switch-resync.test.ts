import { describe, expect, test, beforeEach, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"

const listPendingQuestionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const listPendingPermissionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
let pendingQuestionsResponse: QuestionRequest[] = []
let pendingPermissionsResponse: PermissionRequest[] = []
let pendingQuestionsShouldThrow = false
let pendingPermissionsShouldThrow = false
let pendingQuestionsDeferred: Promise<QuestionRequest[]> | null = null
let pendingPermissionsDeferred: Promise<PermissionRequest[]> | null = null

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingQuestions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingQuestionsCalls.push(opts ?? {})
      if (pendingQuestionsShouldThrow) throw new Error("question.list failed: simulated")
      if (pendingQuestionsDeferred) return pendingQuestionsDeferred
      return pendingQuestionsResponse
    }),
    listPendingPermissions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingPermissionsCalls.push(opts ?? {})
      if (pendingPermissionsShouldThrow) throw new Error("permission.list failed: simulated")
      if (pendingPermissionsDeferred) return pendingPermissionsDeferred
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
  useTodosPersistStore: { getState: () => ({}) },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

import { INITIAL_STATE, type State } from "../types"
import { ChildStoreManager, type DirectoryStore } from "../child-store"
import { resyncBlockingRequestsForDirectory } from "../sync-context"
import { createActiveSessionBlockingRequestRevalidator } from "../../hooks/useActiveSessionBootstrapDemand"

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

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
    pendingQuestionsDeferred = null
    pendingPermissionsDeferred = null
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

  test("rehydrates missed blocking requests for a selected session in an already-complete directory", async () => {
    const manager = new ChildStoreManager()
    const cleanup = manager.configure({
      onBootstrap: async ({ directory }) => {
        manager.getChild(directory)?.setState({
          status: "complete",
          session: [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
        })
      },
    })
    manager.requestBootstrap({ directory: "/repo", priority: "selected", reason: "selected-session" })
    await settle()
    expect(manager.getBootstrapState("/repo")).toBe("complete")

    pendingQuestionsResponse = [buildQuestion()]
    pendingPermissionsResponse = [buildPermission()]
    const dispose = createActiveSessionBlockingRequestRevalidator({
      childStores: manager,
      directory: "/repo",
      sessionId: "ses_a",
    })
    await settle()

    const store = manager.getChild("/repo")
    expect(store?.getState().question["ses_a"]?.[0]?.id).toBe("que_1")
    expect(store?.getState().permission["ses_a"]?.[0]?.id).toBe("perm_1")

    dispose()
    cleanup()
    manager.disposeAll()
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

  test("stale non-empty question response cannot overwrite an SSE addition", async () => {
    const initialQuestion = buildQuestion({ id: "que_initial" })
    const addedQuestion = buildQuestion({ id: "que_sse_added" })
    const store = createDirectoryStore({
      question: { ses_a: [initialQuestion] },
    })
    let resolveQuestions: ((questions: QuestionRequest[]) => void) | undefined
    pendingQuestionsDeferred = new Promise((resolve) => {
      resolveQuestions = resolve
    })

    const promise = resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"])
    await settle()
    expect(listPendingQuestionsCalls).toHaveLength(1)
    store.setState({
      question: { ses_a: [initialQuestion, addedQuestion] },
    })
    resolveQuestions?.([initialQuestion])
    await promise

    expect(store.getState().question["ses_a"]?.map((item) => item.id)).toEqual([
      "que_initial",
      "que_sse_added",
    ])
  })

  test("stale non-empty permission response cannot overwrite an SSE addition", async () => {
    const initialPermission = buildPermission({ id: "perm_initial" })
    const addedPermission = buildPermission({ id: "perm_sse_added" })
    const store = createDirectoryStore({
      permission: { ses_a: [initialPermission] },
    })
    let resolvePermissions: ((permissions: PermissionRequest[]) => void) | undefined
    pendingPermissionsDeferred = new Promise((resolve) => {
      resolvePermissions = resolve
    })

    const promise = resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"])
    await settle()
    expect(listPendingPermissionsCalls).toHaveLength(1)
    store.setState({
      permission: { ses_a: [initialPermission, addedPermission] },
    })
    resolvePermissions?.([initialPermission])
    await promise

    expect(store.getState().permission["ses_a"]?.map((item) => item.id)).toEqual([
      "perm_initial",
      "perm_sse_added",
    ])
  })

  test("stale non-empty question response cannot resurrect an SSE-resolved request", async () => {
    const resolvedQuestion = buildQuestion({ id: "que_resolved" })
    const store = createDirectoryStore({
      question: { ses_a: [resolvedQuestion] },
    })
    let resolveQuestions: ((questions: QuestionRequest[]) => void) | undefined
    pendingQuestionsDeferred = new Promise((resolve) => {
      resolveQuestions = resolve
    })

    const promise = resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"])
    await settle()
    expect(listPendingQuestionsCalls).toHaveLength(1)
    store.setState({ question: {} })
    resolveQuestions?.([resolvedQuestion])
    await promise

    expect(store.getState().question["ses_a"]).toBe(undefined)
  })

  test("stale non-empty permission response cannot resurrect an SSE-resolved request", async () => {
    const resolvedPermission = buildPermission({ id: "perm_resolved" })
    const store = createDirectoryStore({
      permission: { ses_a: [resolvedPermission] },
    })
    let resolvePermissions: ((permissions: PermissionRequest[]) => void) | undefined
    pendingPermissionsDeferred = new Promise((resolve) => {
      resolvePermissions = resolve
    })

    const promise = resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"])
    await settle()
    expect(listPendingPermissionsCalls).toHaveLength(1)
    store.setState({ permission: {} })
    resolvePermissions?.([resolvedPermission])
    await promise

    expect(store.getState().permission["ses_a"]).toBe(undefined)
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

  test("hydrates an explicit selected candidate before the child session index catches up", async () => {
    const store = createDirectoryStore({ session: [] })
    pendingQuestionsResponse = [buildQuestion({ sessionID: "ses_selected" })]
    pendingPermissionsResponse = [buildPermission({ sessionID: "ses_selected" })]

    await resyncBlockingRequestsForDirectory("/repo", store, ["ses_selected"])

    expect(store.getState().question["ses_selected"]?.[0]?.id).toBe("que_1")
    expect(store.getState().permission["ses_selected"]?.[0]?.id).toBe("perm_1")
  })

  test("limits explicit selected-session cleanup to the supplied candidate", async () => {
    const store = createDirectoryStore({
      session: [],
      question: {
        ses_selected: [{ ...buildQuestion(), sessionID: "ses_selected", id: "que_stale" }],
        ses_unrelated: [{ ...buildQuestion(), sessionID: "ses_unrelated", id: "que_keep" }],
      },
      permission: {
        ses_selected: [{ ...buildPermission(), sessionID: "ses_selected", id: "perm_stale" }],
        ses_unrelated: [{ ...buildPermission(), sessionID: "ses_unrelated", id: "perm_keep" }],
      },
    })

    await resyncBlockingRequestsForDirectory("/repo", store, ["ses_selected"])

    expect(store.getState().question["ses_selected"]).toBe(undefined)
    expect(store.getState().permission["ses_selected"]).toBe(undefined)
    expect(store.getState().question["ses_unrelated"]?.[0]?.id).toBe("que_keep")
    expect(store.getState().permission["ses_unrelated"]?.[0]?.id).toBe("perm_keep")
  })

  test("returns early without fetching when no candidate sessions are known", async () => {
    const store = createDirectoryStore({ session: [] })
    await resyncBlockingRequestsForDirectory("/repo", store)
    expect(listPendingQuestionsCalls).toHaveLength(0)
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
})
