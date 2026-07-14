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

const optimisticSendCalls: Array<{ sessionId: string }> = [];
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null }> = [];
const folderAssignmentCalls: Array<{ directory: string; folderId: string; sessionId: string }> = [];

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
      currentAgentName: "agent-default",
      agents: [],
      activateDirectory: mock(() => Promise.resolve()),
      applyDefaultModelAgentSelection: mock(() => undefined),
    }),
  },
}));

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [],
      activeProjectId: null,
      getActiveProject: () => null,
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
      consume: () => ({ armed: false, objectiveOverride: null }),
    }),
    subscribe: () => () => undefined,
  },
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
      getSessionAgentSelection: () => null,
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
      return { id: "ses_materialized_2222", directory };
    },
  ),
  deleteSession: mock(async () => true),
  archiveSession: mock(async () => true),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async (params: { sessionId: string }) => {
    optimisticSendCalls.push({ sessionId: params.sessionId });
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

const { useSessionUIStore } = await import("../session-ui-store");

describe("Issue #2222 — sendMessage reads live currentSessionId", () => {
  beforeEach(() => {
    optimisticSendCalls.length = 0;
    createSessionCalls.length = 0;
    folderAssignmentCalls.length = 0;

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

    // Goal arm store is already in its default state (armed: false) via mock
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

  // ---------------------------------------------------------------------------
  // Scenario 4 — Draft materializes correctly when no selection change
  // ---------------------------------------------------------------------------
  test("draft materializes and routes correctly when no sidebar selection change occurs", async () => {
    // Arrange: open a new session draft
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
    });

    // Act: sendMessage is called without any intervening selection change
    await useSessionUIStore.getState().sendMessage(
      "hello world",
      "provider-x",
      "model-y",
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
  // Scenario 5 — Draft snapshot in sendMessage options bypasses live draft state
  // ---------------------------------------------------------------------------
  test("draftSnapshot in sendMessage options routes to materialized session when draft was closed during async gap", async () => {
    // Step 1: Open a draft
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/projects/alpha",
      targetFolderId: "folder-alpha",
    });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);

    // Step 2: Capture the draft state before the async gap
    const capturedDraft = { ...useSessionUIStore.getState().newSessionDraft };

    // Step 3: Simulate the async gap — user clicks an existing session in the
    // sidebar, which closes the draft and activates session-old
    useSessionUIStore.getState().closeNewSessionDraft();
    useSessionUIStore.getState().setCurrentSession(
      "session-old",
      "/projects/alpha",
    );
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe("session-old");

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

    // Assert: message was routed to the materialized session, NOT to session-old
    expect(optimisticSendCalls.some(c => c.sessionId === "ses_materialized_2222")).toBe(true);
    expect(optimisticSendCalls.some(c => c.sessionId === "session-old")).toBe(false);

    // The captured draft owns its folder target as well, even though the live
    // draft was closed before sendMessage materialized the new session.
    expect(folderAssignmentCalls.some((call) => (
      call.directory === "/projects/alpha"
      && call.folderId === "folder-alpha"
      && call.sessionId === "ses_materialized_2222"
    ))).toBe(true);

    // Assert: currentSessionId was updated to the materialized session
    expect(useSessionUIStore.getState().currentSessionId).toBe(
      "ses_materialized_2222",
    );
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
