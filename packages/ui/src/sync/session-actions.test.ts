import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { FormRequest } from "@/lib/opencode/model"
import type { InputState } from "./input-store"

// Records the client calls the actions make. The actions talk to
// `opencodeClient` only: OpenCode's own SDK never reaches this layer.
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const registeredSessionDirectories: Array<{ sessionID: string; directory: string }> = []
let formReplyError: unknown | null = null
let formCancelError: unknown | null = null
let permissionReplyError: unknown | null = null
const sessionMessageRecords = new Map<string, Array<{ info: Message; parts: Part[] }>>()
const sessionRecords = new Map<string, Session>()
const failingRevertSessionIds = new Set<string>()
let sessionDeleteError: unknown | null = null
let sessionForkResult: Session | null = null
let sessionForkError: Error | null = null
let beforeSessionForkResolve: (() => void) | null = null
const selectedSessions: Array<{ sessionId: string | null; directoryHint?: string | null }> = []
let beforeSessionDeleteResolve: ((sessionId: string) => void) | null = null
const sessionMoveErrorsById = new Map<string, Error>()
let globalHasLoaded = true
const deletedChatDirectories: string[] = []
const globalUpsertedSessions: unknown[] = []
const globalUpsertedSessionBatches: Session[][] = []
const globalRemovedSessionIds: string[] = []
// Sessions this client is holding. `archiveSessions` reads them to decide which
// sessions can be archived by the server in one batch.
let globalActiveSessions: Session[] = []
const openchamberRouteRequests: Array<{ path: string; body: Record<string, unknown> }> = []
// Lets a test switch runtime while the archive/unarchive request is in flight.
let beforeArchiveRouteResolve: ((path: string) => void) | null = null
let archiveBatchResponse: { status: number; body: unknown } = {
  status: 404,
  body: { error: 'not found' },
}
let unarchiveBatchResponse: { status: number; body: unknown } = {
  status: 404,
  body: { error: 'not found' },
}
const deletedCleanupIdentities: Array<{ runtimeKey: string; directory: string; sessionId: string }> = []
const movedSessionDirectories: Array<{ sessionID: string; directory: string }> = []
const globalArchivedSessions: Session[] = []
let runtimeKey = "default-runtime"
const AMBIGUOUS_TRANSPORT_FAILURE = Symbol("ambiguous-transport-failure")

const notFound = (kind: string) => Object.assign(new Error(`${kind}NotFoundError`), { status: 404 })

mock.module("@/lib/opencode/client", () => ({
  ascendingId: (prefix: string) => `${prefix}_${(idCounter += 1).toString(16).padStart(12, "0")}`,
  opencodeClient: {
    getDirectory: () => "/test/project",
    getSession: mock(async (sessionId: string, directory?: string | null): Promise<Session> => {
      replyCalls.push({ method: "session.get", params: { sessionID: sessionId, directory } })
      const record = sessionRecords.get(sessionId)
      if (!record) throw notFound("Session")
      return record
    }),
    getSessionMessages: mock(async (
      sessionId: string,
      options?: { limit?: number; cursor?: string },
      directory?: string | null,
    ) => {
      replyCalls.push({ method: "session.messages", params: { sessionID: sessionId, directory, limit: options?.limit } })
      return { items: sessionMessageRecords.get(sessionId) ?? [], cursor: {} }
    }),
    createSession: mock(async (params: Record<string, unknown>, directory?: string | null): Promise<Session> => {
      replyCalls.push({ method: "session.create", params: { ...params, directory } })
      return sessionRecords.get("created") ?? ({ id: "created" } as Session)
    }),
    deleteSession: mock(async (sessionId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.delete", params: { sessionID: sessionId, directory } })
      // Lets a test switch runtime while the delete is in flight, so the action
      // observes the change only after awaiting (or catching) the response.
      beforeSessionDeleteResolve?.(sessionId)
      if (sessionDeleteError) throw sessionDeleteError
      return true
    }),
    renameSession: mock(async (sessionId: string, title: string, directory?: string | null) => {
      replyCalls.push({ method: "session.rename", params: { sessionID: sessionId, title, directory } })
      const record = sessionRecords.get(sessionId)
      if (record) sessionRecords.set(sessionId, { ...record, title })
    }),
    moveSession: mock(async (sessionId: string, directory: string) => {
      replyCalls.push({ method: "session.move", params: { sessionID: sessionId, directory } })
      const error = sessionMoveErrorsById.get(sessionId)
      if (error) throw error
    }),
    abortSession: mock(async (sessionId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.abort", params: { sessionID: sessionId, directory } })
      return true
    }),
    stageRevert: mock(async (sessionId: string, messageId: string, options?: { directory?: string | null }) => {
      replyCalls.push({
        method: "session.revert.stage",
        params: { sessionID: sessionId, messageID: messageId, directory: options?.directory },
      })
      if (failingRevertSessionIds.has(sessionId)) throw new Error("session.revert.stage failed (500): rejected")
      // Mirror the server: staging records the marker on the session, which is
      // what the action re-reads through `getSession` afterwards.
      const record = sessionRecords.get(sessionId)
      sessionRecords.set(sessionId, { ...(record ?? sessionFixture(sessionId)), revert: { messageID: messageId } })
      return { messageID: messageId }
    }),
    commitRevert: mock(async (sessionId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.revert.commit", params: { sessionID: sessionId, directory } })
    }),
    forkSession: mock(async (
      sessionId: string,
      options?: { before?: string; directory?: string | null },
    ): Promise<Session> => {
      replyCalls.push({
        method: "session.fork",
        params: { sessionID: sessionId, messageID: options?.before, directory: options?.directory },
      })
      beforeSessionForkResolve?.()
      if (sessionForkError) throw sessionForkError
      if (!sessionForkResult) throw new Error("Missing fork session fixture")
      return sessionForkResult
    }),
    replyToPermission: mock(async (
      sessionId: string,
      requestId: string,
      reply: string,
      options?: { directory?: string | null },
    ) => {
      replyCalls.push({
        method: "permission.reply",
        params: { sessionID: sessionId, requestID: requestId, reply, directory: options?.directory },
      })
      if (permissionReplyError) throw permissionReplyError
      return true
    }),
    replyToForm: mock(async (
      sessionId: string,
      formId: string,
      answer: Record<string, unknown>,
      directory?: string | null,
    ) => {
      replyCalls.push({ method: "form.reply", params: { sessionID: sessionId, formID: formId, answer, directory } })
      if (formReplyError) throw formReplyError
      return true
    }),
    cancelForm: mock(async (sessionId: string, formId: string, directory?: string | null) => {
      replyCalls.push({ method: "form.cancel", params: { sessionID: sessionId, formID: formId, directory } })
      if (formCancelError) throw formCancelError
      return true
    }),
  },
}))

let idCounter = 0

// Mock useConfigStore
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

// Mock useSessionUIStore
mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: (sessionId: string) => {
        if (sessionId === "session-a") return "/test/project"
        if (sessionId === "session-b") return "/other/project"
        return null
      },
      currentSessionId: null,
      setCurrentSession: (sessionId: string | null, directoryHint?: string | null) => {
        selectedSessions.push({ sessionId, directoryHint })
      },
      setWorktreeMetadata: () => {},
      setSessionDirectory: (sessionID: string, directory: string) => {
        movedSessionDirectories.push({ sessionID, directory })
      },
    }),
  },
}))

// Mock useInputStore
const inputState: Pick<InputState,
  "pendingComposerRestore" | "pendingInputText" | "pendingInputMode" | "attachedFiles"
  | "clearAttachedFiles" | "addRestoredAttachment"
> = {
  pendingComposerRestore: null,
  pendingInputText: "",
  pendingInputMode: "replace",
  attachedFiles: [],
  clearAttachedFiles: () => {
    inputState.attachedFiles = []
  },
  addRestoredAttachment: (attachment) => {
    inputState.attachedFiles = [...inputState.attachedFiles, {
      id: attachment.url,
      file: new File([], attachment.filename, { type: attachment.mimeType }),
      dataUrl: attachment.url,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      size: 0,
      source: "server",
    }]
  },
}

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => inputState,
    setState: (patch: Partial<typeof inputState>) => Object.assign(inputState, patch),
  },
}))

mock.module("@/stores/useInlineCommentDraftStore", () => ({
  useInlineCommentDraftStore: {
    getState: () => ({
      getDrafts: () => [],
      clearDrafts: () => {},
      restoreDrafts: () => {},
      addDraft: () => {},
    }),
  },
}))

mock.module("@/lib/messages/contextParts", () => ({
  draftFromContextPayload: () => null,
  readContextPart: () => null,
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: (session: SessionWithDirectory) => session.directory ?? session.project?.worktree ?? null,
  mergeSessionDirectoryMetadata: (incoming: Session, existing?: SessionWithDirectory | null): SessionWithDirectory => {
    if (!existing) return incoming as SessionWithDirectory
    const next = { ...(incoming as SessionWithDirectory) }
    if (!next.directory && existing.directory) next.directory = existing.directory
    if (!next.project && existing.project) next.project = existing.project
    if (next.project && !next.project.worktree && existing.project?.worktree) {
      next.project = { ...next.project, worktree: existing.project.worktree }
    }
    return next
  },
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: globalActiveSessions,
      archivedSessions: globalArchivedSessions,
      hasLoaded: globalHasLoaded,
      upsertSession: (session: unknown) => {
        globalUpsertedSessions.push(session)
      },
      upsertSessions: (sessions: Session[]) => {
        globalUpsertedSessionBatches.push(sessions)
        globalUpsertedSessions.push(...sessions)
      },
      removeSessions: (ids: Iterable<string>) => {
        globalRemovedSessionIds.push(...ids)
      },
    }),
  },
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: async (path: string, init?: { body?: string }) => {
    const payload = JSON.parse(String(init?.body ?? "{}"))
    openchamberRouteRequests.push({ path, body: payload })
    beforeArchiveRouteResolve?.(path)
    const answer = path.endsWith("/unarchive") ? unarchiveBatchResponse : archiveBatchResponse
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    })
  },
}))

mock.module("./global-session-status", () => ({
  useGlobalSessionStatusStore: {
    getState: () => ({
      statusById: new Map<string, { type: string }>(),
    }),
  },
}))

mock.module("./session-message-loader", () => ({
  getImperativeSessionMessageLoader: () => ({
    invalidateSession: () => {},
    ensure: async () => {},
    refreshTail: async () => {},
    getSnapshot: () => ({ status: "ready" as const }),
  }),
}))

