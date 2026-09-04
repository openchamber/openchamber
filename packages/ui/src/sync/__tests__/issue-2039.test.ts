import { beforeEach, describe, expect, mock, test } from "bun:test"
import { togglePermissionAutoAccept } from "../../components/chat/permissionAutoAccept"

const storage = new Map<string, string>()
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null; metadata?: unknown }> = []
const permissionAutoAcceptCalls: Array<[string, boolean]> = []
const savedVariantCalls: Array<string | undefined> = []
const applyDefaultModelAgentSelectionCalls: Array<{
  projectDefaultAgent?: string | null
  projectDefaultModel?: string | null
  projectDefaultVariant?: string | null
}> = []
const activateDirectoryCalls: Array<string | null | undefined> = []
let configVariantOverride: string | null | undefined
// Sync's session→directory index. `createSession` writes it, and directory
// resolution reads it as the authoritative source, so the mock has to keep one.
const sessionDirectoryRegistry = new Map<string, string>()
let createdSessionDirectory: string | undefined
const projectsState = {
  projects: [] as Array<{
    id: string
    path: string
    defaultAgent?: string | null
    defaultModel?: string | null
    defaultVariant?: string | null
  }>,
  activeProjectId: null as string | null,
  setActiveProjectIdOnly: (projectId: string | null) => {
    projectsState.activeProjectId = projectId
  },
  getActiveProject: () => null as {
    id: string
    path: string
    defaultAgent?: string | null
    defaultModel?: string | null
    defaultVariant?: string | null
  } | null,
}

const getMockCalls = (fn: unknown): unknown[][] => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])

mock.module("zustand", () => ({
  create: () => (initializer: (
    set: (patch: unknown | ((state: unknown) => unknown)) => void,
    get: () => unknown,
    api?: unknown,
  ) => Record<string, unknown>) => {
    let state: Record<string, unknown>
    const get = () => state
    const set = (patch: unknown | ((current: Record<string, unknown>) => unknown)) => {
      const next = typeof patch === "function" ? patch(state) : patch
      state = next && typeof next === "object" ? { ...state, ...(next as Record<string, unknown>) } : state
    }

    state = initializer(set, get, {
      setState: set,
      getState: get,
      getInitialState: get,
      subscribe: () => () => undefined,
    } as never)

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
  createDeferredSafeJSONStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => null,
    getFilesystemHome: mock(async () => "/home/test"),
    createDirectory: mock(async (path: string) => ({ success: true, path })),
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
      currentProviderId: "provider",
      currentModelId: "model",
      currentVariantSelection: { override: configVariantOverride, inherited: "high" },
      agents: [],
      activateDirectory: mock(async (directory: string | null | undefined) => {
        activateDirectoryCalls.push(directory)
      }),
      applyDefaultModelAgentSelection: mock((selection: {
        projectDefaultAgent?: string | null
        projectDefaultModel?: string | null
        projectDefaultVariant?: string | null
      }) => {
        applyDefaultModelAgentSelectionCalls.push(selection)
      }),
    }),
  },
}))

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => projectsState,
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
      addSessionToFolder: mock(() => undefined),
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
      saveAgentModelVariantForSession: (_sessionId: string, _agent: string, _provider: string, _model: string, variant: string | undefined) => {
        savedVariantCalls.push(variant)
      },
      getSessionAgentSelection: () => null,
      getSessionModelSelection: () => null,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}))

// Spread the real module so the stub stays a patch: anything else importing
// runtime-switch in this process still gets its remaining exports.
const runtimeSwitchModule = await import("@/lib/runtime-switch")
mock.module("@/lib/runtime-switch", () => ({
  ...runtimeSwitchModule,
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
  getSyncSessionDirectory: (sessionId: string) => sessionDirectoryRegistry.get(sessionId) ?? null,
  registerSessionDirectory: (sessionId: string, directory: string) => {
    sessionDirectoryRegistry.set(sessionId, directory)
  },
}))

