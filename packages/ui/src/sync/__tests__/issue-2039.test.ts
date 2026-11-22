import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { cyclePermissionMode } from "../../components/chat/permissionAutoAccept"

const storage = new Map<string, string>()
const createSessionCalls: Array<{ title?: string; directory: string | null; metadata?: unknown }> = []
const permissionAutoAcceptCalls: Array<[string, string]> = []
const savedVariantCalls: Array<string | undefined> = []
const savedAgentModelCalls: Array<[string, string, string, string]> = []
const applyDefaultModelAgentSelectionCalls: Array<{
  projectDefaultAgent?: string | null
  projectDefaultModel?: string | null
  projectDefaultVariant?: string | null
}> = []
const activateDirectoryCalls: Array<string | null | undefined> = []
const activationOptions: Array<{ preserveManualModel?: boolean } | undefined> = []
let configVariantOverride: string | null | undefined
let activationPending: Promise<void> | undefined
let selectionSource: 'auto' | 'manual' = 'auto'
const createdWorktreeProjects: Array<{ id: string; path: string }> = []
let waitForCheckoutImplementation: (directory: string) => Promise<void> = async () => undefined
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

mock.module("zustand", () => {
  // Both forms: `create(initializer)` and the curried `create<State>()(initializer)`.
  const build = (initializer: (
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
  }
  return { create: (initializer?: Parameters<typeof build>[0]) => (initializer ? build(initializer) : build) }
})

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
  getSafeSessionStorage: () => deferredStorage,
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
    getFilesystemHomeInfo: async () => ({ home: "/home/test" }),
    createDirectory: mock(async (path: string) => ({ success: true, path })),
    setDirectory: mock(() => undefined),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      setSessionMode: mock(async (sessionId: string, mode: string) => {
        permissionAutoAcceptCalls.push([sessionId, mode])
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
      selectionSource,
      agents: [],
      activateDirectory: mock(async (directory: string | null | undefined, options?: { preserveManualModel?: boolean }) => {
        activateDirectoryCalls.push(directory)
        activationOptions.push(options)
        await activationPending
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
  isDirectoryUnknown: () => false,
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: null,
      setDirectory: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useSessionGoalArmStore", () => ({
  useSessionGoalArmStore: {
    getState: () => ({ setArmed: () => undefined }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      entityById: new Map(),
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
      commandsByDirectory: {},
    }),
  },
  selectCommandsForDirectory: () => [],
}))

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [],
      skillsByDirectory: {},
    }),
  },
  selectSkillsForDirectory: () => [],
}))

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
    warning: () => undefined,
  },
}))

mock.module("../selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => undefined,
      saveSessionAgentSelection: () => undefined,
      saveAgentModelForSession: (sessionId: string, agent: string, provider: string, model: string) => {
        savedAgentModelCalls.push([sessionId, agent, provider, model])
      },
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
    metadata?: unknown,
    selectionTransition?: "submitted-draft",
  ) => {
    createSessionCalls.push({ title, directory, metadata })
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
  forkAfterMessage: mock(async () => undefined),
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
  sendMessage: mock(async () => undefined),
  refetchSessionMessages: mock(async () => undefined),
  revertToMessage: mock(async () => undefined),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  getSessionLastAssistantModel: () => null,
  patchSessionMetadata: mock(async () => undefined),
  abortCurrentOperation: mock(async () => undefined),
}))

mock.module("@/lib/git/branchNameGenerator", () => ({
  generateBranchName: () => "generated-branch",
}))

mock.module("@/lib/openchamberConfig", () => ({
  getWorktreeSetupCommands: async () => [],
  getWorktreeSetupWaitEnabled: async () => false,
  substituteCommandVariables: (command: string) => command,
}))
mock.module("@/lib/sharedTrustConfirmation", () => ({
  resolveWorktreeSetupCommands: async () => [],
}))

mock.module("@/lib/worktrees/worktreeBootstrap", () => ({
  waitForWorktreeBootstrap: async () => undefined,
  clearWorktreeBootstrapState: () => undefined,
  markWorktreeBootstrapPending: () => undefined,
  setWorktreeBootstrapState: () => undefined,
  startWorktreeBootstrapWatcher: () => undefined,
  waitForWorktreeGitReady: async (directory: string) => waitForCheckoutImplementation(directory),
}))