mock.module("../lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
  switchRuntimeEndpoint: ({ runtimeKey: nextRuntimeKey }: { runtimeKey: string }) => {
    runtimeKey = nextRuntimeKey
  },
  subscribeRuntimeEndpointWillChange: () => () => {},
  subscribeRuntimeEndpointChanged: () => () => {},
}))

mock.module("@/lib/relay/transport-error", () => ({
  markAmbiguousTransportFailure: (error: Error) => Object.assign(error, { [AMBIGUOUS_TRANSPORT_FAILURE]: true }),
  isAmbiguousTransportFailure: (error: unknown) => Boolean(
    error
    && typeof error === "object"
    && (error as { [AMBIGUOUS_TRANSPORT_FAILURE]?: boolean })[AMBIGUOUS_TRANSPORT_FAILURE],
  ),
}))

mock.module("./send-failure-classification", () => ({
  getErrorStatus: (error: unknown) => {
    if (!error || typeof error !== "object") return null
    const direct = (error as { status?: unknown }).status
    if (typeof direct === "number") return direct
    const response = (error as { response?: { status?: unknown } }).response
    return typeof response?.status === "number" ? response.status : null
  },
  isAmbiguousSendFailure: (error: unknown) => {
    if (error && typeof error === "object" && (error as { [AMBIGUOUS_TRANSPORT_FAILURE]?: boolean })[AMBIGUOUS_TRANSPORT_FAILURE]) {
      return true
    }

    const status = error && typeof error === "object"
      ? ((error as { status?: unknown }).status ?? (error as { response?: { status?: unknown } }).response?.status)
      : undefined
    if (status === 503 || status === 504 || status === 408) return true
    if (error instanceof TypeError) return true
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true

    const message = error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : ""
    return message.includes("timeout")
      || message.includes("timed out")
      || message.includes("failed to fetch")
      || message.includes("networkerror")
      || message.includes("network error")
      || message.includes("gateway timeout")
      || message.includes("econnreset")
      || message.includes("socket hang up")
  },
}))

mock.module("@/lib/chatDirectories", () => ({
  deleteChatDirectory: async (directory: string) => {
    deletedChatDirectories.push(directory)
  },
}))

mock.module("./session-deletion-cleanup", () => ({
  cleanupPersistedSessionState: (identity: { runtimeKey: string; directory: string; sessionId: string }) => {
    deletedCleanupIdentities.push(identity)
  },
}))

mock.module("./sync-refs", () => ({
  getSyncSessionDirectory: () => null,
  registerSessionDirectory: (sessionID: string, directory: string) => {
    registeredSessionDirectories.push({ sessionID, directory })
  },
}))

import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { Message, Part, Session } from "@/lib/opencode/model"

type OptimisticAddCall = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveCall = { sessionID: string; directory?: string | null; messageID: string }
type SessionWithDirectory = Session & {
  directory?: string | null
  project?: { worktree?: string | null }
}

type TestStoreApi<T> = {
  getState: () => T
  setState: (patch: Partial<T> | ((state: T) => Partial<T>)) => void
}

function createStore(
  permissions: Record<string, PermissionRequest[]>,
  state?: Partial<DirectoryStore>,
): TestStoreApi<DirectoryStore> {
  let currentState: DirectoryStore = {
    ...INITIAL_STATE,
    ...state,
    permission: permissions,
    patch: (partial) => setState(partial),
    replace: (next) => {
      currentState = { ...currentState, ...next }
    },
  }

  function setState(patch: Partial<DirectoryStore> | ((current: DirectoryStore) => Partial<DirectoryStore>)) {
    const nextPatch = typeof patch === "function" ? patch(currentState) : patch
    currentState = { ...currentState, ...nextPatch }
  }

  return {
    getState: () => currentState,
    setState,
  }
}

function createChildStores(entries: Array<[string, TestStoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("./child-store").ChildStoreManager
}

describe("moveSessionToDirectory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    registeredSessionDirectories.length = 0
    movedSessionDirectories.length = 0
    globalUpsertedSessions.length = 0
  })

  test("moves through the control plane and reconciles directory stores", async () => {
    const message = {
      id: "message-a",
      sessionID: "session-a",
      role: "user",
      time: { created: 1 },
    } as Message
    const part = {
      id: "part-a",
      messageID: "message-a",
      type: "text",
      text: "hello",
    } as Part
    const source = createStore({ "session-a": [{ id: "permission-a" }] as never }, {
      session: [{ id: "session-a", title: "Move me", directory: "/source" } as Session],
      sessionTotal: 1,
      session_status: { "session-a": { type: "idle" } },
      form: { "session-a": [{ id: "form-a" }] as never },
      message: { "session-a": [message] },
      part: { "message-a": [part] },
    })
    const destination = createStore({})
    const childStores = createChildStores([["/source", source], ["/destination", destination]])
    const { moveSessionToDirectory, setActionRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/source")

    await moveSessionToDirectory(source.getState().session[0], "/source", "/destination")

    expect(replyCalls.filter((call) => call.method === "session.move")).toEqual([{
      method: "session.move",
      params: { sessionID: "session-a", directory: "/destination" },
    }])
    expect(source.getState().session).toHaveLength(0)
    expect(source.getState().sessionTotal).toBe(0)
    expect(source.getState().session_status["session-a"]).toBe(undefined)
    expect(source.getState().permission["session-a"]).toBe(undefined)
    expect(source.getState().form["session-a"]).toBe(undefined)
    expect(source.getState().message["session-a"]).toBe(undefined)
    expect(source.getState().part["message-a"]).toBe(undefined)
    expect(destination.getState().session[0]?.id).toBe("session-a")
    expect(destination.getState().sessionTotal).toBe(1)
    expect((destination.getState().session[0] as SessionWithDirectory)?.directory).toBe("/destination")
    expect(destination.getState().session_status["session-a"]?.type).toBe("idle")
    expect(destination.getState().permission["session-a"]?.[0]?.id).toBe("permission-a")
    expect(destination.getState().form["session-a"]?.[0]?.id).toBe("form-a")
    expect(destination.getState().message["session-a"]?.[0]?.id).toBe("message-a")
    expect(destination.getState().part["message-a"]?.[0]?.id).toBe("part-a")
    expect(registeredSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/destination" }])
    expect(movedSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/destination" }])
    expect((globalUpsertedSessions[0] as SessionWithDirectory).directory).toBe("/destination")

    await moveSessionToDirectory(destination.getState().session[0], "/destination", "/source")

    expect(replyCalls.filter((call) => call.method === "session.move")[1]?.params.directory).toBe("/source")
    expect(source.getState().session[0]?.id).toBe("session-a")
    expect(source.getState().message["session-a"]?.[0]?.id).toBe("message-a")
    expect(source.getState().part["message-a"]?.[0]?.id).toBe("part-a")
    expect(destination.getState().session).toHaveLength(0)
    expect(destination.getState().message["session-a"]).toBe(undefined)
    expect(destination.getState().part["message-a"]).toBe(undefined)
  })
})

describe("confirmed session removal", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    globalRemovedSessionIds.length = 0
    deletedCleanupIdentities.length = 0
    sessionDeleteError = null
    runtimeKey = "default-runtime"
    beforeSessionDeleteResolve = null
    beforeArchiveRouteResolve = null
    globalUpsertedSessionBatches.length = 0
    globalActiveSessions = []
    openchamberRouteRequests.length = 0
    archiveBatchResponse = { status: 404, body: { error: 'not found' } }
    globalHasLoaded = true
    deletedChatDirectories.length = 0
  })

  test("does not remove live or persisted state when delete fails", async () => {
    sessionDeleteError = new Error("delete failed")
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(false)
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalRemovedSessionIds).toEqual([])
    expect(deletedCleanupIdentities).toEqual([])
  })

  test("cleans persisted state after the server confirms deletion", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(true)
    expect(source.getState().session).toEqual([])
    expect(globalRemovedSessionIds).toEqual(["session-a"])
    expect(deletedCleanupIdentities).toHaveLength(1)
    expect({
      directory: deletedCleanupIdentities[0]?.directory,
      sessionId: deletedCleanupIdentities[0]?.sessionId,
    }).toEqual({ directory: "/test/project", sessionId: "session-a" })
  })

  test("scopes persisted cleanup to the runtime captured when the delete started", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://delete-scope.test", runtimeKey: "delete-scope" })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(true)
    // The cleanup identity must carry the captured runtime, which is what lets
    // cleanupPersistedSessionState reject a stale identity instead of comparing
    // the live runtime key with itself.
    expect(deletedCleanupIdentities[0]?.runtimeKey).toBe("delete-scope")
    expect(deletedCleanupIdentities[0]?.runtimeKey).toBe(getRuntimeKey())
  })

  test("rejects a delete response that arrives after a runtime switch", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://delete-runtime-a.test", runtimeKey: "delete-runtime-a" })
    beforeSessionDeleteResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://delete-runtime-b.test", runtimeKey: "delete-runtime-b" })
    }
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(false)
    // Session IDs are not unique across runtimes: committing here could evict an
    // unrelated session and erase its queue, todos, drafts, folders, and pins.
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalRemovedSessionIds).toEqual([])
    expect(deletedCleanupIdentities).toEqual([])
  })

  test("does not treat a 404 as an already-completed deletion after a runtime switch", async () => {
    sessionDeleteError = Object.assign(new Error("not found"), { status: 404 })
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://delete-404-a.test", runtimeKey: "delete-404-a" })
    beforeSessionDeleteResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://delete-404-b.test", runtimeKey: "delete-404-b" })
    }
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    // A 404 only proves "already deleted" for the captured runtime. After a
    // switch it describes the wrong runtime, so it must not commit cleanup.
    expect(await deleteSession("session-a")).toBe(false)
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalRemovedSessionIds).toEqual([])
    expect(deletedCleanupIdentities).toEqual([])
  })

  test("still treats a 404 as an already-completed deletion while the runtime is stable", async () => {
    sessionDeleteError = Object.assign(new Error("not found"), { status: 404 })
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await deleteSession("session-a")).toBe(true)
    expect(source.getState().session).toEqual([])
    expect(globalRemovedSessionIds).toEqual(["session-a"])
    expect(deletedCleanupIdentities).toHaveLength(1)
  })

  test("keeps committed deletions and fails the rest when the runtime changes mid-batch", async () => {
    const source = createStore({}, {
      session: [
        { id: "session-a", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-b", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-c", directory: "/test/project", time: { created: 1 } } as Session,
      ],
    })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://delete-batch-a.test", runtimeKey: "delete-batch-a" })
    beforeSessionDeleteResolve = (sessionId) => {
      if (sessionId === "session-b") {
        switchRuntimeEndpoint({ apiBaseUrl: "http://delete-batch-b.test", runtimeKey: "delete-batch-b" })
      }
    }
    const { deleteSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await deleteSessions(["session-a", "session-b", "session-c"])

    // session-a was committed before the switch; session-b's response is stale
    // and session-c is never attempted, so both are reported as failures.
    expect(result).toEqual({ deletedIds: ["session-a"], failedIds: ["session-b", "session-c"] })
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-b", "session-c"])
    expect(globalRemovedSessionIds).toEqual(["session-a"])
    expect(replyCalls.filter((call) => call.method === "session.delete").map((call) => call.params.sessionID))
      .toEqual(["session-a", "session-b"])
  })

  const chatDirectory = "/home/user/.config/openchamber/chats/2026-09-05/session-abc"
  const chatSession = (id: string, parentID?: string): Session => ({
    id,
    projectID: "project-chats",
    directory: chatDirectory,
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    parentID,
  })

  test("keeps a shared chat directory while another root session still uses it", async () => {
    const root = chatSession("chat-root")
    const fork = chatSession("chat-fork")
    globalActiveSessions = [root, fork]
    const source = createStore({}, { session: [root, fork] })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[chatDirectory, source]]), () => chatDirectory)

    expect(await deleteSession("chat-root")).toBe(true)
    expect(deletedChatDirectories).toEqual([])

    globalActiveSessions = [fork]
    expect(await deleteSession("chat-fork")).toBe(true)
    expect(deletedChatDirectories).toEqual([chatDirectory])
  })

  test("removes the chat directory with its last root even though the root's own subagents share it", async () => {
    const root = chatSession("chat-root")
    const subagent = chatSession("chat-subagent", "chat-root")
    globalActiveSessions = [root, subagent]
    const source = createStore({}, { session: [root, subagent] })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[chatDirectory, source]]), () => chatDirectory)

    expect(await deleteSession("chat-root")).toBe(true)
    expect(deletedChatDirectories).toEqual([chatDirectory])
  })

  test("keeps the chat directory when the global cache cannot prove it is unused", async () => {
    const root = chatSession("chat-root")
    globalActiveSessions = [root]
    globalHasLoaded = false
    const source = createStore({}, { session: [root] })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[chatDirectory, source]]), () => chatDirectory)

    expect(await deleteSession("chat-root")).toBe(true)
    expect(deletedChatDirectories).toEqual([])
  })

  test("does not archive locally until the server returns the archived session", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(false)
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalUpsertedSessions).toEqual([])
  })

  test("moves the session to archived state after server confirmation", async () => {
    archiveBatchResponse = {
      status: 200,
      body: { archived: [{ id: "session-a", archivedAt: 2 }], failedIds: [] },
    }
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(true)
    expect(source.getState().session).toEqual([])
    expect((globalUpsertedSessions[0] as Session)?.time?.archived).toBe(2)
  })

  test("rejects an archive response that arrives after a runtime switch", async () => {
    archiveBatchResponse = {
      status: 200,
      body: { archived: [{ id: "session-a", archivedAt: 2 }], failedIds: [] },
    }
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://archive-runtime-a.test", runtimeKey: "archive-runtime-a" })
    beforeArchiveRouteResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://archive-runtime-b.test", runtimeKey: "archive-runtime-b" })
    }
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(false)
    expect(getRuntimeKey()).toBe("archive-runtime-b")
    // The stale response must not reconcile the runtime the user switched to.
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalUpsertedSessions).toEqual([])
  })

  test("fails the whole batch when the runtime changes while the request is in flight", async () => {
    archiveBatchResponse = {
      status: 200,
      body: {
        archived: [
          { id: "session-a", archivedAt: 2 },
          { id: "session-b", archivedAt: 2 },
        ],
        failedIds: [],
      },
    }
    const source = createStore({}, {
      session: [
        { id: "session-a", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-b", directory: "/test/project", time: { created: 1 } } as Session,
      ],
    })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://archive-batch-a.test", runtimeKey: "archive-batch-a" })
    beforeArchiveRouteResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://archive-batch-b.test", runtimeKey: "archive-batch-b" })
    }
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b"])

    // The archive is one server request now, so a runtime switch mid-flight
    // discards the whole answer instead of leaving part of it applied.
    expect(result.archivedIds).toEqual([])
    expect(result.failedIds).toEqual(["session-a", "session-b"])
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a", "session-b"])
    expect(globalUpsertedSessions).toEqual([])
  })

  test("archives every session when the runtime stays stable", async () => {
    archiveBatchResponse = {
      status: 200,
      body: {
        archived: [
          { id: "session-a", archivedAt: 2 },
          { id: "session-b", archivedAt: 2 },
        ],
        failedIds: [],
      },
    }
    const source = createStore({}, {
      session: [
        { id: "session-a", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-b", directory: "/test/project", time: { created: 1 } } as Session,
      ],
    })
    const { getRuntimeKey } = await import("../lib/runtime-switch")
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b"], {
      expectedRuntimeKey: getRuntimeKey(),
    })

    expect(result).toEqual({ archivedIds: ["session-a", "session-b"], failedIds: [] })
    expect(source.getState().session).toEqual([])
  })
})

