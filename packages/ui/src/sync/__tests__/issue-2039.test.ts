import { beforeEach, describe, expect, mock, test } from "bun:test"
import { togglePermissionAutoAccept } from "../../components/chat/permissionAutoAccept"
import {
  createPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from "../../lib/worktrees/pendingDraftWorktree"

const storage = new Map<string, string>()
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null; metadata?: unknown; options?: unknown }> = []
const permissionAutoAcceptCalls: Array<[string, boolean]> = []
const optimisticSendSessionIds: string[] = []
const addSessionToFolderCalls: Array<[string, string, string]> = []

const getMockCalls = (fn: unknown): unknown[][] => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])

mock.module("zustand", () => ({
  create: () => (initializer: (set: (patch: unknown | ((state: unknown) => unknown)) => void, get: () => unknown) => Record<string, unknown>) => {
    let state: Record<string, unknown>
    const get = () => state
    const set = (patch: unknown | ((current: Record<string, unknown>) => unknown)) => {
      const next = typeof patch === "function" ? patch(state) : patch
      state = next && typeof next === "object" ? { ...state, ...(next as Record<string, unknown>) } : state
    }

    state = initializer(set, get)

    const store = ((selector?: (current: Record<string, unknown>) => unknown) => (
      typeof selector === "function" ? selector(state) : state
    )) as unknown as {
      getState: () => Record<string, unknown>
      setState: (patch: unknown | ((current: Record<string, unknown>) => unknown)) => void
      subscribe: () => () => void
    }

    store.getState = () => state
    store.setState = (patch) => set(patch)
    store.subscribe = () => () => undefined

    return store
  },
}))

const deferredStorage: Storage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
  clear: () => {
    storage.clear()
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size
  },
}

mock.module("@/stores/utils/safeStorage", () => ({
  getDeferredSafeStorage: () => deferredStorage,
  getSafeStorage: () => deferredStorage,
  getSafeSessionStorage: () => deferredStorage,
  createDeferredSafeJSONStorage: () => ({
    getItem: (key: string) => {
      const value = deferredStorage.getItem(key)
      return value ? JSON.parse(value) : null
    },
    setItem: (key: string, value: unknown) => deferredStorage.setItem(key, JSON.stringify(value)),
    removeItem: (key: string) => deferredStorage.removeItem(key),
  }),
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => null,
    setDirectory: mock(() => undefined),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      setSessionAutoAccept: mock(async (sessionId: string, enabled: boolean) => {
        permissionAutoAcceptCalls.push([sessionId, enabled])
      }),
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName: "agent-default",
      agents: [],
      activateDirectory: mock(async () => undefined),
      applyDefaultModelAgentSelection: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useUIStore", () => ({
  useUIStore: {
    getState: () => ({
      sessionGoalDefaultBudgetEnabled: false,
      sessionGoalDefaultBudget: 0,
    }),
  },
}))

mock.module("@/stores/useSessionGoalArmStore", () => ({
  useSessionGoalArmStore: {
    getState: () => ({
      consume: () => ({ armed: false, objectiveOverride: null }),
    }),
  },
}))

mock.module("@/lib/sessionGoalActions", () => ({
  setSessionGoal: mock(async () => undefined),
}))

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [],
      activeProjectId: null,
      getActiveProject: () => null,
    }),
  },
}))

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: null,
      setDirectory: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
    }),
  },
  resolveGlobalSessionDirectory: () => null,
}))

mock.module("@/stores/useSessionFoldersStore", () => ({
  useSessionFoldersStore: {
    getState: () => ({
      addSessionToFolder: mock((scopeKey: string, folderId: string, sessionId: string) => {
        addSessionToFolderCalls.push([scopeKey, folderId, sessionId])
      }),
    }),
  },
}))

mock.module("@/stores/useCommandsStore", () => ({
  useCommandsStore: {
    getState: () => ({
      commands: [],
    }),
  },
}))

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [],
    }),
  },
}))

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("../selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => undefined,
      saveSessionAgentSelection: () => undefined,
      saveAgentModelForSession: () => undefined,
      saveAgentModelVariantForSession: () => undefined,
      getSessionAgentSelection: () => null,
      getSessionModelSelection: () => null,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: () => "",
  getRuntimeKey: () => "test-runtime",
  initializeRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  switchRuntimeEndpoint: () => undefined,
}))

mock.module("@/lib/userSendAnimation", () => ({
  markPendingUserSendAnimation: () => undefined,
}))

mock.module("../sync-context", () => ({
  setActiveSession: () => undefined,
}))

mock.module("../notification-store", () => ({
  markSessionViewed: () => undefined,
}))

mock.module("../session-navigation", () => ({
  setSessionOpener: () => undefined,
}))

mock.module("../session-worktree-contract", () => ({
  getAttachedSessionDirectory: () => null,
}))

mock.module("../session-worktree-store", () => ({
  useSessionWorktreeStore: {
    getState: () => ({
      getAttachment: () => undefined,
      setAttachment: () => undefined,
      clearAttachment: () => undefined,
    }),
  },
}))

mock.module("../viewport-store", () => ({
  getViewportSessionMemory: () => null,
  viewportSessionKey: (sessionId: string) => sessionId,
  useViewportStore: {
    getState: () => ({
      updateViewportAnchor: mock(() => undefined),
    }),
    setState: () => undefined,
  },
}))

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      clearAttachedFiles: () => undefined,
      setPendingInputText: () => undefined,
      addRestoredAttachment: () => undefined,
    }),
  },
}))