mock.module("@/lib/worktrees/worktreeCreate", () => ({
  createWorktreeWithDefaults: async (project: { id: string; path: string }) => {
    createdWorktreeProjects.push(project)
    return {
      source: "sdk",
      name: "generated-branch",
      path: "/worktrees/generated-branch",
      projectDirectory: project.path,
      branch: "generated-branch",
      label: "generated-branch",
    }
  },
}))

const { materializeOpenDraftSession, useSessionUIStore } = await import("../session-ui-store")
const { useSessionDisplayStore } = await import("@/stores/useSessionDisplayStore")
const { useUIStore } = await import("@/stores/useUIStore")

describe("issue 2039 draft auto-accept", () => {
  test("cycles the draft mode before a session exists", () => {
    const setDraftPermissionMode = mock(() => undefined)
    const setSessionMode = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    cyclePermissionMode({
      permissionScopeSessionId: null,
      newSessionDraftOpen: true,
      currentMode: "ask",
      safetyAvailable: true,
      setDraftPermissionMode,
      setSessionMode,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionMode).length).toBe(1)
    expect(getMockCalls(setDraftPermissionMode)[0]).toEqual(["safety"])
    expect(getMockCalls(setSessionMode).length).toBe(0)
    expect(getMockCalls(onOpenSessionFirst).length).toBe(0)
    expect(getMockCalls(onToggleFailed).length).toBe(0)
  })

  test("guards the toggle when no draft is open", () => {
    const setDraftPermissionMode = mock(() => undefined)
    const setSessionMode = mock(async () => undefined)
    const onOpenSessionFirst = mock(() => undefined)
    const onToggleFailed = mock(() => undefined)

    cyclePermissionMode({
      permissionScopeSessionId: null,
      newSessionDraftOpen: false,
      currentMode: "ask",
      safetyAvailable: true,
      setDraftPermissionMode,
      setSessionMode,
      onOpenSessionFirst,
      onToggleFailed,
    })

    expect(getMockCalls(setDraftPermissionMode).length).toBe(0)
    expect(getMockCalls(setSessionMode).length).toBe(0)
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
    savedAgentModelCalls.length = 0
    configVariantOverride = undefined
    activationPending = undefined
    selectionSource = 'auto'
    createdSessionDirectory = undefined
    useUIStore.setState({ permissionDefaultMode: "ask" })
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

    // No choice yet: the server writes the default from Settings.
    expect(useSessionUIStore.getState().newSessionDraft.permissionMode).toBeUndefined()

    useSessionUIStore.getState().setDraftPermissionMode("safety")

    expect(useSessionUIStore.getState().newSessionDraft.permissionMode).toBe("safety")

    const result = await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result?.sessionId).toBe("ses_issue_2039")
    expect(createSessionCalls).toHaveLength(1)
    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", "safety"]])
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_issue_2039")
  })

  test("writes the Settings default onto a new space session, which no server does for it", async () => {
    useUIStore.setState({ permissionDefaultMode: "auto" })
    createdSessionDirectory = "/spaces/0123456789ab/project"
    useSessionUIStore.getState().openNewSessionDraft({ target: "project", directoryOverride: "/spaces/0123456789ab/project" })

    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", "auto"]])
  })

  test("leaves the default to the host's server outside a space, and writes nothing for ask", async () => {
    useUIStore.setState({ permissionDefaultMode: "auto" })
    useSessionUIStore.getState().openNewSessionDraft({ target: "project", directoryOverride: "/repo" })
    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })

    useUIStore.setState({ permissionDefaultMode: "ask" })
    createdSessionDirectory = "/spaces/0123456789ab/project"
    useSessionUIStore.getState().openNewSessionDraft({ target: "project", directoryOverride: "/spaces/0123456789ab/project" })
    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(permissionAutoAcceptCalls).toEqual([])
  })

  test("a choice made in a space draft wins over the Settings default", async () => {
    useUIStore.setState({ permissionDefaultMode: "auto" })
    createdSessionDirectory = "/spaces/0123456789ab/project"
    useSessionUIStore.getState().openNewSessionDraft({ target: "project", directoryOverride: "/spaces/0123456789ab/project" })
    useSessionUIStore.getState().setDraftPermissionMode("ask")

    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(permissionAutoAcceptCalls).toEqual([["ses_issue_2039", "ask"]])
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

  test("stores a draft agent model only after an explicit model choice", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "model",
      agent: "agent-default",
      variant: "high",
    })

    expect(savedAgentModelCalls).toEqual([])

    selectionSource = "manual"
    useSessionUIStore.getState().openNewSessionDraft()
    await materializeOpenDraftSession({
      providerID: "provider",
      modelID: "other-model",
      agent: "agent-default",
      variant: "high",
    })

    expect(savedAgentModelCalls).toEqual([
      ["ses_issue_2039", "agent-default", "provider", "other-model"],
    ])
  })

  test("preserves choices when a draft keeps the same project", async () => {
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
    activationOptions.length = 0

    useSessionUIStore.getState().setNewSessionDraftTarget({
      projectId: project.id,
      directoryOverride: project.path,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual([])
    expect(applyDefaultModelAgentSelectionCalls).toEqual([])
  })

  test("loads the selected worktree's config when a project draft changes directories", async () => {
    const project = { id: "project-1", path: "/repo" }
    projectsState.projects = [project]

    useSessionUIStore.getState().openNewSessionDraft({
      target: "project",
      selectedProjectId: project.id,
      directoryOverride: project.path,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    activateDirectoryCalls.length = 0
    activationOptions.length = 0

    useSessionUIStore.getState().setNewSessionDraftTarget({
      projectId: project.id,
      directoryOverride: "/repo-worktree",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual(["/repo-worktree"])
    expect(activationOptions).toEqual([{ preserveManualModel: true }])
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
    expect(applyDefaultModelAgentSelectionCalls.at(-1)).toEqual({
      projectDefaultAgent: "agent-project",
      projectDefaultModel: "model-project",
      projectDefaultVariant: "variant-project",
    })
  })

  test("late activation preserves a manual pick and same-project worktree refinements", async () => {
    let finish!: () => void
    activationPending = new Promise<void>((resolve) => { finish = resolve })
    projectsState.projects = [{ id: 'project-1', path: '/repo', defaultAgent: 'build' }]
    useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: 'project-1', directoryOverride: '/repo' })
    expect(applyDefaultModelAgentSelectionCalls).toHaveLength(1)
    selectionSource = 'manual'
    useSessionUIStore.getState().overrideNewSessionDraftTarget({ directoryOverride: '/worktree', pendingWorktreeRequestId: 'request' })
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(applyDefaultModelAgentSelectionCalls).toHaveLength(1)
  })

  test("late project activation cannot replace a newer draft target or a closed draft", async () => {
    let finish!: () => void
    activationPending = new Promise<void>((resolve) => { finish = resolve })
    projectsState.projects = [{ id: 'project-1', path: '/repo', defaultAgent: 'project-agent' }]
    useSessionUIStore.getState().openNewSessionDraft({ target: 'project', selectedProjectId: 'project-1', directoryOverride: '/repo' })
    useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: 'openchamber:chats' })
    const appliedBeforeClose = applyDefaultModelAgentSelectionCalls.length
    useSessionUIStore.getState().closeNewSessionDraft()
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(applyDefaultModelAgentSelectionCalls).toHaveLength(appliedBeforeClose)
  })

  test("reapplies global defaults when opening a fresh no-project draft", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(activateDirectoryCalls).toEqual([null])
    expect(applyDefaultModelAgentSelectionCalls.at(-1)).toEqual({
      projectDefaultAgent: undefined,
      projectDefaultModel: undefined,
      projectDefaultVariant: undefined,
    })
  })

  test("restores project defaults when the next draft restores the previous project target", async () => {
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

    expect(activateDirectoryCalls).toEqual(["/repo"])
    expect(applyDefaultModelAgentSelectionCalls.at(-1)).toEqual({
      projectDefaultAgent: "agent-project",
      projectDefaultModel: "model-project",
      projectDefaultVariant: "variant-project",
    })
  })

  test("starting a chat brings back a hidden Chats section; a project session leaves it hidden", async () => {
    useSessionDisplayStore.getState().setShowChatsSection(false)
    useSessionUIStore.getState().openNewSessionDraft({ target: "project", directoryOverride: "/repo" })
    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    expect(useSessionDisplayStore.getState().showChatsSection).toBe(false)

    useSessionUIStore.getState().openNewSessionDraft()
    await materializeOpenDraftSession({ providerID: "provider", modelID: "model" })
    expect(useSessionDisplayStore.getState().showChatsSection).toBe(true)
  })

  test("does not apply draft auto-accept after the draft is closed", async () => {
    useSessionUIStore.getState().openNewSessionDraft()
    useSessionUIStore.getState().setDraftPermissionMode("auto")
    useSessionUIStore.getState().closeNewSessionDraft()

    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
    expect(useSessionUIStore.getState().newSessionDraft.permissionMode === undefined).toBe(true)

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

describe("assistant answer worktree routing", () => {
  test("reports session creation failure instead of completing silently", async () => {
    const state = useSessionUIStore.getState()
    const createFromAssistantMessage = state.createSessionFromAssistantMessage
    const originalCreateSession = state.createSession

    useSessionUIStore.setState({
      createSession: async () => null,
    })

    try {
      await expect(createFromAssistantMessage({
        sessionId: "source-session",
        directory: "/repo",
        text: "Implement the plan",
      }, {
        providerID: "provider",
        modelID: "model",
        variant: "",
        agent: "build",
        instructions: "Follow the answer",
      })).rejects.toThrow("Failed to create session")
    } finally {
      useSessionUIStore.setState({ createSession: originalCreateSession })
    }
  })

  test("removes the new worktree and surfaces the error when its checkout never populates", async () => {
    projectsState.projects = [{ id: "project", path: "/repo" }]
    createdWorktreeProjects.length = 0
    const sourceWorktree = { path: "/worktrees/source", projectDirectory: "/repo", branch: "source", label: "source" }
    const state = useSessionUIStore.getState()
    const originalCreateSession = state.createSession
    const originalWorktreeMetadata = state.worktreeMetadata
    const requests: Array<{ url: string; method: string }> = []
    let sessionCreated = false

    // The project sits on the folder `ai` of its repository, so the start folder needs the checkout.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" })
      return new Response(JSON.stringify({ root: "/repo", prefix: "ai", success: true }), { status: 200 })
    })
    waitForCheckoutImplementation = async () => { throw new Error("checkout failed") }
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([["/repo", [sourceWorktree]]]),
      worktreeMetadata: new Map([["source-session", sourceWorktree]]),
      createSession: async () => {
        sessionCreated = true
        return null
      },
    })

    try {
      await expect(state.createSessionFromAssistantMessage({
        sessionId: "source-session",
        directory: "/worktrees/source",
        text: "Implement the plan",
      }, {
        providerID: "provider",
        modelID: "model",
        variant: "",
        agent: "build",
        instructions: "Follow the answer",
        createWorktree: true,
      })).rejects.toThrow("checkout failed")
    } finally {
      fetchSpy.mockRestore()
      waitForCheckoutImplementation = async () => undefined
      useSessionUIStore.setState({ createSession: originalCreateSession, worktreeMetadata: originalWorktreeMetadata })
      projectsState.projects = []
    }

    expect(sessionCreated).toBe(false)
    expect(requests.some((request) => request.url.includes("worktree") && request.method !== "GET")).toBe(true)
  })

  test("creates a sibling worktree from the captured source worktree directory", async () => {
    projectsState.projects = [
      { id: "project", path: "/repo" },
      { id: "source-worktree", path: "/worktrees/source" },
    ]
    createdWorktreeProjects.length = 0
    const sourceWorktree = {
      path: "/worktrees/source",
      projectDirectory: "/repo",
      branch: "source",
      label: "source",
    }
    const state = useSessionUIStore.getState()
    const createFromAssistantMessage = state.createSessionFromAssistantMessage
    const originalCreateSession = state.createSession
    const originalSendMessage = state.sendMessage
    const originalWorktreeMetadata = state.worktreeMetadata
    let createdDirectory: string | null | undefined

    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([["/repo", [sourceWorktree]]]),
      worktreeMetadata: new Map([["source-session", sourceWorktree]]),
      createSession: async (_title, directory) => {
        createdDirectory = directory
        return {
          id: "created-session",
          projectID: "project",
          directory: directory ?? "",
          title: "Created session",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        }
      },
      sendMessage: async () => undefined,
    })

    try {
      await createFromAssistantMessage({
        sessionId: "source-session",
        directory: "/worktrees/source",
        text: "Implement the plan",
      }, {
        providerID: "provider",
        modelID: "model",
        variant: "",
        agent: "build",
        instructions: "Follow the answer",
        createWorktree: true,
      })
    } finally {
      useSessionUIStore.setState({
        createSession: originalCreateSession,
        sendMessage: originalSendMessage,
        worktreeMetadata: originalWorktreeMetadata,
      })
      projectsState.projects = []
    }

    expect(createdWorktreeProjects).toEqual([{ id: "project", path: "/repo" }])
    expect(createdDirectory).toBe("/worktrees/generated-branch")
  })
})