describe("archiving a batch through the server", () => {
  const liveSession = (id: string, metadata?: Record<string, unknown>): Session => ({
    id,
    directory: "/test/project",
    time: { created: 1 },
    ...(metadata ? { metadata } : {}),
  } as unknown as Session)

  const archivedSession = (id: string) => ({ id, archivedAt: 2 })

  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    globalUpsertedSessionBatches.length = 0
    globalActiveSessions = []
    openchamberRouteRequests.length = 0
    beforeArchiveRouteResolve = null
    archiveBatchResponse = { status: 404, body: { error: "not found" } }
  })

  test("archives held sessions in one request and reconciles the stores once", async () => {
    globalActiveSessions = [liveSession("session-a"), liveSession("session-b")]
    archiveBatchResponse = {
      status: 200,
      body: { archived: [archivedSession("session-a"), archivedSession("session-b")], failedIds: [] },
    }
    const source = createStore({}, { session: [liveSession("session-a"), liveSession("session-b")] })
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b"])

    expect(result).toEqual({ archivedIds: ["session-a", "session-b"], failedIds: [] })
    expect(openchamberRouteRequests).toHaveLength(1)
    expect(openchamberRouteRequests[0].path).toBe("/api/openchamber/sessions/archive")
    expect(openchamberRouteRequests[0].body).toMatchObject({ directory: "/test/project", ids: ["session-a", "session-b"] })
    // The point of the batch: no per-session SDK call, and one store write for
    // the whole set instead of one per session.
    expect(replyCalls.filter((call) => call.method === "session.rename")).toEqual([])
    expect(globalUpsertedSessionBatches).toHaveLength(1)
    expect(source.getState().session).toEqual([])
    expect(source.getState().sessionRevision).toBe(1)
  })

  test("batches sessions held only by the live directory store", async () => {
    archiveBatchResponse = {
      status: 200,
      body: { archived: [archivedSession("session-a")], failedIds: [] },
    }
    const source = createStore({}, { session: [liveSession("session-a")] })
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a"])

    expect(result).toEqual({ archivedIds: ["session-a"], failedIds: [] })
    expect(openchamberRouteRequests).toHaveLength(1)
    expect(openchamberRouteRequests[0].path).toBe("/api/openchamber/sessions/archive")
    expect(openchamberRouteRequests[0].body).toMatchObject({ directory: "/test/project", ids: ["session-a"] })
    expect(replyCalls.filter((call) => call.method === "session.rename")).toEqual([])
  })

  test("reports the sessions the server could not archive without losing the rest", async () => {
    globalActiveSessions = [liveSession("session-a"), liveSession("session-b")]
    archiveBatchResponse = {
      status: 200,
      body: { archived: [archivedSession("session-a")], failedIds: ["session-b"] },
    }
    const source = createStore({}, { session: [liveSession("session-a"), liveSession("session-b")] })
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b"])

    expect(result).toEqual({ archivedIds: ["session-a"], failedIds: ["session-b"] })
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-b"])
  })

  test("reports every session as failed when the runtime does not serve the route", async () => {
    globalActiveSessions = [liveSession("session-a"), liveSession("session-b")]
    archiveBatchResponse = { status: 501, body: { error: "not supported in VS Code" } }
    const source = createStore({}, { session: [liveSession("session-a"), liveSession("session-b")] })
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b"])

    // Archive is OpenChamber's own route now, so a runtime that does not serve
    // it cannot archive at all — the sessions stay put rather than vanishing
    // locally on an unconfirmed write.
    expect(result.archivedIds).toEqual([])
    expect(result.failedIds.sort()).toEqual(["session-a", "session-b"])
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a", "session-b"])
  })

  test("treats a malformed batch answer as unavailable instead of as an empty success", async () => {
    globalActiveSessions = [liveSession("session-a")]
    archiveBatchResponse = { status: 200, body: { archived: [{ title: "no id" }], failedIds: [] } }
    const source = createStore({}, { session: [liveSession("session-a")] })
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a"])

    expect(result.archivedIds).toEqual([])
    expect(result.failedIds).toEqual(["session-a"])
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
  })

  test("keeps review and btw sessions on the per-session path", async () => {
    const review = liveSession("session-review", { openchamber: { kind: "review", originalSessionID: "session-parent" } })
    const parentWithFork = liveSession("session-parent", { openchamber: { btwSessionID: "session-fork" } })
    globalActiveSessions = [liveSession("session-plain"), review, parentWithFork]
    archiveBatchResponse = {
      status: 200,
      body: { archived: [archivedSession("session-plain")], failedIds: [] },
    }
    const source = createStore({}, { session: [liveSession("session-plain"), review, parentWithFork] })
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    await archiveSessions(["session-plain", "session-review", "session-parent"])

    // Unlinking a partner rewrites another session's metadata, so those two
    // never travel in the shared batch: they each get their own request.
    const archiveRequests = openchamberRouteRequests.filter((request) => request.path.endsWith("/archive"))
    expect(archiveRequests.map((request) => request.body.ids)).toEqual([
      ["session-plain"],
      ["session-review"],
      ["session-parent"],
    ])
  })

  test("does not reconcile a batch answered after a runtime switch", async () => {
    globalActiveSessions = [liveSession("session-a")]
    archiveBatchResponse = {
      status: 200,
      body: { archived: [archivedSession("session-a")], failedIds: [] },
    }
    const source = createStore({}, { session: [liveSession("session-a")] })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://archive-bulk-a.test", runtimeKey: "archive-bulk-a" })
    const capturedRuntimeKey = getRuntimeKey()
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const pending = archiveSessions(["session-a"], { expectedRuntimeKey: capturedRuntimeKey })
    switchRuntimeEndpoint({ apiBaseUrl: "http://archive-bulk-b.test", runtimeKey: "archive-bulk-b" })
    const result = await pending

    expect(result).toEqual({ archivedIds: [], failedIds: ["session-a"] })
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalUpsertedSessionBatches).toEqual([])
  })
})