mock.module("../session-actions", () => ({
  // Mirrors the real action's authoritative steps: the created session becomes
  // current under the directory the server confirmed, and that directory enters
  // the routing index. Everything these tests assert about routing depends on
  // those two, so a mock without them tests nothing.
  createSession: mock(async (
    title: string | undefined,
    directory: string | null,
    parentID: string | null,
    metadata?: unknown,
    selectionTransition?: "submitted-draft",
  ) => {
    createSessionCalls.push({ title, directory, parentID, metadata })
    const session = { id: "ses_issue_2039", directory: createdSessionDirectory ?? directory }
    const sessionDirectory = session.directory ?? null
    if (sessionDirectory) {
      sessionDirectoryRegistry.set(session.id, sessionDirectory)
    }
    const { useSessionUIStore: store } = await import("../session-ui-store")
    store.getState().setCurrentSession(session.id, sessionDirectory, selectionTransition)
    store.getState().markSessionAsOpenChamberCreated(session.id)
    return session
  }),
  deleteSession: mock(async () => true),
  deleteSessions: mock(async () => ({ deletedIds: [], failedIds: [] })),
  archiveSession: mock(async () => true),
  archiveSessions: mock(async () => ({ archivedIds: [], failedIds: [] })),
  unarchiveSession: mock(async () => true),
  unarchiveSessions: mock(async () => ({ restoredIds: [], failedIds: [] })),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async () => undefined),
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
    applyDefaultModelAgentSelectionCalls.length = 0
    activateDirectoryCalls.length = 0
    sessionDirectoryRegistry.clear()
    permissionAutoAcceptCalls.length = 0
    savedVariantCalls.length = 0
    configVariantOverride = undefined
    createdSessionDirectory = undefined
    projectsState.projects = []
    projectsState.activeProjectId = null
    projectsState.setActiveProjectIdOnly = (projectId: string | null) => {
      projectsState.activeProjectId = projectId
    }
    projectsState.getActiveProject = () => null

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        draftId: 0,
        open: false,
        directoryOverride: null,
        parentID: null,
        target: "chat",
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

  test("stores only an explicit draft variant as the session override", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
      agent: "agent-default",
      variant: "high",
    })

    expect(savedVariantCalls).toEqual([undefined])

    configVariantOverride = "high"
    useSessionUIStore.getState().openNewSessionDraft()
    await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
      agent: "agent-default",
      variant: "high",
    })

    expect(savedVariantCalls).toEqual([undefined, "high"])
  })

  test("reapplies project defaults when a project draft target is selected on first use", async () => {
    const project = {
      id: "project-1",
      path: "/repo",
      defaultAgent: "agent-project",
      defaultModel: "model-project",
      defaultVariant: "variant-project",
    }
    projectsState.projects = [project]

    useSessionUIStore.getState().openNewSessionDraft({
      target: "project",
      selectedProjectId: project.id,
      directoryOverride: project.path,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    applyDefaultModelAgentSelectionCalls.length = 0
    activateDirectoryCalls.length = 0

    useSessionUIStore.getState().setNewSessionDraftTarget({
      projectId: project.id,
      directoryOverride: project.path,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual(["/repo"])
    expect(applyDefaultModelAgentSelectionCalls).toEqual([{
      projectDefaultAgent: "agent-project",
      projectDefaultModel: "model-project",
      projectDefaultVariant: "variant-project",
    }])
  })

  test("reapplies project defaults when a project draft target is overridden", async () => {
    const project = {
      id: "project-1",
      path: "/repo",
      defaultAgent: "agent-project",
      defaultModel: "model-project",
      defaultVariant: "variant-project",
    }
    projectsState.projects = [project]

    useSessionUIStore.getState().openNewSessionDraft()
    await new Promise((resolve) => setTimeout(resolve, 0))
    applyDefaultModelAgentSelectionCalls.length = 0
    activateDirectoryCalls.length = 0

    useSessionUIStore.getState().overrideNewSessionDraftTarget({
      target: "project",
      selectedProjectId: project.id,
      directoryOverride: project.path,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual(["/repo"])
    expect(applyDefaultModelAgentSelectionCalls).toEqual([{
      projectDefaultAgent: "agent-project",
      projectDefaultModel: "model-project",
      projectDefaultVariant: "variant-project",
    }])
  })

  test("reapplies global defaults when opening a fresh no-project draft", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual([null])
    expect(applyDefaultModelAgentSelectionCalls).toEqual([{
      projectDefaultAgent: undefined,
      projectDefaultModel: undefined,
      projectDefaultVariant: undefined,
    }])
  })

  test("reapplies the default agent after a project session when the next draft has no project", async () => {
    const project = {
      id: "project-1",
      path: "/repo",
      defaultAgent: "agent-project",
      defaultModel: "model-project",
      defaultVariant: "variant-project",
    }
    projectsState.projects = [project]

    useSessionUIStore.getState().openNewSessionDraft({
      target: "project",
      selectedProjectId: project.id,
      directoryOverride: project.path,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
      agent: "agent-project",
    })

    applyDefaultModelAgentSelectionCalls.length = 0
    activateDirectoryCalls.length = 0

    useSessionUIStore.getState().openNewSessionDraft()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual([null])
    expect(applyDefaultModelAgentSelectionCalls).toEqual([{
      projectDefaultAgent: undefined,
      projectDefaultModel: undefined,
      projectDefaultVariant: undefined,
    }])
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

  test("transfers draft project context pins only to the session it creates", async () => {
    useSessionUIStore.getState().openNewSessionDraft({
      projectContextPins: { notes: ["note-a"], plans: [] },
    })
    useSessionUIStore.getState().setDraftProjectContextPin("plan", "plan-a", true)

    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })

    expect(createSessionCalls[0]?.metadata).toEqual({
      openchamber: {
        project_context_pins: { notes: ["note-a"], plans: ["plan-a"] },
      },
    })
    expect(useSessionUIStore.getState().newSessionDraft.projectContextPins).toBe(undefined)

    useSessionUIStore.getState().openNewSessionDraft()
    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })

    expect(createSessionCalls[1]?.metadata).toBe(undefined)
  })

  test("uses the server-authoritative directory after worktree session creation", async () => {
    createdSessionDirectory = "/canonical/worktree"
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/requested/worktree",
    })

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })

    expect(createSessionCalls[0]?.directory).toBe("/requested/worktree")
    expect(result?.directory).toBe("/canonical/worktree")
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/canonical/worktree")
  })

  test("routes the session by the canonical directory, not the requested worktree path", async () => {
    createdSessionDirectory = "/canonical/worktree"
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/requested/worktree",
    })

    const created = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    const sessionId = created?.sessionId ?? ""

    // The worktree attachment still holds the path this client asked for. The
    // directory every send, queue key, and confirmation lookup is routed by
    // must be the canonical one the server returned.
    useSessionUIStore.getState().setWorktreeMetadata(sessionId, {
      path: "/requested/worktree",
      projectDirectory: "/repo",
      branch: "feature",
      label: "feature",
    })

    expect(useSessionUIStore.getState().getDirectoryForSession(sessionId)).toBe("/canonical/worktree")
  })
})
