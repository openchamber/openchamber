/**
 * Issue #2222 — First message in a new session can be sent to the previously active session.
 *
 * Root cause: `ChatInput.handleSubmit()` performs asynchronous preparation before calling
 * `sendMessage`, and `sendMessage` reads `get().currentSessionId` / `get().newSessionDraft`
 * LIVE from the store at execution time rather than using values captured at submit time.
 *
 * If project/session selection changes during the async window (e.g. via sidebar click),
 * the message is routed to the wrong session.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// -- Mocks ------------------------------------------------------------------

const optimisticSendCalls: Array<{ sessionId: string; directory?: string }> = [];
const optimisticSendAgents: Array<string | undefined> = [];
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null }> = [];
const folderAssignmentCalls: Array<{ directory: string; folderId: string; sessionId: string }> = [];
type ActiveConfig = {
  directory: string | null;
  providerID: string | null;
  modelID: string | null;
  agent: string | null;
};
const configByDirectory: Record<string, Omit<ActiveConfig, "directory">> = {
  "/projects/alpha": {
    providerID: "provider-alpha",
    modelID: "model-alpha",
    agent: "agent-alpha",
  },
  "/projects/beta": {
    providerID: "provider-beta",
    modelID: "model-beta",
    agent: "agent-beta",
  },
};
const configActivationCalls: Array<string | null> = [];
let activeConfig: ActiveConfig = {
  directory: null,
  providerID: null,
  modelID: null,
  agent: null,
};
let pendingConfigActivation: { directory: string | null; completion: Promise<void> } | null = null;
const activateDirectory = async (directory: string | null | undefined) => {
  const normalizedDirectory = directory ?? null;
  const config = normalizedDirectory ? configByDirectory[normalizedDirectory] : undefined;
  configActivationCalls.push(normalizedDirectory);
  const pending = pendingConfigActivation;
  if (pending?.directory === normalizedDirectory) {
    await pending.completion;
  }
  activeConfig = {
    directory: normalizedDirectory,
    providerID: config?.providerID ?? null,
    modelID: config?.modelID ?? null,
    agent: config?.agent ?? null,
  };
};
const defaultSelectionCalls: Array<{ projectDefaultModel?: string }> = [];
const applyDefaultModelAgentSelection = (options: { projectDefaultModel?: string }) => {
  defaultSelectionCalls.push(options);
};
let mockProjects: Array<{ id: string; path: string; defaultModel?: string }> = [];
let mockActiveProjectId: string | null = null;
let pendingCreateSession: {
  completion: Promise<void>;
  signalStarted: () => void;
} | null = null;
let armedGoal = { armed: false, objectiveOverride: null as string | null };
let goalConsumeCalls = 0;
const setSessionGoalCalls: Array<{ sessionId: string; directory: string | undefined; objective: string }> = [];
let currentConfigAgentName: string | null = "agent-default";
let sessionAgentSelection: string | null = null;

mock.module("zustand", () => ({
  create:
    () =>
    (
      initializer: (
        set: (patch: unknown | ((state: unknown) => unknown)) => void,
        get: () => unknown,
      ) => Record<string, unknown>,
    ) => {
      let state: Record<string, unknown>;
      const get = () => state;
      const set = (
        patch: unknown | ((current: Record<string, unknown>) => unknown),
      ) => {
        const next =
          typeof patch === "function" ? patch(state) : patch;
        state =
          next && typeof next === "object"
            ? { ...state, ...(next as Record<string, unknown>) }
            : state;
      };

      state = initializer(set, get);

      const store = ((
        selector?: (current: Record<string, unknown>) => unknown,
      ) =>
        typeof selector === "function" ? selector(state) : state) as unknown as {
        getState: () => Record<string, unknown>;
        setState: (
          patch: unknown | ((current: Record<string, unknown>) => unknown),
        ) => void;
        subscribe: () => () => void;
      };

      store.getState = () => state;
      store.setState = (patch) => set(patch);
      store.subscribe = () => () => undefined;

      return store;
    },
}));

mock.module("@/stores/utils/safeStorage", () => ({
  getDeferredSafeStorage: () => ({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  }),
}));

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => null,
    setDirectory: mock(() => undefined),
    shellSession: mock(() => Promise.resolve({ info: {}, parts: [] })),
    sendCommand: mock(() => Promise.resolve("msg")),
    sendMessage: mock(() => Promise.resolve("msg")),
  },
}));

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      setSessionAutoAccept: mock(() => Promise.resolve()),
    }),
  },
}));

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName: currentConfigAgentName,
      agents: [],
      activateDirectory,
      applyDefaultModelAgentSelection,
    }),
  },
}));

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: mockProjects,
      activeProjectId: mockActiveProjectId,
      getActiveProject: () => mockProjects.find((project) => project.id === mockActiveProjectId) ?? null,
    }),
  },
}));

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: null,
      setDirectory: mock(() => undefined),
    }),
  },
}));

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
    }),
  },
  resolveGlobalSessionDirectory: () => null,
}));

mock.module("@/stores/useSessionFoldersStore", () => ({
  useSessionFoldersStore: {
    getState: () => ({
      addSessionToFolder: mock((directory: string, folderId: string, sessionId: string) => {
        folderAssignmentCalls.push({ directory, folderId, sessionId });
      }),
    }),
  },
}));

mock.module("@/stores/useCommandsStore", () => ({
  useCommandsStore: {
    getState: () => ({
      commands: [],
    }),
  },
}));

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [],
    }),
  },
}));

mock.module("@/stores/useSessionGoalArmStore", () => ({
  useSessionGoalArmStore: {
    getState: () => ({
      consume: () => {
        goalConsumeCalls += 1;
        const goal = armedGoal;
        if (goal.armed) {
          armedGoal = { armed: false, objectiveOverride: null };
        }
        return goal;
      },
    }),
    subscribe: () => () => undefined,
  },
}));

mock.module("@/lib/sessionGoalActions", () => ({
  setSessionGoal: mock(async (
    sessionId: string,
    directory: string | undefined,
    input: { objective: string },
  ) => {
    setSessionGoalCalls.push({ sessionId, directory, objective: input.objective });
  }),
}));

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}));

mock.module("../selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => undefined,
      saveSessionAgentSelection: () => undefined,
      saveAgentModelForSession: () => undefined,
      saveAgentModelVariantForSession: () => undefined,
      getSessionAgentSelection: () => sessionAgentSelection,
      getSessionModelSelection: () => null,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}));

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: () => "",
  getRuntimeKey: () => "test-runtime",
  initializeRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  switchRuntimeEndpoint: () => undefined,
}));

mock.module("@/lib/userSendAnimation", () => ({
  markPendingUserSendAnimation: () => undefined,
}));

mock.module("../sync-context", () => ({
  setActiveSession: () => undefined,
}));

mock.module("../notification-store", () => ({
  markSessionViewed: () => undefined,
}));

mock.module("../session-navigation", () => ({
  setSessionOpener: () => undefined,
}));

mock.module("../session-worktree-contract", () => ({
  getAttachedSessionDirectory: () => null,
}));

mock.module("../session-worktree-store", () => ({
  useSessionWorktreeStore: {
    getState: () => ({
      getAttachment: () => undefined,
      setAttachment: () => undefined,
      clearAttachment: () => undefined,
    }),
  },
}));

mock.module("../viewport-store", () => ({
  getViewportSessionMemory: () => null,
  viewportSessionKey: (sessionId: string) => sessionId,
  useViewportStore: {
    getState: () => ({
      updateViewportAnchor: mock(() => undefined),
      sessionMemoryState: new Map(),
    }),
    setState: () => undefined,
  },
}));

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      clearAttachedFiles: () => undefined,
      setPendingInputText: () => undefined,
      addRestoredAttachment: () => undefined,
    }),
  },
}));

mock.module("../sync-refs", () => ({
  getDirectoryState: () => null,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getAllSyncSessions: () => [],
}));

mock.module("../session-actions", () => ({
  createSession: mock(
    async (
      title: string | undefined,
      directory: string | null,
      parentID: string | null,
    ) => {
      createSessionCalls.push({ title, directory, parentID });
      const pending = pendingCreateSession;
      if (pending) {
        pending.signalStarted();
        await pending.completion;
      }
      return { id: "ses_materialized_2222", directory };
    },
  ),
  deleteSession: mock(async () => true),
  archiveSession: mock(async () => true),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async (params: { sessionId: string; directory?: string; agent?: string }) => {
    optimisticSendCalls.push({ sessionId: params.sessionId, directory: params.directory });
    optimisticSendAgents.push(params.agent);
    return;
  }),
  refetchSessionMessages: mock(async () => undefined),
  revertToMessage: mock(async () => undefined),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  dismissOpenQuestionsForSession: mock(async () => false),
  waitForConnectionOrThrow: mock(async () => undefined),
  setActionRefs: mock(() => undefined),
  setOptimisticRefs: mock(() => undefined),
  getSessionLastAssistantModel: mock(() => null),
  mirrorSessionIntoLiveStores: mock(() => undefined),
  isQuestionRequestNotFoundError: mock(() => false),
  patchSessionMetadata: mock(async () => undefined),
  deleteSessionInDirectory: mock(async () => true),
  abortCurrentOperation: mock(async () => undefined),
  respondToPermission: mock(async () => undefined),
  dismissPermission: mock(async () => undefined),
  respondToQuestion: mock(async () => undefined),
  rejectQuestion: mock(async () => undefined),
}));

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock(() => Promise.resolve(new Response())),
}));

mock.module("@/stores/useUIStore", () => ({
  useUIStore: {
    getState: () => ({
      sessionGoalDefaultBudgetEnabled: false,
      sessionGoalDefaultBudget: 0,
    }),
  },
}));

mock.module("@/lib/pathNormalization", () => ({
  normalizePath: (path: string | null | undefined) =>
    path
      ? path.replace(/\\/g, "/").replace(/\/+$/, "")
      : null,
}));

mock.module("@/stores/useSnippetsStore", () => ({
  useSnippetsStore: {
    getState: () => ({
      expandText: async (text: string) => text,
    }),
  },
}));

const { materializeOpenDraftSession, useSessionUIStore } = await import("../session-ui-store");
const { createPendingDraftWorktreeRequest, resolvePendingDraftWorktreeRequest } = await import("@/lib/worktrees/pendingDraftWorktree");

describe("Issue #2222 — sendMessage reads live currentSessionId", () => {
  beforeEach(() => {
    optimisticSendCalls.length = 0;
    optimisticSendAgents.length = 0;
    createSessionCalls.length = 0;
    folderAssignmentCalls.length = 0;
    pendingCreateSession = null;
    pendingConfigActivation = null;
    configActivationCalls.length = 0;
    defaultSelectionCalls.length = 0;
    setSessionGoalCalls.length = 0;
    goalConsumeCalls = 0;
    armedGoal = { armed: false, objectiveOverride: null };
    currentConfigAgentName = "agent-default";
    sessionAgentSelection = null;
    mockProjects = [];
    mockActiveProjectId = null;
    activeConfig = {
      directory: null,
      providerID: null,
      modelID: null,
      agent: null,
    };

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      lastLoadedDirectory: null,
      newSessionDraft: {
        open: false,
        directoryOverride: null,
        parentID: null,
      },
      webUICreatedSessions: new Set(),
      worktreeMetadata: new Map(),
      pendingChangesBarDismissed: new Map(),
    });

  });

  // ---------------------------------------------------------------------------
  // Scenario 1 — New draft → old session reroute
  // ---------------------------------------------------------------------------
  test("new draft message routed to previously active session when sidebar selection changes during async window", async () => {
    // Arrange: open a new session draft
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
    });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();

    // Act: simulate the async gap from ChatInput.handleSubmit — during this gap
    // (between the initial guard check and the sendMessage call), the sidebar
    // selection changes, closing the draft and activating an old session.
    useSessionUIStore.getState().closeNewSessionDraft();
    useSessionUIStore.getState().setCurrentSession(
      "session-old",
      "/projects/alpha",
    );

    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-old");

    // Now sendMessage is called (by handleSubmit after async prep completes).
    // It should materialize the draft and send to the new session.
    // BUG: it reads draft.open = false and currentSessionId = 'session-old',
    // so it routes to session-old instead.
    await useSessionUIStore.getState().sendMessage(
      "hello world",
      "provider-x",
      "model-y",
    );

    // Assert: the message was NOT sent via materialized draft
    expect(createSessionCalls).toHaveLength(0);

    // Assert: the message WAS sent to session-old (the bug)
    // Instead of creating a new session and routing there, it was sent to
    // the re-activated old session because sendMessage read live state.
    expect(optimisticSendCalls).toHaveLength(1);
    expect(optimisticSendCalls[0].sessionId).toBe("session-old");
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — Existing session A → existing session B reroute
  // ---------------------------------------------------------------------------
  test("existing session message routed to different session when currentSessionId changes during async window", async () => {
    // Arrange: user is in session A
    useSessionUIStore.getState().setCurrentSession(
      "session-a",
      "/projects/alpha",
    );
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-a");

    // Act: simulate the async gap — during the await in handleSubmit
    // (e.g. fetchResponseStyleInstruction), the sidebar changes to session B.
    useSessionUIStore.getState().setCurrentSession(
      "session-b",
      "/projects/beta",
    );

    expect(useSessionUIStore.getState().currentSessionId).toBe("session-b");

    // sendMessage is called — it should target session-a (the session that
    // was active when the user clicked send).
    // BUG: it reads get().currentSessionId = 'session-b' and sends there.
    await useSessionUIStore.getState().sendMessage(
      "hello from session A",
      "provider-x",
      "model-y",
    );

    // Assert: message should have gone to session-a
    // BUG: it goes to session-b
    expect(optimisticSendCalls).toHaveLength(1);

    // This is the WRONG behaviour — the message should target session-a
    // because that's what was active when the user hit submit.
    expect(optimisticSendCalls[0].sessionId).toBe("session-b");
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — Confirms the FIX: sendMessage with explicit sessionId works
  // ---------------------------------------------------------------------------
  test("sendMessage with explicit sessionId options bypasses live currentSessionId", async () => {
    // Arrange: user is in session A
    useSessionUIStore.getState().setCurrentSession(
      "session-a",
      "/projects/alpha",
    );

    // Session changes during async gap
    useSessionUIStore.getState().setCurrentSession(
      "session-b",
      "/projects/beta",
    );

    // Act: sendMessage with explicit sessionId (the fix)
    await useSessionUIStore.getState().sendMessage(
      "hello from session A",
      "provider-x",
      "model-y",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { sessionId: "session-a" },
    );

    // Assert: message is routed to session-a (the captured target)
    expect(optimisticSendCalls).toHaveLength(1);
    expect(optimisticSendCalls[0].sessionId).toBe("session-a");
  });

  test("explicit A routing context preserves its directory and captured-null agent after B is selected", async () => {
    useSessionUIStore.getState().setCurrentSession("session-a", "/projects/alpha");
    currentConfigAgentName = null;

    useSessionUIStore.getState().setCurrentSession("session-b", "/projects/beta");
    currentConfigAgentName = "agent-beta";

    await useSessionUIStore.getState().sendMessage(
      "message from A",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      {
        sessionId: "session-a",
        sessionDirectory: "/projects/alpha",
        sessionAgent: null,
        goalArm: { armed: false, objectiveOverride: null },
      },
    );

    expect(optimisticSendCalls).toEqual([{
      sessionId: "session-a",
      directory: "/projects/alpha",
    }]);
    expect(optimisticSendAgents).toEqual([undefined]);
  });

  test("explicit A goal arm does not consume a newly armed B goal", async () => {
    useSessionUIStore.getState().setCurrentSession("session-a", "/projects/alpha");
    useSessionUIStore.getState().setCurrentSession("session-b", "/projects/beta");
    armedGoal = { armed: true, objectiveOverride: "B objective" };

    await useSessionUIStore.getState().sendMessage(
      "message from A",
      "provider-a",
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      {
        sessionId: "session-a",
        goalArm: { armed: true, objectiveOverride: "A objective" },
      },
    );

    expect(goalConsumeCalls).toBe(0);
    expect(armedGoal).toEqual({ armed: true, objectiveOverride: "B objective" });
    expect(setSessionGoalCalls).toEqual([{
      sessionId: "session-a",
      directory: undefined,
      objective: "A objective",
    }]);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — Draft materializes correctly when no selection change
  // ---------------------------------------------------------------------------
  test("draft materializes and routes correctly when no sidebar selection change occurs", async () => {
    // Arrange: open a new session draft
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
    });
    const draftSnapshot = useSessionUIStore.getState().newSessionDraft;

    // Act: sendMessage receives the captured snapshot without any intervening
    // selection change, as ChatInput does in production.
    await useSessionUIStore.getState().sendMessage(
      "hello world",
      "provider-x",
      "model-y",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { draftSnapshot },
    );

    // Assert: draft was materialized
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].directory).toBe("/projects/alpha");

    // Assert: message was routed to the materialized session
    expect(optimisticSendCalls).toHaveLength(1);
    expect(optimisticSendCalls[0].sessionId).toBe("ses_materialized_2222");

    // Assert: currentSessionId was updated
    expect(useSessionUIStore.getState().currentSessionId).toBe(
      "ses_materialized_2222",
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 5 — Issue #2245: cross-project draft snapshot bypasses live selection
  // ---------------------------------------------------------------------------
  test("Issue #2245: captured draft A materializes and sends to A after live selection switches to B", async () => {
    // Step 1: Open and capture draft A before the async preparation gap.
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
      targetFolderId: "folder-alpha",
    });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);

    // Step 2: Capture the draft state before the async gap
    const capturedDraft = { ...useSessionUIStore.getState().newSessionDraft };

    // Step 3: During the gap, a cross-project sidebar selection closes the
    // draft and switches the live selection to session B in directory B.
    useSessionUIStore.getState().closeNewSessionDraft();
    useSessionUIStore.getState().setCurrentSession(
      "session-b",
      "/projects/beta",
    );
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-b");
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/projects/beta");

    // Step 4: Call sendMessage with draftSnapshot in options — the draft
    // materialization path should be taken using the captured snapshot,
    // NOT the live (closed) draft state.
    await useSessionUIStore.getState().sendMessage(
      "hello from captured draft",
      "provider-x",
      "model-y",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { draftSnapshot: capturedDraft },
    );

    // Assert: draft was materialized (createSession was called with the right directory)
    expect(createSessionCalls.some(c => c.directory === "/projects/alpha")).toBe(true);

    // Assert: message was routed to the materialized session, not session B.
    expect(optimisticSendCalls.some(c => c.sessionId === "ses_materialized_2222")).toBe(true);
    expect(optimisticSendCalls.some(c => c.sessionId === "session-b")).toBe(false);

    // The captured draft owns its folder target as well, even though the live
    // draft was closed before sendMessage materialized the new session.
    expect(folderAssignmentCalls.some((call) => (
      call.directory === "/projects/alpha"
      && call.folderId === "folder-alpha"
      && call.sessionId === "ses_materialized_2222"
    ))).toBe(true);

    // Assert: the newer cross-project selection remains untouched.
    expect(useSessionUIStore.getState().currentSessionId).toBe(
      "session-b",
    );
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/projects/beta");
  });

  test("captured draft send stays in its directory when another session is selected during materialization", async () => {
    let markCreateSessionStarted!: () => void;
    let resumeCreateSession!: () => void;
    const createSessionStarted = new Promise<void>((resolve) => {
      markCreateSessionStarted = resolve;
    });
    const createSessionPaused = new Promise<void>((resolve) => {
      resumeCreateSession = resolve;
    });
    pendingCreateSession = {
      completion: createSessionPaused,
      signalStarted: markCreateSessionStarted,
    };

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
    });
    const draftSnapshot = { ...useSessionUIStore.getState().newSessionDraft };

    const draftSend = useSessionUIStore.getState().sendMessage(
      "hello from project A",
      "provider-x",
      "model-y",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { draftSnapshot },
    );

    await createSessionStarted;
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].directory).toBe("/projects/alpha");

    useSessionUIStore.getState().setCurrentSession(
      "session-b",
      "/projects/beta",
    );
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-b");
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/projects/beta");

    resumeCreateSession();
    await draftSend;
    pendingCreateSession = null;

    expect(optimisticSendCalls).toEqual([
      {
        sessionId: "ses_materialized_2222",
        directory: "/projects/alpha",
      },
    ]);
    expect(optimisticSendCalls.some((call) => call.sessionId === "session-b")).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-b");
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/projects/beta");
  });

  test("does not let captured draft A activate its config after newer draft B takes over", async () => {
    let markCreateSessionStarted!: () => void;
    let resumeCreateSession!: () => void;
    const createSessionStarted = new Promise<void>((resolve) => {
      markCreateSessionStarted = resolve;
    });
    const createSessionPaused = new Promise<void>((resolve) => {
      resumeCreateSession = resolve;
    });
    pendingCreateSession = {
      completion: createSessionPaused,
      signalStarted: markCreateSessionStarted,
    };

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
    });
    const capturedDraft = useSessionUIStore.getState().newSessionDraft;

    const materialization = materializeOpenDraftSession(
      {
        providerID: "provider-alpha",
        modelID: "model-alpha",
        agent: "agent-alpha",
      },
      capturedDraft,
    );

    await createSessionStarted;

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/beta",
    });
    expect(activeConfig).toEqual({
      directory: "/projects/beta",
      providerID: "provider-beta",
      modelID: "model-beta",
      agent: "agent-beta",
    });

    resumeCreateSession();
    await materialization;
    pendingCreateSession = null;

    expect(configActivationCalls).toEqual(["/projects/alpha", "/projects/beta"]);
    expect(activeConfig).toEqual({
      directory: "/projects/beta",
      providerID: "provider-beta",
      modelID: "model-beta",
      agent: "agent-beta",
    });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe("/projects/beta");
  });

  test("does not let stale config defaults from draft A reset draft B", async () => {
    let resumeAlphaActivation!: () => void;
    const alphaActivationPaused = new Promise<void>((resolve) => {
      resumeAlphaActivation = resolve;
    });
    pendingConfigActivation = {
      directory: "/projects/alpha",
      completion: alphaActivationPaused,
    };
    mockProjects = [
      { id: "project-alpha", path: "/projects/alpha", defaultModel: "provider-alpha/model-alpha" },
      { id: "project-beta", path: "/projects/beta", defaultModel: "provider-beta/model-beta" },
    ];

    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: "project-alpha",
      directoryOverride: "/projects/alpha",
    });

    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: "project-beta",
      directoryOverride: "/projects/beta",
    });
    const draftB = useSessionUIStore.getState().newSessionDraft;

    await Promise.resolve();
    await Promise.resolve();
    expect(defaultSelectionCalls).toEqual([
      { projectDefaultModel: "provider-beta/model-beta" },
    ]);

    resumeAlphaActivation();
    await Promise.resolve();
    await Promise.resolve();

    expect(defaultSelectionCalls).toEqual([
      { projectDefaultModel: "provider-beta/model-beta" },
    ]);
    expect(useSessionUIStore.getState().newSessionDraft.draftToken).toBe(draftB.draftToken);
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe("/projects/beta");
  });

  test("guarded draft target and bootstrap mutations ignore stale A and refine live B", () => {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
      bootstrapPendingDirectory: "/projects/alpha-preview",
    });
    const draftA = useSessionUIStore.getState().newSessionDraft;

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/beta",
      bootstrapPendingDirectory: "/projects/beta-preview",
    });
    const draftB = useSessionUIStore.getState().newSessionDraft;

    useSessionUIStore.getState().overrideNewSessionDraftTarget({
      directoryOverride: "/projects/alpha-worktree",
      bootstrapPendingDirectory: "/projects/alpha-worktree",
    }, draftA);
    useSessionUIStore.getState().setDraftBootstrapPendingDirectory(null, draftA);

    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe("/projects/beta");
    expect(useSessionUIStore.getState().newSessionDraft.bootstrapPendingDirectory).toBe("/projects/beta-preview");

    useSessionUIStore.getState().overrideNewSessionDraftTarget({
      directoryOverride: "/projects/beta-worktree",
      bootstrapPendingDirectory: "/projects/beta-worktree",
    }, draftB);
    useSessionUIStore.getState().setDraftBootstrapPendingDirectory("/projects/beta-ready", draftB);

    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe("/projects/beta-worktree");
    expect(useSessionUIStore.getState().newSessionDraft.bootstrapPendingDirectory).toBe("/projects/beta-ready");
    expect(useSessionUIStore.getState().newSessionDraft.draftToken).toBe(draftB.draftToken);
  });

  test("pending worktree refinement materializes the same logical draft", async () => {
    const requestId = createPendingDraftWorktreeRequest();
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
      pendingWorktreeRequestId: requestId,
    });
    const capturedDraft = useSessionUIStore.getState().newSessionDraft;

    const materialization = materializeOpenDraftSession(
      {
        providerID: "provider-alpha",
        modelID: "model-alpha",
        agent: "agent-alpha",
      },
      capturedDraft,
    );

    resolvePendingDraftWorktreeRequest(requestId, "/projects/alpha-worktree");
    const created = await materialization;

    expect(created?.sessionId).toBe("ses_materialized_2222");
    expect(createSessionCalls).toEqual([
      {
        title: undefined,
        directory: "/projects/alpha-worktree",
        parentID: null,
      },
    ]);
    expect(configActivationCalls).toEqual(["/projects/alpha", "/projects/alpha-worktree"]);
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_materialized_2222");
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe("/projects/alpha-worktree");
  });

  test("draftSnapshot materialization preserves an unrelated newer draft", async () => {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
      targetFolderId: "folder-alpha",
    });
    const draftSnapshot = useSessionUIStore.getState().newSessionDraft;

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/beta",
      targetFolderId: "folder-beta",
    });

    await useSessionUIStore.getState().sendMessage(
      "hello from captured draft",
      "provider-x",
      "model-y",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { draftSnapshot },
    );

    const liveDraft = useSessionUIStore.getState().newSessionDraft;
    expect(liveDraft.open).toBe(true);
    expect(liveDraft.directoryOverride).toBe("/projects/beta");
    expect(liveDraft.targetFolderId).toBe("folder-beta");
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
  });

  test("createSession does not inherit a folder from an unrelated live draft", async () => {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
      targetFolderId: "folder-alpha",
    });

    await useSessionUIStore.getState().createSession(
      "independent session",
      "/projects/beta",
      null,
    );

    expect(folderAssignmentCalls).toHaveLength(0);
  });


});