describe("session restore (unarchive)", () => {
  // The route answers with stamps; the full record comes from the archived
  // list the global store already holds.
  const restored = (id: string, directory: string, archivedAt: number | null = null) => {
    globalArchivedSessions.push({
      id,
      projectID: "project-main",
      directory,
      title: `Title ${id}`,
      time: { created: 1, updated: 1, archived: 5 },
    } as unknown as Session)
    return { id, archivedAt }
  }

  beforeEach(async () => {
    replyCalls.length = 0
    registeredSessionDirectories.length = 0
    movedSessionDirectories.length = 0
    globalUpsertedSessions.length = 0
    globalActiveSessions.length = 0
    globalArchivedSessions.length = 0
    openchamberRouteRequests.length = 0
    beforeArchiveRouteResolve = null
    unarchiveBatchResponse = { status: 404, body: { error: "not found" } }
    runtimeKey = "default-runtime"
    globalHasLoaded = true
    deletedChatDirectories.length = 0
    const { resetSessionOrdering } = await import("./session-ordering")
    resetSessionOrdering()
  })

  test("does not restore locally until the server returns the restored session", async () => {
    const source = createStore({}, { session: [] })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(false)
    expect(globalUpsertedSessions).toEqual([])
    expect(registeredSessionDirectories).toEqual([])
    const { useSessionOrderingStore } = await import("./session-ordering")
    expect(useSessionOrderingStore.getState().rankById.has("session-a")).toBe(false)
  })

  test("upserts the restored session and re-registers its directory after confirmation", async () => {
    unarchiveBatchResponse = { status: 200, body: { restored: [restored("session-a", "/test/project")], failedIds: [] } }
    const source = createStore({}, { session: [] })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(true)
    expect(openchamberRouteRequests).toHaveLength(1)
    expect(openchamberRouteRequests[0].path).toBe("/api/openchamber/sessions/unarchive")
    expect(openchamberRouteRequests[0].body).toMatchObject({ ids: ["session-a"] })
    expect((globalUpsertedSessions[0] as Session)?.time?.archived).toBeUndefined()
    expect((globalUpsertedSessions[0] as Session)?.title).toBe("Title session-a")
    expect(registeredSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
    const { useSessionOrderingStore } = await import("./session-ordering")
    const rank = useSessionOrderingStore.getState().rankById.get("session-a")
    expect(rank ?? 0).toBeGreaterThan(0)
  })

  test("fails when the server keeps the session archived", async () => {
    unarchiveBatchResponse = { status: 200, body: { restored: [restored("session-a", "/test/project", 2)], failedIds: [] } }
    const source = createStore({}, { session: [] })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    // A silent server-side no-op must surface as a failure, not a success toast.
    expect(await unarchiveSession("session-a")).toBe(false)
    expect(globalUpsertedSessions).toEqual([])
    expect(registeredSessionDirectories).toEqual([])
    const { useSessionOrderingStore } = await import("./session-ordering")
    expect(useSessionOrderingStore.getState().rankById.has("session-a")).toBe(false)
  })

  test("fails when the answer omits the session that was asked for", async () => {
    unarchiveBatchResponse = { status: 200, body: { restored: [], failedIds: ["session-a"] } }
    const source = createStore({}, { session: [] })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(false)
    expect(globalUpsertedSessions).toEqual([])
  })

  test("restores a worktree session into its own directory, not the parent project", async () => {
    const worktreeDirectory = "/projects/main/.worktrees/feature-a"
    unarchiveBatchResponse = { status: 200, body: { restored: [restored("session-worktree", worktreeDirectory)], failedIds: [] } }

    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[worktreeDirectory, createStore({})]]), () => worktreeDirectory)

    expect(await unarchiveSession("session-worktree")).toBe(true)
    expect(movedSessionDirectories).toEqual([])
    expect(registeredSessionDirectories).toEqual([{ sessionID: "session-worktree", directory: worktreeDirectory }])
    expect((globalUpsertedSessions[0] as SessionWithDirectory).directory).toBe(worktreeDirectory)
  })

  test("rejects a restore response that arrives after a runtime switch", async () => {
    unarchiveBatchResponse = { status: 200, body: { restored: [restored("session-a", "/test/project")], failedIds: [] } }
    const source = createStore({}, { session: [] })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://restore-runtime-a.test", runtimeKey: "restore-runtime-a" })
    beforeArchiveRouteResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://restore-runtime-b.test", runtimeKey: "restore-runtime-b" })
    }
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(false)
    expect(getRuntimeKey()).toBe("restore-runtime-b")
    // The stale response must not reconcile the runtime the user switched to.
    expect(globalUpsertedSessions).toEqual([])
    expect(registeredSessionDirectories).toEqual([])
    const { useSessionOrderingStore } = await import("./session-ordering")
    expect(useSessionOrderingStore.getState().rankById.has("session-a")).toBe(false)
  })

  test("keeps confirmed sessions and fails the rest when the runtime changes mid-batch", async () => {
    unarchiveBatchResponse = {
      status: 200,
      body: {
        restored: [
          restored("session-a", "/test/project"),
          restored("session-b", "/test/project"),
        ],
        failedIds: [],
      },
    }
    const source = createStore({}, { session: [] })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://restore-batch-a.test", runtimeKey: "restore-batch-a" })
    let requests = 0
    beforeArchiveRouteResolve = () => {
      requests += 1
      if (requests === 2) {
        switchRuntimeEndpoint({ apiBaseUrl: "http://restore-batch-b.test", runtimeKey: "restore-batch-b" })
      }
    }
    const { unarchiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await unarchiveSessions(["session-a", "session-b", "session-c"])

    // session-a was confirmed before the switch and stays restored; session-b's
    // response is stale and session-c is never attempted, so both are reported
    // as failures instead of being silently dropped.
    expect(result).toEqual({ restoredIds: ["session-a"], failedIds: ["session-b", "session-c"] })
    expect(globalUpsertedSessions).toHaveLength(1)
    // session-c must not reach the server after the runtime changed.
    expect(openchamberRouteRequests.map((request) => request.body.ids)).toEqual([["session-a"], ["session-b"]])
  })
})

describe("fetchMessagesForSession startup race", () => {
  test("does not reject before sync action refs are initialized", async () => {
    const { fetchMessagesForSession } = await import("./session-actions")

    let error: unknown = null
    try {
      await fetchMessagesForSession("session-a", "/test/project")
    } catch (err) {
      error = err
    }

    expect(error).toBe(null)
  })
})

