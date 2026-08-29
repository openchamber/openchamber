import { beforeEach, describe, expect, mock, test } from "bun:test"

const storage = new Map<string, string>()
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null; metadata?: unknown }> = []
const permissionAutoAcceptCalls: Array<[string, boolean]> = []
const savedVariantCalls: Array<string | undefined> = []
let configVariantOverride: string | null | undefined
// Sync's session→directory index. `createSession` writes it, and directory
// resolution reads it as the authoritative source, so the mock has to keep one.
const sessionDirectoryRegistry = new Map<string, string>()
let createdSessionDirectory: string | undefined

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
      activateDirectory: mock(async () => undefined),
      applyDefaultModelAgentSelection: mock(() => undefined),
    }),
  },
}))

let activeProjectIdMock: string | null = null
let activeProjectMock: { id: string; path: string | null } | null = null
let projectsMock: Array<{ id: string; path: string | null }> = []

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: projectsMock,
      activeProjectId: activeProjectIdMock,
      getActiveProject: () => activeProjectMock,
    }),
  },
}))

let currentDirectoryMock: string | null = null

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: currentDirectoryMock,
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

const { useSessionUIStore } = await import("../session-ui-store")
describe("openNewSessionDraft targets the active project by default", () => {
  /**
   * Regression for the Web UI: the top "New chat" button calls
   * `openNewSessionDraft()` with no explicit directory/project. When a project
   * is active it must open a draft that targets that project instead of a plain
   * managed `~/.config/openchamber/chats` chat, otherwise every new web chat
   * lands in the generic chats root regardless of the active project.
   */
  beforeEach(() => {
    storage.clear()
    createSessionCalls.length = 0
    sessionDirectoryRegistry.clear()
    permissionAutoAcceptCalls.length = 0
    savedVariantCalls.length = 0
    configVariantOverride = undefined
    createdSessionDirectory = undefined
    activeProjectIdMock = null
    activeProjectMock = null
    currentDirectoryMock = null
    projectsMock = []
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

  test("targets the active project when New chat is opened without explicit options", () => {
    activeProjectMock = { id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }
    projectsMock = [{ id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }]
    currentDirectoryMock = "/mnt/SSD-for-VMs/opencode/project"

    useSessionUIStore.getState().openNewSessionDraft()

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.target).toBe("project")
    expect(draft.selectedProjectId).toBe("project")
    expect(draft.directoryOverride).toBe("/mnt/SSD-for-VMs/opencode/project")
  })

  test("binds an implicit draft to the active project even when the current directory is inside a chats/ folder", () => {
    // Regression for the reviewer finding: with an active project set while the
    // current directory lives inside a managed chats/ folder (unresolvable to a
    // known project), an implicit New chat must land on the active project and
    // its path, not on the stale chats/ directory.
    activeProjectMock = { id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }
    projectsMock = [{ id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }]
    currentDirectoryMock = "/home/test/.config/openchamber/chats/2026-08-29/session-abc"

    useSessionUIStore.getState().openNewSessionDraft()

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.target).toBe("project")
    expect(draft.selectedProjectId).toBe("project")
    expect(draft.directoryOverride).toBe("/mnt/SSD-for-VMs/opencode/project")
  })

  test("binds an implicit draft to the active project when the current directory resolves to a different project", () => {
    // With an active project that has a path, an implicit New chat must target
    // the active project, not a different project reached via currentDirectory.
    activeProjectMock = { id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }
    projectsMock = [
      { id: "project", path: "/mnt/SSD-for-VMs/opencode/project" },
      { id: "other", path: "/other/project" },
    ]
    currentDirectoryMock = "/other/project"

    useSessionUIStore.getState().openNewSessionDraft()

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.target).toBe("project")
    expect(draft.selectedProjectId).toBe("project")
    expect(draft.directoryOverride).toBe("/mnt/SSD-for-VMs/opencode/project")
  })

  test("falls back to a managed chat when no active project exists", () => {
    activeProjectMock = null
    currentDirectoryMock = null

    useSessionUIStore.getState().openNewSessionDraft()

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.target).toBe("chat")
    expect(draft.selectedProjectId).toBeNull()
  })

  test("honors an explicit CHAT draft target even when a project is active", () => {
    activeProjectMock = { id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }
    projectsMock = [{ id: "project", path: "/mnt/SSD-for-VMs/opencode/project" }]
    currentDirectoryMock = "/mnt/SSD-for-VMs/opencode/project"

    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: "openchamber:chats" })

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.target).toBe("chat")
    expect(draft.selectedProjectId).toBeNull()
  })
})