mock.module("../sync-refs", () => ({
  getDirectoryState: () => null,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getAllSyncSessions: () => [],
}))

mock.module("../session-actions", () => ({
  createSession: mock(async (title: string | undefined, directory: string | null, parentID: string | null, metadata?: unknown, options?: unknown) => {
    createSessionCalls.push({ title, directory, parentID, metadata, options })
    return { id: "ses_issue_2039", directory }
  }),
  deleteSession: mock(async () => true),
  archiveSession: mock(async () => true),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async (params: { sessionId: string }) => {
    optimisticSendSessionIds.push(params.sessionId)
  }),
  refetchSessionMessages: mock(async () => undefined),
  revertToMessage: mock(async () => undefined),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  getSessionLastAssistantModel: () => null,
  patchSessionMetadata: mock(async () => undefined),
  abortCurrentOperation: mock(async () => undefined),
}))

const { materializeOpenDraftSession, useSessionUIStore } = await import("../session-ui-store")

describe("issue 2039 draft auto-accept", () => {
  test("toggles draft state before a session exists", () => {
    const setDraftPermissionAutoAcceptEnabled = mock(() => undefined)
    const setSessionAutoAccept = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    togglePermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: true,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled,
      setSessionAutoAccept,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled).length).toBe(1)
    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled)[0]).toEqual([true])
    expect(getMockCalls(setSessionAutoAccept).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(0)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  test("guards the toggle when no draft is open", () => {
    const setDraftPermissionAutoAcceptEnabled = mock(() => undefined)
    const setSessionAutoAccept = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    togglePermissionAutoAccept({
      permissionScopeSessionId: null,
      newSessionDraftOpen: false,
      draftPermissionAutoAcceptEnabled: false,
      permissionAutoAcceptEnabled: false,
      setDraftPermissionAutoAcceptEnabled,
      setSessionAutoAccept,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionAutoAcceptEnabled).length).toBe(0)
    expect(getMockCalls(setSessionAutoAccept).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(1)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  beforeEach(() => {
    storage.clear()
    createSessionCalls.length = 0
    permissionAutoAcceptCalls.length = 0
    optimisticSendSessionIds.length = 0
    addSessionToFolderCalls.length = 0

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: false,
        directoryOverride: null,
        parentID: null,
      },
    })
  })

  test("stores auto-accept in the draft and applies it when the session materializes", async () => {
    useSessionUIStore.getState().openNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled).toBe(false)

    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(true)

    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled).toBe(true)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result?.sessionId).toBe("ses_issue_2039")
    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", true]])
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_issue_2039")
  })

  test("does not apply draft auto-accept after the draft is closed", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(true)
    useSessionUIStore.getState().closeNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
    expect(useSessionUIStore.getState().newSessionDraft.permissionAutoAcceptEnabled === undefined).toBe(true)

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })

    expect(result).toBeNull()
    expect(createSessionCalls).toHaveLength(0)
    expect(permissionAutoAcceptCalls).toHaveLength(0)
  })

  test("keeps the first draft message pinned to the materialized session", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    const draft = useSessionUIStore.getState().newSessionDraft

    useSessionUIStore.getState().setCurrentSession("ses_old")
    await useSessionUIStore.getState().sendMessage(
      "hello",
      "provider",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { draft },
    )

    expect(optimisticSendSessionIds).toEqual(["ses_issue_2039"])
  })

  test("materializes the same draft only once", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    const draft = useSessionUIStore.getState().newSessionDraft
    const selection = { providerID: "provider", modelID: "model" }

    const first = materializeOpenDraftSession(selection, draft)
    useSessionUIStore.getState().setDraftPermissionAutoAcceptEnabled(true)
    const updatedDraft = useSessionUIStore.getState().newSessionDraft
    const second = materializeOpenDraftSession(selection, updatedDraft)

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(createSessionCalls).toHaveLength(1)
  })

  test("does not close a newer draft when an older draft materializes", async () => {
    useSessionUIStore.getState().openNewSessionDraft({ title: "first" })
    const firstDraft = useSessionUIStore.getState().newSessionDraft
    const materialization = materializeOpenDraftSession({ providerID: "provider", modelID: "model" }, firstDraft)

    useSessionUIStore.getState().openNewSessionDraft({ title: "second", targetFolderId: "folder-b" })
    await materialization

    expect(createSessionCalls[0]?.options).toEqual({ select: false })
    expect(addSessionToFolderCalls).toHaveLength(0)
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
    expect(useSessionUIStore.getState().newSessionDraft.title).toBe("second")
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()
  })

  test("does not reclaim selection after its draft was closed", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    const draft = useSessionUIStore.getState().newSessionDraft
    const materialization = materializeOpenDraftSession({ providerID: "provider", modelID: "model" }, draft)

    useSessionUIStore.getState().closeNewSessionDraft()
    await materialization

    expect(useSessionUIStore.getState().currentSessionId).toBeNull()
  })

  test("uses the resolved worktree target from the live draft", async () => {
    const requestId = createPendingDraftWorktreeRequest()
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/project",
      pendingWorktreeRequestId: requestId,
    })
    const capturedDraft = useSessionUIStore.getState().newSessionDraft

    resolvePendingDraftWorktreeRequest(requestId, "/project/.worktrees/feature")
    useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, "/project/.worktrees/feature")

    const result = await materializeOpenDraftSession(
      { providerID: "provider", modelID: "model" },
      capturedDraft,
    )

    expect(result?.directory).toBe("/project/.worktrees/feature")
    expect(createSessionCalls[0]?.directory).toBe("/project/.worktrees/feature")
  })
})