describe("updateSessionTitle live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    sessionRecords.clear()
  })

  test("updates the live directory store after renaming", async () => {
    const oldSession = { ...sessionFixture("session-a"), title: "Old Title" }
    const sessionStore = createStore({}, { session: [oldSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionRecords.set("session-a", oldSession)

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(childStores, () => "/current/project")

    await updateSessionTitle("session-a", "New Title")

    const renameCall = replyCalls.find((call) => call.method === "session.rename")
    expect(renameCall?.params.sessionID).toBe("session-a")
    expect(renameCall?.params.title).toBe("New Title")
    expect(renameCall?.params.directory).toBe("/test/project")
    // `session.update` answers with nothing, so the published record is the
    // re-read session rather than a locally patched copy.
    expect((globalUpsertedSessions[0] as Session)?.title).toBe("New Title")
    expect(sessionStore.getState().session[0].title).toBe("New Title")
  })

  test("renames a worktree session against its own directory, not the project root that indexes its status", async () => {
    const worktreeSession = { ...sessionFixture("session-wt"), directory: "/test/project/.worktrees/feature", title: "Old Title" }
    globalActiveSessions = [worktreeSession]
    sessionRecords.set("session-wt", worktreeSession)
    // The project root's store knows the session only through the status index
    // it receives for its worktrees; the session record itself lives elsewhere.
    const rootStore = createStore({}, { session: [], session_status: { "session-wt": { type: "idle" } } })
    const childStores = createChildStores([["/test/project", rootStore]])

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await updateSessionTitle("session-wt", "New Title")

    const renameCall = replyCalls.find((call) => call.method === "session.rename")
    expect(renameCall?.params.directory).toBe("/test/project/.worktrees/feature")
    globalActiveSessions = []
  })
})

describe("optimisticSend target directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes the prompt directory to optimistic state during session switch races", async () => {
    const currentStore = createStore({})
    const targetStore = createStore({})
    const childStores = createChildStores([
      ["/current/project", currentStore],
      ["/target/project", targetStore],
    ])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/current/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    await optimisticSend({
      sessionId: "session-new",
      directory: "/target/project",
      content: "hello",
      send: async (messageID) => {
        sentMessageID = messageID
      },
    })

    expect(optimisticAdd).not.toBeNull()
    const add = optimisticAdd as unknown as OptimisticAddCall
    expect(add.directory).toBe("/target/project")
    expect(add.sessionID).toBe("session-new")
    expect(add.message.id).toBe(sentMessageID)
    expect(optimisticRemove).toBe(null)
    expect(targetStore.getState().session_status["session-new"]?.type).toBe("busy")
    expect(currentStore.getState().session_status["session-new"]).toBe(undefined)
  })

  test("commits the new branch locally and discards its optimistic shadow when sending after a revert", async () => {
    const retainedMessage = { id: "msg_ffffffffffffRetained", role: "user", sessionID: "session-reverted", time: { created: 1 } } as Message
    const revertedMessage = { id: "msg_000000000000Reverted", role: "user", sessionID: "session-reverted", time: { created: 2 } } as Message
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: revertedMessage.id } } as Session],
      message: { "session-reverted": [retainedMessage, revertedMessage] },
      part: { [revertedMessage.id]: [{ id: "part_2", type: "text", text: "old branch" } as Part] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticMessage: Message | null = null
    const optimisticShadow = new Set([revertedMessage.id])

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticMessage = input.message
        optimisticShadow.add(input.message.id)
        targetStore.setState((state) => ({
          message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message] },
          part: { ...state.part, [input.message.id]: input.parts },
        }))
      },
      () => {},
      (input) => optimisticShadow.delete(input.messageID),
    )

    await optimisticSend({
      sessionId: "session-reverted",
      directory: "/target/project",
      content: "new branch",
      send: async () => {},
    })

    expect(targetStore.getState().session[0].revert).toBe(undefined)
    expect(targetStore.getState().message["session-reverted"].map((message) => message.id)).toEqual([
      retainedMessage.id,
      (optimisticMessage as unknown as Message).id,
    ])
    expect(targetStore.getState().part[revertedMessage.id]).toBe(undefined)
    expect(optimisticShadow.has(revertedMessage.id)).toBe(false)
    expect(optimisticShadow.has((optimisticMessage as unknown as Message).id)).toBe(true)
  })

  test("restores the reverted branch when sending fails", async () => {
    const retainedMessage = { id: "msg_ffffffffffffRetained", role: "user", sessionID: "session-reverted", time: { created: 1 } } as Message
    const revertedMessage = { id: "msg_000000000000Reverted", role: "user", sessionID: "session-reverted", time: { created: 2 } } as Message
    const revertedPart = { id: "part_2", type: "text", text: "old branch" } as Part
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: revertedMessage.id } } as Session],
      message: { "session-reverted": [retainedMessage, revertedMessage] },
      part: { [revertedMessage.id]: [revertedPart] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => targetStore.setState((state) => ({
        message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message] },
        part: { ...state.part, [input.message.id]: input.parts },
      })),
      (input) => targetStore.setState((state) => ({
        message: { ...state.message, [input.sessionID]: (state.message[input.sessionID] ?? []).filter((message) => message.id !== input.messageID) },
        part: Object.fromEntries(Object.entries(state.part).filter(([messageID]) => messageID !== input.messageID)),
      })),
    )

    await expect(optimisticSend({
      sessionId: "session-reverted",
      directory: "/target/project",
      content: "new branch",
      send: async () => { throw new Error("rejected") },
    })).rejects.toThrow("rejected")

    expect(targetStore.getState().session[0].revert?.messageID).toBe(revertedMessage.id)
    expect(targetStore.getState().message["session-reverted"]).toEqual([retainedMessage, revertedMessage])
    expect(targetStore.getState().part[revertedMessage.id]).toEqual([revertedPart])
  })

  test("runs appendSubmissions before revert cleanup and optimistic insertion", async () => {
    const revertedMessage = { id: "msg_000000000000Reverted", role: "user", sessionID: "session-reverted", time: { created: 2 } } as Message
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: revertedMessage.id } } as Session],
      message: { "session-reverted": [revertedMessage] },
      part: { [revertedMessage.id]: [{ id: "part_2", type: "text", text: "old branch" } as Part] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])
    const callOrder: string[] = []

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {
        callOrder.push("optimistic-add")
      },
      () => {},
      () => {
        callOrder.push("revert-confirm")
      },
    )

    await optimisticSend({
      sessionId: "session-reverted",
      directory: "/target/project",
      content: "new branch",
      appendSubmissions: () => {
        callOrder.push("append")
      },
      send: async () => {},
    })

    expect(callOrder).toEqual(["append", "revert-confirm", "optimistic-add"])
  })

  test("runs appendSubmissions once for a definite rejection", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let appendCalls = 0

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      () => {},
    )

    await expect(optimisticSend({
      sessionId: "session-rejected",
      directory: "/target/project",
      content: "hello",
      appendSubmissions: () => {
        appendCalls += 1
      },
      send: async () => { throw new Error("rejected") },
    })).rejects.toThrow("rejected")

    expect(appendCalls).toBe(1)
  })

  test("runs appendSubmissions once for an ambiguous confirmation", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let appendCalls = 0

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      () => {},
      () => {},
    )

    await optimisticSend({
      sessionId: "session-confirmed",
      directory: "/target/project",
      content: "hello",
      appendSubmissions: () => {
        appendCalls += 1
      },
      send: async (messageID) => {
        sessionMessageRecords.set("session-confirmed", [{
          info: { id: messageID, role: "user", sessionID: "session-confirmed", time: { created: 1 } },
          parts: [{ id: "server-part", sessionID: "session-confirmed", messageID, type: "text", text: "hello" }],
        }])
        const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
        error.status = 504
        throw error
      },
    })

    expect(appendCalls).toBe(1)
  })

  test("does not run appendSubmissions when the runtime changes before dispatch", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let appendCalls = 0
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      () => {},
    )

    await expect(optimisticSend({
      sessionId: "session-race",
      directory: "/target/project",
      runtimeKey: "runtime-a",
      content: "hello",
      appendSubmissions: () => {
        appendCalls += 1
      },
      send: async () => {},
    })).rejects.toThrow("runtime changed")

    expect(appendCalls).toBe(0)
  })

  test("rolls back a captured send when the runtime changes after optimistic insert", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let finalSendCalled = false
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      (input) => {
        optimisticAdd = input
      },
      (input) => {
        optimisticRemove = input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-race",
        directory: "/target/project",
        runtimeKey: "runtime-a",
        content: "hello",
        onOptimisticInsert: () => {
          expect(getRuntimeKey()).toBe("runtime-a")
          switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
        },
        send: async () => {
          finalSendCalled = true
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("runtime changed")

    expect(optimisticAdd).not.toBeNull()
    expect(finalSendCalled).toBe(false)
    expect(optimisticRemove).not.toBeNull()
    expect((optimisticRemove as unknown as OptimisticRemoveCall).sessionID).toBe("session-race")
    expect(targetStore.getState().session_status["session-race"]?.type).toBe("idle")
  })

  test("confirms an ambiguous send failure with a recent message refetch", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    await optimisticSend({
      sessionId: "session-confirmed",
      directory: "/target/project",
      content: "hello",
      send: async (messageID) => {
        sentMessageID = messageID
        sessionMessageRecords.set("session-confirmed", [{
          info: { id: messageID, role: "user", sessionID: "session-confirmed", time: { created: 1 } },
          parts: [{ id: "server-part", sessionID: "session-confirmed", messageID, type: "text", text: "hello" }],
        }])
        const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
        error.status = 504
        throw error
      },
    })

    expect(optimisticRemove).toBe(null)
    expect((optimisticConfirm as OptimisticRemoveCall | null)?.messageID).toBe(sentMessageID)
    expect(replyCalls.find((call) => call.method === "session.messages")?.params.limit).toBe(30)
    expect(targetStore.getState().message["session-confirmed"]?.[0]?.id).toBe(sentMessageID)
    expect(targetStore.getState().part[sentMessageID]?.[0]?.id).toBe("server-part")
  })

  // Relay tunnel aborts carry no HTTP status and no wording the text-matching
  // heuristic recognizes. Without the transport tag they were classified as
  // definite failures, the accepted prompt was rolled back, and the queue
  // re-sent a message the engine was already answering (#2425).
  test("confirms a tunnel-tagged transport failure that no text heuristic matches", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null
    let sentMessageID = ""

    const { markAmbiguousTransportFailure } = await import("@/lib/relay/transport-error")
    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    await optimisticSend({
      sessionId: "session-tunnel",
      directory: "/target/project",
      content: "hello",
      send: async (messageID) => {
        sentMessageID = messageID
        sessionMessageRecords.set("session-tunnel", [{
          info: { id: messageID, role: "user", sessionID: "session-tunnel", time: { created: 1 } },
          parts: [{ id: "server-part", sessionID: "session-tunnel", messageID, type: "text", text: "hello" }],
        }])
        throw markAmbiguousTransportFailure(new Error("stream aborted by host"))
      },
    })

    expect(optimisticRemove).toBe(null)
    expect((optimisticConfirm as OptimisticRemoveCall | null)?.messageID).toBe(sentMessageID)
    expect(targetStore.getState().message["session-tunnel"]?.[0]?.id).toBe(sentMessageID)
  })

  test("rolls back an ambiguous send failure when recent messages do not contain the sent ID", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticRemove: OptimisticRemoveCall | null = null
    let optimisticConfirm: OptimisticRemoveCall | null = null

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(childStores, () => "/target/project")
    setOptimisticRefs(
      () => {},
      (input) => {
        optimisticRemove = input
      },
      (input) => {
        optimisticConfirm = input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: "session-missing",
        directory: "/target/project",
        content: "hello",
        send: async () => {
          const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
          error.status = 504
          throw error
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((optimisticRemove as OptimisticRemoveCall | null)?.sessionID).toBe("session-missing")
    expect(optimisticConfirm).toBe(null)
    expect(replyCalls.filter((call) => call.method === "session.messages").every((call) => call.params.limit === 30)).toBe(true)
    expect(targetStore.getState().session_status["session-missing"]?.type).toBe("idle")
  })
})

describe("respondToPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory from child store when permission is found", async () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-a",
      action: "bash",
      resources: [],
      metadata: {},
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await respondToPermission("session-a", "perm-1", "once")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-1")
    expect(replyCalls[0].params.reply).toBe("once")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })

  test("passes directory from session mapping when permission not in store", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await respondToPermission("session-b", "perm-2", "always")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-2")
    expect(replyCalls[0].params.reply).toBe("always")
    expect(replyCalls[0].params.directory).toBe("/other/project")
  })

  test("passes directory from current directory as last resort", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/fallback/dir")

    await respondToPermission("unknown-session", "perm-3", "reject")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-3")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/fallback/dir")
  })

  test("uses an explicit event directory before incomplete local routing state", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/stale/current")

    await respondToPermission("unknown-session", "perm-event", "once", "/event/project")

    expect(replyCalls.filter((call) => call.method === "permission.reply").map((call) => call.params.directory)).toContain("/event/project")
    expect(replyCalls[0].params.directory).toBe("/event/project")
  })
})

describe("forkFromMessage composer restore", () => {
  const sourceSession: Session = {
    id: "session-a",
    projectID: "project-a",
    directory: "/test/project",
    title: "Source session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const forkedSession: Session = { ...sourceSession, id: "session-fork", title: "Forked session" }
  const textPart: Part = {
    id: "part-text",
    sessionID: sourceSession.id,
    messageID: "message-fork",
    type: "text",
    text: "Replay this prompt",
  }
  const filePart: Part = {
    id: "part-file",
    sessionID: sourceSession.id,
    messageID: "message-fork",
    type: "file",
    url: "data:image/png;base64,aW1hZ2U=",
    mime: "image/png",
    filename: "screenshot.png",
  }
  const restoredFile = { url: filePart.url, mimeType: filePart.mime, filename: filePart.filename }

  beforeEach(() => {
    replyCalls.length = 0
    selectedSessions.length = 0
    runtimeKey = "fork-runtime"
    sessionForkResult = forkedSession
    sessionForkError = null
    beforeSessionForkResolve = null
    inputState.pendingComposerRestore = null
    inputState.pendingInputText = "Keep the source draft"
    inputState.pendingInputMode = "append"
    inputState.attachedFiles = [{
      id: "source-attachment",
      file: new File(["source"], "source.txt", { type: "text/plain" }),
      dataUrl: "data:text/plain;base64,c291cmNl",
      mimeType: "text/plain",
      filename: "source.txt",
      size: 6,
      source: "local",
    }]
  })

  for (const directory of ["/test/project", "/canonical/project"]) {
    test(`stages the replay for the returned session in ${directory} without changing the source composer`, async () => {
      sessionForkResult = { ...forkedSession, directory }
      const source = createStore({}, {
        session: [sourceSession],
        part: { "message-fork": [textPart, filePart] },
      })
      const sourceInput = { ...inputState }
      const { forkFromMessage, setActionRefs } = await import("./session-actions")
      setActionRefs(createChildStores([[sourceSession.directory, source]]), () => "/other/project")

      await forkFromMessage(sourceSession.id, "message-fork")

      expect(replyCalls).toEqual([{
        method: "session.fork",
        params: { sessionID: sourceSession.id, messageID: "message-fork", directory: sourceSession.directory },
      }])
      expect(inputState.pendingComposerRestore).toEqual({
        target: { runtimeKey: "fork-runtime", directory, sessionId: forkedSession.id },
        text: "Replay this prompt",
        files: [restoredFile],
      })
      expect(inputState.pendingInputText).toBe(sourceInput.pendingInputText)
      expect(inputState.pendingInputMode).toBe(sourceInput.pendingInputMode)
      expect(inputState.attachedFiles).toBe(sourceInput.attachedFiles)
      expect(inputState.attachedFiles).toHaveLength(1)
      expect(selectedSessions).toEqual([{ sessionId: forkedSession.id, directoryHint: directory }])
      expect(source.getState().session).toEqual([sourceSession, sessionForkResult])
    })
  }

  test("uses the returned project worktree when the fork has no directory", async () => {
    const forkWithProject: Session & { project: { worktree: string } } = {
      ...forkedSession, directory: "", project: { worktree: "/canonical/worktree" },
    }
    sessionForkResult = forkWithProject
    const source = createStore({}, { session: [sourceSession], part: { "message-fork": [textPart] } })
    const { forkFromMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await forkFromMessage(sourceSession.id, "message-fork")

    expect(inputState.pendingComposerRestore?.target.directory).toBe("/canonical/worktree")
    expect(selectedSessions).toEqual([{ sessionId: forkedSession.id, directoryHint: "/canonical/worktree" }])
  })

  test("stages a file-only prompt with empty text without replacing source attachments", async () => {
    const source = createStore({}, {
      session: [sourceSession],
      part: { "message-fork": [filePart] },
    })
    const sourceInput = { ...inputState }
    const { forkFromMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await forkFromMessage(sourceSession.id, "message-fork")

    expect(inputState.pendingComposerRestore).toEqual({
      target: { runtimeKey: "fork-runtime", directory: sourceSession.directory, sessionId: forkedSession.id },
      text: "",
      files: [restoredFile],
    })
    expect(inputState.pendingInputText).toBe(sourceInput.pendingInputText)
    expect(inputState.attachedFiles).toBe(sourceInput.attachedFiles)
    expect(selectedSessions).toEqual([{ sessionId: forkedSession.id, directoryHint: sourceSession.directory }])
  })

  test("leaves input, selection, and sessions unchanged when the fork fails", async () => {
    sessionForkError = new Error("fork failed")
    const source = createStore({}, {
      session: [sourceSession],
      part: { "message-fork": [textPart, filePart] },
    })
    const sourceState = source.getState()
    const sourceInput = { ...inputState }
    const { forkFromMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await expect(forkFromMessage(sourceSession.id, "message-fork")).rejects.toThrow("fork failed")

    expect(inputState).toEqual(sourceInput)
    expect(inputState.attachedFiles).toBe(sourceInput.attachedFiles)
    expect(selectedSessions).toEqual([])
    expect(source.getState()).toBe(sourceState)
  })

  test("does not select, mutate, or stage a fork resolved after the runtime changes", async () => {
    beforeSessionForkResolve = () => { runtimeKey = "other-runtime" }
    const source = createStore({}, {
      session: [sourceSession],
      part: { "message-fork": [textPart, filePart] },
    })
    const sourceState = source.getState()
    const sourceInput = { ...inputState }
    const { forkFromMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await forkFromMessage(sourceSession.id, "message-fork")

    expect(replyCalls).toEqual([{
      method: "session.fork",
      params: { sessionID: sourceSession.id, messageID: "message-fork", directory: sourceSession.directory },
    }])
    expect(runtimeKey).toBe("other-runtime")
    expect(inputState).toEqual(sourceInput)
    expect(inputState.attachedFiles).toBe(sourceInput.attachedFiles)
    expect(selectedSessions).toEqual([])
    expect(source.getState()).toBe(sourceState)
  })
})

describe("forkAfterMessage", () => {
  const sourceSession: Session = {
    id: "session-a",
    projectID: "project-a",
    directory: "/test/project",
    title: "Source session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const forkedSession: Session = { ...sourceSession, id: "session-fork", title: "Forked session" }
  // SAFETY: forkAfterMessage reads only id and role; the rest of the message shape is irrelevant here.
  const message = (id: string, role: "user" | "assistant") => ({ id, role, sessionID: sourceSession.id, time: { created: 1 } }) as Message
  const transcript = [
    message("msg-user-1", "user"),
    message("msg-answer-1", "assistant"),
    message("msg-user-2", "user"),
    message("msg-answer-2", "assistant"),
  ]

  beforeEach(() => {
    replyCalls.length = 0
    selectedSessions.length = 0
    runtimeKey = "fork-runtime"
    sessionForkResult = forkedSession
    sessionForkError = null
    beforeSessionForkResolve = null
    inputState.pendingComposerRestore = null
  })

  test("cuts before the next user message so the fork keeps the answer", async () => {
    const source = createStore({}, { session: [sourceSession], message: { [sourceSession.id]: transcript } })
    const { forkAfterMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await forkAfterMessage(sourceSession.id, "msg-answer-1")

    expect(replyCalls).toEqual([{
      method: "session.fork",
      params: { sessionID: sourceSession.id, messageID: "msg-user-2", directory: sourceSession.directory },
    }])
    expect(selectedSessions).toEqual([{ sessionId: forkedSession.id, directoryHint: sourceSession.directory }])
    expect(source.getState().session).toEqual([sourceSession, forkedSession])
    expect(inputState.pendingComposerRestore).toBeNull()
  })

  test("copies the whole transcript when the answer is the last message", async () => {
    const source = createStore({}, { session: [sourceSession], message: { [sourceSession.id]: transcript } })
    const { forkAfterMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await forkAfterMessage(sourceSession.id, "msg-answer-2")

    expect(replyCalls).toEqual([{
      method: "session.fork",
      params: { sessionID: sourceSession.id, messageID: undefined, directory: sourceSession.directory },
    }])
  })

  test("refuses to fork from a message that is not loaded", async () => {
    const source = createStore({}, { session: [sourceSession], message: { [sourceSession.id]: transcript } })
    const { forkAfterMessage, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await expect(forkAfterMessage(sourceSession.id, "msg-missing")).rejects.toThrow("Fork source message is not loaded")
    expect(replyCalls).toEqual([])
    expect(selectedSessions).toEqual([])
  })
})

describe("forkFromLastCompletedTurn", () => {
  const sourceSession: Session = {
    id: "session-a",
    projectID: "project-a",
    directory: "/test/project",
    title: "Source session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  // SAFETY: the turn lookup reads only id, role, and time.completed.
  const message = (id: string, role: "user" | "assistant", completed?: number) =>
    ({ id, role, sessionID: sourceSession.id, time: completed === undefined ? { created: 1 } : { created: 1, completed } }) as Message

  beforeEach(() => {
    replyCalls.length = 0
    selectedSessions.length = 0
    runtimeKey = "fork-runtime"
    sessionForkResult = { ...sourceSession, id: "session-fork" }
    sessionForkError = null
    beforeSessionForkResolve = null
  })

  test("skips a running turn, including its already completed steps", async () => {
    const transcript = [
      message("u1", "user"),
      message("a1", "assistant", 2),
      message("u2", "user"),
      message("a2-step", "assistant", 3),
      message("a2-live", "assistant"),
    ]
    const source = createStore({}, {
      session: [sourceSession],
      message: { [sourceSession.id]: transcript },
      session_status: { [sourceSession.id]: { type: "busy" } },
    })
    const { forkFromLastCompletedTurn, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await forkFromLastCompletedTurn(sourceSession.id)

    expect(replyCalls).toEqual([{
      method: "session.fork",
      params: { sessionID: sourceSession.id, messageID: "u2", directory: sourceSession.directory },
    }])
  })

  test("copies the whole transcript when the session is idle", async () => {
    const { findLastCompletedTurnMessageId } = await import("./session-actions")
    const transcript = [message("u1", "user"), message("a1", "assistant", 2)]
    expect(findLastCompletedTurnMessageId(transcript, false)).toBe("a1")
  })

  test("refuses when no turn has finished", async () => {
    const source = createStore({}, {
      session: [sourceSession],
      message: { [sourceSession.id]: [message("u1", "user"), message("a1", "assistant")] },
      session_status: { [sourceSession.id]: { type: "busy" } },
    })
    const { forkFromLastCompletedTurn, NothingToForkError, setActionRefs } = await import("./session-actions")
    setActionRefs(createChildStores([[sourceSession.directory, source]]), () => sourceSession.directory)

    await expect(forkFromLastCompletedTurn(sourceSession.id)).rejects.toThrow(NothingToForkError)
    expect(replyCalls).toEqual([])
    expect(selectedSessions).toEqual([])
  })
})

describe("revertToMessage passes session directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    sessionMessageRecords.clear()
    sessionRecords.clear()
    failingRevertSessionIds.clear()
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "replace",
      attachedFiles: [],
    })
  })

  test("routes revert through the session directory instead of the current directory", async () => {
    const session = sessionFixture("session-a")
    sessionRecords.set(session.id, session)
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const currentStore = createStore({})
    const childStores = createChildStores([
      ["/test/project", sessionStore],
      ["/current/project", currentStore],
    ])
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(childStores, () => "/current/project")

    await revertToMessage("session-a", "msg_2")

    expect(replyCalls.find((call) => call.method === "session.revert.stage")?.params.directory).toBe("/test/project")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_2")
    expect(currentStore.getState().session).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("edit this")
  })

  test("rolls back optimistic revert when the SDK returns an error", async () => {
    const session = sessionFixture("session-a")
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    failingRevertSessionIds.add("session-a")

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    let thrown: unknown
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("session.revert.stage failed (500)")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert).toBe(undefined)
    expect(inputState.pendingInputText).toBe("previous draft")
  })

  test("reverts recursive descendants at their first user message on or after the parent cutoff", async () => {
    const rootMessage = { id: "root-cutoff", sessionID: "root", role: "user", time: { created: 20 } } as Message
    const sessions = [
      { ...sessionFixture("root"), directory: "/tree", time: { created: 1, updated: 1 } },
      { ...sessionFixture("child"), parentID: "root", directory: "/tree", time: { created: 2, updated: 2 } },
      { ...sessionFixture("grandchild"), parentID: "child", directory: "/tree", time: { created: 3, updated: 3 } },
      { ...sessionFixture("old-child"), parentID: "root", directory: "/tree", time: { created: 4, updated: 4 } },
    ] as Session[]
    const store = createStore({}, { session: sessions, message: { root: [rootMessage] } })
    sessionMessageRecords.set("child", [
      { info: { id: "child-before", sessionID: "child", role: "user", time: { created: 10 } } as Message, parts: [] },
      { info: { id: "child-boundary", sessionID: "child", role: "user", time: { created: 20 } } as Message, parts: [] },
      { info: { id: "child-later", sessionID: "child", role: "user", time: { created: 30 } } as Message, parts: [] },
    ])
    sessionMessageRecords.set("grandchild", [
      { info: { id: "grandchild-assistant", sessionID: "grandchild", role: "assistant", time: { created: 20 } } as Message, parts: [] },
      { info: { id: "grandchild-user", sessionID: "grandchild", role: "user", time: { created: 21 } } as Message, parts: [] },
    ])
    sessionMessageRecords.set("old-child", [
      { info: { id: "old-child-user", sessionID: "old-child", role: "user", time: { created: 19 } } as Message, parts: [] },
    ])

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(createChildStores([["/tree", store]]), () => "/tree")

    await revertToMessage("root", "root-cutoff")

    expect(replyCalls.filter((call) => call.method === "session.revert.stage").map((call) => [
      call.params.sessionID,
      call.params.messageID,
    ])).toEqual([
      ["child", "child-boundary"],
      ["grandchild", "grandchild-user"],
      ["root", "root-cutoff"],
    ])
  })

  test("continues reverting other descendants and the parent when one child fails", async () => {
    const rootMessage = { id: "root-cutoff", sessionID: "root", role: "user", time: { created: 20 } } as Message
    const sessions = [
      { ...sessionFixture("root"), directory: "/tree", time: { created: 1, updated: 1 } },
      { ...sessionFixture("failing-child"), parentID: "root", directory: "/tree", time: { created: 2, updated: 2 } },
      { ...sessionFixture("healthy-child"), parentID: "root", directory: "/tree", time: { created: 3, updated: 3 } },
    ] as Session[]
    const store = createStore({}, { session: sessions, message: { root: [rootMessage] } })
    for (const id of ["failing-child", "healthy-child"]) {
      sessionMessageRecords.set(id, [{
        info: { id: `${id}-target`, sessionID: id, role: "user", time: { created: 20 } } as Message,
        parts: [],
      }])
    }
    failingRevertSessionIds.add("failing-child")

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(createChildStores([["/tree", store]]), () => "/tree")

    await revertToMessage("root", "root-cutoff")

    expect(replyCalls.filter((call) => call.method === "session.revert.stage").map((call) => call.params.sessionID)).toEqual([
      "failing-child",
      "healthy-child",
      "root",
    ])
  })

  test("aborts a busy descendant before reverting it", async () => {
    const rootMessage = { id: "root-cutoff", sessionID: "root", role: "user", time: { created: 20 } } as Message
    const sessions = [
      { ...sessionFixture("root"), directory: "/tree", time: { created: 1, updated: 1 } },
      { ...sessionFixture("busy-child"), parentID: "root", directory: "/tree", time: { created: 2, updated: 2 } },
      { ...sessionFixture("idle-child"), parentID: "root", directory: "/tree", time: { created: 3, updated: 3 } },
    ] as Session[]
    const store = createStore({}, {
      session: sessions,
      message: { root: [rootMessage] },
      session_status: { "busy-child": { type: "busy" }, "idle-child": { type: "idle" } },
    })
    for (const id of ["busy-child", "idle-child"]) {
      sessionMessageRecords.set(id, [{
        info: { id: `${id}-target`, sessionID: id, role: "user", time: { created: 20 } } as Message,
        parts: [],
      }])
    }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(createChildStores([["/tree", store]]), () => "/tree")

    await revertToMessage("root", "root-cutoff")

    expect(replyCalls.filter((call) => call.method === "session.abort").map((call) => call.params.sessionID))
      .toEqual(["busy-child"])
    const busyAbortIndex = replyCalls.findIndex((call) => call.method === "session.abort")
    const busyRevertIndex = replyCalls.findIndex(
      (call) => call.method === "session.revert.stage" && call.params.sessionID === "busy-child",
    )
    expect(busyAbortIndex).toBeLessThan(busyRevertIndex)
    expect(replyCalls.filter((call) => call.method === "session.revert.stage").map((call) => call.params.sessionID)).toEqual([
      "busy-child",
      "idle-child",
      "root",
    ])
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    formReplyError = null
    permissionReplyError = null
  })

  test("passes directory and reply=reject", async () => {
    const permission: PermissionRequest = {
      id: "perm-10",
      sessionID: "session-a",
      action: "edit",
      resources: [],
      metadata: {},
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await dismissPermission("session-a", "perm-10")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-10")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("replyToForm passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    formReplyError = null
  })

  test("passes directory to form.reply", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, replyToForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await replyToForm("session-a", "q-1", { choice: true })

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.formID).toBe("q-1")
    expect(replyCalls[0].params.directory).toBe("/test/project")
    expect(replyCalls.filter((call) => call.method.endsWith(".reply") || call.method === "form.cancel").map((call) => call.params.directory)).toEqual(["/test/project"])
  })

  test("removes stale form from child store when reply returns not found", async () => {
    const form = buildForm("q-stale", "session-a")
    const store = createStore({}, { form: { "session-a": [form] } })
    const childStores = createChildStores([["/test/project", store]])
    formReplyError = Object.assign(new Error("form.reply failed (404): FormNotFoundError"), { status: 404 })

    const { setActionRefs, replyToForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    let thrown: unknown
    try {
      await replyToForm("session-a", "q-stale", { choice: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(store.getState().form["session-a"]).toBe(undefined)
  })
})

describe("cancelForm passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    formReplyError = null
  })

  test("passes directory to form.cancel", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, cancelForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await cancelForm("session-a", "q-2")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.formID).toBe("q-2")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

function sessionFixture(id: string): Session {
  return {
    id,
    projectID: "project-1",
    directory: "/test/project",
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

describe("form dismissal clears pending state without the SSE echo (issues #2911, #2448)", () => {
  beforeEach(() => {
    replyCalls.length = 0
    formReplyError = null
    formCancelError = null
  })

  test("cancelForm clears the form from the child store on success", async () => {
    const form = buildForm("q-1", "session-a")
    const store = createStore({}, {
      session: [sessionFixture("session-a")],
      form: { "session-a": [form] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, cancelForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await cancelForm("session-a", "q-1")

    // The backend confirmed the rejection. The local pending state must be gone
    // even if the SSE `form.cancelled` event is lost (SSE gap), otherwise the
    // session stays in "waiting for answer" and the next task never renders
    // thinking/final response (issues #2911, #2448).
    expect(store.getState().form["session-a"]).toBe(undefined)
  })

  test("replyToForm clears the form from the child store on success", async () => {
    const form = buildForm("q-1", "session-a")
    const store = createStore({}, {
      session: [sessionFixture("session-a")],
      form: { "session-a": [form] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, replyToForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await replyToForm("session-a", "q-1", { choice: true })

    expect(store.getState().form["session-a"]).toBe(undefined)
  })

  test("dismissOpenFormsForSession leaves the store cleared when the reject succeeds", async () => {
    const form = buildForm("q-root", "session-a")
    const store = createStore({}, {
      session: [sessionFixture("session-a")],
      form: { "session-a": [form] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenFormsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenFormsForSession("session-a")

    expect(dismissed).toBe(true)
    // The optimistic clear already removed it before the round-trip; the
    // successful reject must not resurrect it.
    expect(store.getState().form["session-a"]).toBe(undefined)
  })

  test("reply/reject actions on an already-cleared store stay no-ops (SSE echo equivalent)", async () => {
    // A later (or duplicated) SSE echo for an already-cleared request must not
    // error or resurrect state — the reducer only removes when present.
    const store = createStore({}, {
      session: [sessionFixture("session-a")],
      form: {},
    })

    const { setActionRefs, cancelForm, replyToForm } = await import("./session-actions")
    setActionRefs(createChildStores([["/test/project", store]]), () => "/test/project")

    await replyToForm("session-a", "q-gone", { choice: true })
    await cancelForm("session-a", "q-gone")

    expect(store.getState().form["session-a"]).toBe(undefined)
  })
})

describe("blocking request reply routing and stale recovery (issue OPE-236)", () => {
  const materializationCalls: Array<{ directory: string; sessionID: string; messageID: string }> = []
  const enqueueMaterialization = (directory: string, sessionID: string, messageID: string) => {
    materializationCalls.push({ directory, sessionID, messageID })
  }

  beforeEach(() => {
    replyCalls.length = 0
    formReplyError = null
    formCancelError = null
    materializationCalls.length = 0
  })

  test("routes the form reply by the request's own session directory, not the containing store key", async () => {
    // The form was asked by a worktree session whose record lives in the
    // parent store (containment). The reply must be addressed to the session's
    // own server-confirmed directory — otherwise the server resolves the
    // parent instance, does not find the pending form, and answers
    // FormNotFoundError, leaving the session stuck on "asking for input".
    const form = buildForm("q-wt", "session-wt")
    const store = createStore({}, {
      session: [{ id: "session-wt", directory: "/test/project/wt" } as Session],
      form: { "session-wt": [form] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, replyToForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project", enqueueMaterialization)

    await replyToForm("session-wt", "q-wt", { choice: true })

    expect(replyCalls.filter((call) => call.method.endsWith(".reply") || call.method === "form.cancel").map((call) => call.params.directory)).toEqual(["/test/project/wt"])
    expect(replyCalls[0]?.params.directory).toBe("/test/project/wt")
    expect(replyCalls[0]?.params.formID).toBe("q-wt")
  })

  test("routes permission replies by the request's own session directory", async () => {
    const permission = buildPermission("perm-wt", "session-wt")
    const store = createStore(
      { "session-wt": [permission] },
      {
        session: [{ id: "session-wt", directory: "/test/project/wt" } as Session],
      },
    )
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project", enqueueMaterialization)

    await respondToPermission("session-wt", "perm-wt", "once")

    expect(replyCalls.filter((call) => call.method.endsWith(".reply") || call.method === "form.cancel").map((call) => call.params.directory)).toEqual(["/test/project/wt"])
    expect(replyCalls[0]?.params.directory).toBe("/test/project/wt")
    expect(replyCalls[0]?.params.requestID).toBe("perm-wt")
  })

  test("falls back to the containing store key when the session record carries no directory", async () => {
    const form = buildForm("q-1", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a" } as Session],
      form: { "session-a": [form] },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, replyToForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project", enqueueMaterialization)

    await replyToForm("session-a", "q-1", { choice: true })

    expect(replyCalls.filter((call) => call.method.endsWith(".reply") || call.method === "form.cancel").map((call) => call.params.directory)).toEqual(["/test/project"])
    expect(replyCalls[0]?.params.directory).toBe("/test/project")
  })

  test("enqueues settled-running-tool tail recovery when the form reply is not found", async () => {
    const form = buildForm("q-stale", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a" } as Session],
      form: { "session-a": [form] },
      message: {
        "session-a": [{ id: "msg-1", sessionID: "session-a", role: "assistant", time: { created: 1 } } as Message],
      },
      part: {
        "msg-1": [{
          id: "prt-1",
          messageID: "msg-1",
          sessionID: "session-a",
          type: "tool",
          tool: "question",
          state: { status: "running" },
        } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", store]])
    formReplyError = Object.assign(new Error("form.reply failed (404): FormNotFoundError"), { status: 404 })

    const { setActionRefs, replyToForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project", enqueueMaterialization)

    let thrown: unknown
    try {
      await replyToForm("session-a", "q-stale", { choice: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    // The stale request is gone from the store and the trailing running tool
    // part is reconciled instead of leaving the UI stuck on "asking for input".
    expect(store.getState().form["session-a"]).toBe(undefined)
    expect(materializationCalls).toEqual([{ directory: "/test/project", sessionID: "session-a", messageID: "msg-1" }])
  })

  test("enqueues tail recovery on reject not-found but not on success", async () => {
    const form = buildForm("q-1", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a" } as Session],
      form: { "session-a": [form] },
      message: {
        "session-a": [{ id: "msg-1", sessionID: "session-a", role: "assistant", time: { created: 1 } } as Message],
      },
      part: {
        "msg-1": [{
          id: "prt-1",
          messageID: "msg-1",
          sessionID: "session-a",
          type: "tool",
          tool: "question",
          state: { status: "running" },
        } as Part],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, cancelForm } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project", enqueueMaterialization)

    // Success: no recovery enqueued — the normal form.cancelled event flow clears state.
    await cancelForm("session-a", "q-1")
    expect(materializationCalls).toEqual([])

    // Not-found: the request is stale server-side; the tail must be reconciled.
    formCancelError = Object.assign(new Error("form.cancel failed (404): FormNotFoundError"), { status: 404 })
    const stale = buildForm("q-stale", "session-a")
    store.setState({ form: { "session-a": [stale] } })

    let thrown: unknown
    try {
      await cancelForm("session-a", "q-stale")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(store.getState().form["session-a"]).toBe(undefined)
    expect(materializationCalls).toEqual([{ directory: "/test/project", sessionID: "session-a", messageID: "msg-1" }])
  })
})

function buildForm(id: string, sessionId: string): FormRequest {
  return {
    id,
    sessionID: sessionId,
    title: "Choose an option",
    fields: [{ key: "choice", type: "boolean" }],
  }
}

function buildPermission(id: string, sessionId: string): PermissionRequest {
  return {
    id,
    sessionID: sessionId,
    action: "edit",
    resources: [],
    metadata: {},
  }
}

describe("dismissOpenFormsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    formReplyError = null
  })

  test("returns false and rejects nothing when no forms are pending", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenFormsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenFormsForSession("session-a")

    expect(dismissed).toBe(false)
    expect(replyCalls.filter((call) => call.method === "form.cancel")).toHaveLength(0)
  })

  test("rejects every pending form in the session subtree (root + subagent child)", async () => {
    const rootForm = buildForm("q-root", "session-a")
    const childForm = buildForm("q-child", "session-child")
    const store = createStore({}, {
      session: [
        { id: "session-a", time: { created: 1 } } as Session,
        { id: "session-child", parentID: "session-a", time: { created: 2 } } as Session,
      ],
      form: {
        "session-a": [rootForm],
        "session-child": [childForm],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenFormsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenFormsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "form.cancel")
    expect(rejectCalls).toHaveLength(2)
    const rejectedIds = rejectCalls.map((call) => call.params.formID).sort()
    expect(rejectedIds).toEqual(["q-child", "q-root"])
    // Optimistic clear: the forms are removed from the local store so the
    // prompt disappears instantly, without waiting for the reject round-trip.
    expect(store.getState().form["session-a"]).toBe(undefined)
    expect(store.getState().form["session-child"]).toBe(undefined)
  })

  test("swallows FormNotFoundError so a stranded form never blocks the send", async () => {
    const staleForm = buildForm("q-stale", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      form: { "session-a": [staleForm] },
    })
    const childStores = createChildStores([["/test/project", store]])
    formCancelError = Object.assign(new Error("form.cancel failed (404): FormNotFoundError"), { status: 404 })

    const { setActionRefs, dismissOpenFormsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenFormsForSession("session-a")

    expect(dismissed).toBe(true)
    const cancelCalls = replyCalls.filter((call) => call.method === "form.cancel")
    expect(cancelCalls).toHaveLength(1)
    expect(cancelCalls[0].params.formID).toBe("q-stale")
    // The stale entry is cleared from the store even though the server reported not-found.
    expect(store.getState().form["session-a"]).toBe(undefined)
  })
})

describe("dismissPermission not-found handling", () => {
  beforeEach(() => {
    replyCalls.length = 0
    permissionReplyError = null
  })

  test("clears the stale permission and rethrows on PermissionNotFoundError", async () => {
    const permission = buildPermission("perm-stale", "session-a")
    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])
    permissionReplyError = Object.assign(new Error("permission.reply failed (404): PermissionNotFoundError"), { status: 404 })

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await expect(dismissPermission("session-a", "perm-stale")).rejects.toThrow()
    expect(replyCalls.filter((call) => call.method === "permission.reply")).toHaveLength(1)
    // The stale entry is cleared from the store even though the server reported not-found.
    expect(store.getState().permission["session-a"]).toBe(undefined)
  })

  test("does not clear the store on a non-not-found failure (rethrow only)", async () => {
    const permission = buildPermission("perm-500", "session-a")
    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])
    permissionReplyError = Object.assign(new Error("permission.reply failed (500)"), { status: 500 })

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    await expect(dismissPermission("session-a", "perm-500")).rejects.toThrow()
    // A non-not-found failure leaves store reconciliation to the next server event.
    expect(store.getState().permission["session-a"]).toHaveLength(1)
  })
})

describe("dismissOpenPermissionsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    permissionReplyError = null
  })

  test("returns false and rejects nothing when no permissions are pending", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenPermissionsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenPermissionsForSession("session-a")

    expect(dismissed).toBe(false)
    expect(replyCalls.filter((call) => call.method === "permission.reply")).toHaveLength(0)
  })

  test("rejects every pending permission in the session subtree (root + subagent child)", async () => {
    const rootPermission = buildPermission("perm-root", "session-a")
    const childPermission = buildPermission("perm-child", "session-child")
    const store = createStore({
      "session-a": [rootPermission],
      "session-child": [childPermission],
    }, {
      session: [
        { id: "session-a", time: { created: 1 } } as Session,
        { id: "session-child", parentID: "session-a", time: { created: 2 } } as Session,
      ],
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenPermissionsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenPermissionsForSession("session-a")

    expect(dismissed).toBe(true)
    const replyCallsForPermissions = replyCalls.filter((call) => call.method === "permission.reply")
    expect(replyCallsForPermissions).toHaveLength(2)
    const rejectedIds = replyCallsForPermissions.map((call) => call.params.requestID).sort()
    expect(rejectedIds).toEqual(["perm-child", "perm-root"])
    expect(replyCallsForPermissions.every((call) => call.params.reply === "reject")).toBe(true)
    // Optimistic clear: the permissions are removed from the local store so the
    // prompt disappears instantly, without waiting for the reject round-trip.
    expect(store.getState().permission["session-a"]).toBe(undefined)
    expect(store.getState().permission["session-child"]).toBe(undefined)
  })

  test("swallows PermissionNotFoundError so a stranded permission never blocks the send", async () => {
    const stalePermission = buildPermission("perm-stale", "session-a")
    const store = createStore({ "session-a": [stalePermission] }, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
    })
    const childStores = createChildStores([["/test/project", store]])
    permissionReplyError = Object.assign(new Error("permission.reply failed (404): PermissionNotFoundError"), { status: 404 })

    const { setActionRefs, dismissOpenPermissionsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const dismissed = await dismissOpenPermissionsForSession("session-a")

    expect(dismissed).toBe(true)
    const replyCallsForPermissions = replyCalls.filter((call) => call.method === "permission.reply")
    expect(replyCallsForPermissions).toHaveLength(1)
    expect(replyCallsForPermissions[0].params.requestID).toBe("perm-stale")
    // The stale entry is cleared from the store even though the server reported not-found.
    expect(store.getState().permission["session-a"]).toBe(undefined)
  })

  test("swallows and logs a non-not-found reject failure so the send is never blocked", async () => {
    const permission = buildPermission("perm-500", "session-a")
    const store = createStore({ "session-a": [permission] }, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
    })
    const childStores = createChildStores([["/test/project", store]])
    permissionReplyError = Object.assign(new Error("permission.reply failed (500)"), { status: 500 })

    const { setActionRefs, dismissOpenPermissionsForSession } = await import("./session-actions")
    setActionRefs(childStores, () => "/test/project")

    const errors: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const dismissed = await dismissOpenPermissionsForSession("session-a")

      expect(dismissed).toBe(true)
      const replyCallsForPermissions = replyCalls.filter((call) => call.method === "permission.reply")
      expect(replyCallsForPermissions).toHaveLength(1)
      expect(replyCallsForPermissions[0].params.requestID).toBe("perm-500")
      expect(errors).toHaveLength(1)
      expect(String(errors[0]?.[0])).toContain("[session-actions]")
    } finally {
      console.error = originalError
    }
  })
})
