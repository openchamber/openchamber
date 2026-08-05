import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"

// Mock SDK client that records permission.reply / question.reply calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
const scopedClientDirectories: string[] = []
const registeredSessionDirectories: Array<{ sessionID: string; directory: string }> = []
let sessionRevertResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let questionReplyError: unknown | null = null
let questionRejectError: unknown | null = null
let permissionReplyError: unknown | null = null
let sessionShareResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionUpdateResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionMessagesResult: { data?: unknown; error?: unknown; response?: { status?: number } } = { data: [] }
let sessionDeleteError: unknown | null = null
let beforeSessionUpdateResolve: ((sessionId: string) => void) | null = null
let beforeSessionDeleteResolve: ((sessionId: string) => void) | null = null
const globalUpsertedSessions: unknown[] = []
const globalRemovedSessionIds: string[] = []
const deletedCleanupIdentities: Array<{ runtimeKey: string; directory: string; sessionId: string }> = []
const movedSessionDirectories: Array<{ sessionID: string; directory: string }> = []

const mockScopedClient = {
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      if (permissionReplyError) {
        const status = (permissionReplyError as { status?: number })?.status ?? 404
        return Promise.resolve({ error: permissionReplyError, response: { status } })
      }
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

const mockSdk = {
  experimental: {
    controlPlane: {
      moveSession: mock((params: Record<string, unknown>) => {
        replyCalls.push({ method: "controlPlane.moveSession", params })
        return Promise.resolve({})
      }),
    },
  },
  session: {
    messages: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.messages", params })
      return Promise.resolve(sessionMessagesResult)
    }),
    revert: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.revert", params })
      return Promise.resolve(sessionRevertResult)
    }),
    abort: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.abort", params })
      return Promise.resolve({ data: true })
    }),
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      return Promise.resolve(sessionUpdateResult.data as Session)
    }),
    update: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.update", params })
      return Promise.resolve(sessionUpdateResult)
    }),
    share: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.share", params })
      return Promise.resolve(sessionShareResult)
    }),
    unshare: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.unshare", params })
      return Promise.resolve(sessionShareResult)
    }),
  },
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      if (permissionReplyError) {
        const status = (permissionReplyError as { status?: number })?.status ?? 404
        return Promise.resolve({ error: permissionReplyError, response: { status } })
      }
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      if (questionReplyError) {
        return Promise.resolve({ error: questionReplyError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      if (questionRejectError) {
        return Promise.resolve({ error: questionRejectError, response: { status: 404 } })
      }
      return Promise.resolve({ data: true })
    }),
  },
}

// Mock opencodeClient singleton
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: (directory: string) => {
      scopedClientDirectories.push(directory)
      return mockScopedClient
    },
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    replyToPermission: mock((requestId: string, reply: string, options?: { directory?: string | null }) => {
      replyCalls.push({ method: "permission.reply", params: { requestID: requestId, reply, directory: options?.directory } })
      return Promise.resolve(true)
    }),
    replyToQuestion: mock((requestId: string, answers: string[] | string[][], directory?: string | null) => {
      replyCalls.push({ method: "question.reply", params: { requestID: requestId, answers, directory } })
      return Promise.resolve(true)
    }),
    revertSession: mock((sessionId: string, messageId: string, partId?: string, directory?: string | null) => {
      replyCalls.push({
        method: "session.revert",
        params: { sessionID: sessionId, messageID: messageId, partID: partId, directory },
      })
      if (sessionRevertResult.error) {
        const status = sessionRevertResult.response?.status
        throw new Error(`session.revert failed${status ? ` (${status})` : ""}: rejected`)
      }
      return Promise.resolve(sessionRevertResult.data)
    }),
    updateSession: mock((sessionId: string, changes: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "session.update", params: { sessionID: sessionId, ...changes, directory } })
      // Lets a test mutate global runtime state while the SDK call is in flight,
      // so the action observes the switch only after awaiting the response.
      beforeSessionUpdateResolve?.(sessionId)
      return Promise.resolve(sessionUpdateResult.data)
    }),
    deleteSession: mock((sessionId: string, directory?: string | null) => {
      replyCalls.push({ method: "session.delete", params: { sessionID: sessionId, directory } })
      // Lets a test switch runtime while the delete is in flight, so the action
      // observes the change only after awaiting (or catching) the response.
      beforeSessionDeleteResolve?.(sessionId)
      if (sessionDeleteError) throw sessionDeleteError
      return Promise.resolve(true)
    }),
  },
}))

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
      setCurrentSession: () => {},
      setWorktreeMetadata: () => {},
      setSessionDirectory: (sessionID: string, directory: string) => {
        movedSessionDirectories.push({ sessionID, directory })
      },
    }),
  },
}))

// Mock useInputStore
const inputState = {
  pendingInputText: "",
  pendingInputMode: "normal" as const,
  attachedFiles: [],
  clearAttachedFiles: () => {
    inputState.attachedFiles = []
  },
  addRestoredAttachment: (attachment: never) => {
    inputState.attachedFiles = [...inputState.attachedFiles, attachment]
  },
}

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => inputState,
    setState: (patch: Partial<typeof inputState>) => Object.assign(inputState, patch),
  },
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
      activeSessions: [],
      archivedSessions: [],
      upsertSession: (session: unknown) => {
        globalUpsertedSessions.push(session)
      },
      removeSessions: (ids: Iterable<string>) => {
        globalRemovedSessionIds.push(...ids)
      },
    }),
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

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"

type OptimisticAddCall = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveCall = { sessionID: string; directory?: string | null; messageID: string }
type SessionWithDirectory = Session & {
  directory?: string | null
  project?: { worktree?: string | null }
}

function createStore(
  permissions: Record<string, PermissionRequest[]>,
  state?: Partial<DirectoryStore>,
): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    permission: permissions,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
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
      session_diff: { "session-a": [{ file: "changed.ts", additions: 1, deletions: 0 }] },
      todo: { "session-a": [{ id: "todo-a", content: "Check move", status: "pending", priority: "medium" }] as never },
      question: { "session-a": [{ id: "question-a" }] as never },
      message: { "session-a": [message] },
      part: { "message-a": [part] },
    })
    const destination = createStore({})
    const childStores = createChildStores([["/source", source], ["/destination", destination]])
    const { moveSessionToDirectory, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/source")

    await moveSessionToDirectory(source.getState().session[0], "/source", "/destination", true)

    expect(replyCalls.filter((call) => call.method === "controlPlane.moveSession")).toEqual([{
      method: "controlPlane.moveSession",
      params: {
        sessionID: "session-a",
        destination: { directory: "/destination" },
        moveChanges: true,
      },
    }])
    expect(source.getState().session).toHaveLength(0)
    expect(source.getState().sessionTotal).toBe(0)
    expect(source.getState().session_status["session-a"]).toBe(undefined)
    expect(source.getState().session_diff["session-a"]).toBe(undefined)
    expect(source.getState().todo["session-a"]).toBe(undefined)
    expect(source.getState().permission["session-a"]).toBe(undefined)
    expect(source.getState().question["session-a"]).toBe(undefined)
    expect(source.getState().message["session-a"]).toBe(undefined)
    expect(source.getState().part["message-a"]).toBe(undefined)
    expect(destination.getState().session[0]?.id).toBe("session-a")
    expect(destination.getState().sessionTotal).toBe(1)
    expect((destination.getState().session[0] as SessionWithDirectory)?.directory).toBe("/destination")
    expect(destination.getState().session_status["session-a"]?.type).toBe("idle")
    expect(destination.getState().session_diff["session-a"]?.[0]?.file).toBe("changed.ts")
    expect(destination.getState().todo["session-a"]?.[0]?.content).toBe("Check move")
    expect(destination.getState().permission["session-a"]?.[0]?.id).toBe("permission-a")
    expect(destination.getState().question["session-a"]?.[0]?.id).toBe("question-a")
    expect(destination.getState().message["session-a"]?.[0]?.id).toBe("message-a")
    expect(destination.getState().part["message-a"]?.[0]?.id).toBe("part-a")
    expect(registeredSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/destination" }])
    expect(movedSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/destination" }])
    expect((globalUpsertedSessions[0] as SessionWithDirectory).directory).toBe("/destination")

    await moveSessionToDirectory(destination.getState().session[0], "/destination", "/source", true)

    expect(replyCalls.filter((call) => call.method === "controlPlane.moveSession")[1]?.params.moveChanges).toBe(true)
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
    sessionUpdateResult = {}
    beforeSessionUpdateResolve = null
    beforeSessionDeleteResolve = null
  })

  test("does not remove live or persisted state when delete fails", async () => {
    sessionDeleteError = new Error("delete failed")
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { deleteSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await deleteSessions(["session-a", "session-b", "session-c"])

    // session-a was committed before the switch; session-b's response is stale
    // and session-c is never attempted, so both are reported as failures.
    expect(result).toEqual({ deletedIds: ["session-a"], failedIds: ["session-b", "session-c"] })
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-b", "session-c"])
    expect(globalRemovedSessionIds).toEqual(["session-a"])
    expect(replyCalls.filter((call) => call.method === "session.delete").map((call) => call.params.sessionID))
      .toEqual(["session-a", "session-b"])
  })

  test("does not archive locally until the server returns the archived session", async () => {
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(false)
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalUpsertedSessions).toEqual([])
  })

  test("moves the session to archived state after server confirmation", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 2 } } as Session,
    }
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(true)
    expect(source.getState().session).toEqual([])
    expect((globalUpsertedSessions[0] as Session)?.time?.archived).toBe(2)
  })

  test("rejects an archive response that arrives after a runtime switch", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 2 } } as Session,
    }
    const source = createStore({}, {
      session: [{ id: "session-a", directory: "/test/project", time: { created: 1 } } as Session],
    })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://archive-runtime-a.test", runtimeKey: "archive-runtime-a" })
    beforeSessionUpdateResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://archive-runtime-b.test", runtimeKey: "archive-runtime-b" })
    }
    const { archiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await archiveSession("session-a")).toBe(false)
    expect(getRuntimeKey()).toBe("archive-runtime-b")
    // The stale response must not reconcile the runtime the user switched to.
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-a"])
    expect(globalUpsertedSessions).toEqual([])
  })

  test("keeps confirmed sessions and fails the rest when the runtime changes mid-batch", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 2 } } as Session,
    }
    const source = createStore({}, {
      session: [
        { id: "session-a", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-b", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-c", directory: "/test/project", time: { created: 1 } } as Session,
      ],
    })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://archive-batch-a.test", runtimeKey: "archive-batch-a" })
    beforeSessionUpdateResolve = (sessionId) => {
      if (sessionId === "session-b") {
        switchRuntimeEndpoint({ apiBaseUrl: "http://archive-batch-b.test", runtimeKey: "archive-batch-b" })
      }
    }
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b", "session-c"])

    // session-a was confirmed before the switch and stays archived; session-b's
    // response is stale and session-c is never attempted, so both are reported
    // as failures instead of being silently dropped.
    expect(result).toEqual({ archivedIds: ["session-a"], failedIds: ["session-b", "session-c"] })
    expect(source.getState().session.map((item) => item.id)).toEqual(["session-b", "session-c"])
    expect(globalUpsertedSessions).toHaveLength(1)
    // session-c must not reach the SDK after the runtime changed.
    expect(replyCalls.filter((call) => call.method === "session.update").map((call) => call.params.sessionID))
      .toEqual(["session-a", "session-b"])
  })

  test("archives every session when the runtime stays stable", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 2 } } as Session,
    }
    const source = createStore({}, {
      session: [
        { id: "session-a", directory: "/test/project", time: { created: 1 } } as Session,
        { id: "session-b", directory: "/test/project", time: { created: 1 } } as Session,
      ],
    })
    const { getRuntimeKey } = await import("../lib/runtime-switch")
    const { archiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await archiveSessions(["session-a", "session-b"], {
      expectedRuntimeKey: getRuntimeKey(),
    })

    expect(result).toEqual({ archivedIds: ["session-a", "session-b"], failedIds: [] })
    expect(source.getState().session).toEqual([])
  })
})

describe("session restore (unarchive)", () => {
  beforeEach(() => {
    replyCalls.length = 0
    registeredSessionDirectories.length = 0
    globalUpsertedSessions.length = 0
    sessionUpdateResult = {}
    beforeSessionUpdateResolve = null
  })

  test("does not restore locally until the server returns the restored session", async () => {
    const source = createStore({}, {
      session: [],
    })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(false)
    expect(globalUpsertedSessions).toEqual([])
    expect(registeredSessionDirectories).toEqual([])
  })

  test("sends the archive-clearing sentinel and upserts the restored session after confirmation", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 0 } } as Session,
    }
    const source = createStore({}, {
      session: [],
    })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(true)
    // The server cannot clear time.archived over HTTP, so the action must
    // write the falsy sentinel rather than omitting the field.
    expect(replyCalls.filter((call) => call.method === "session.update")).toEqual([{
      method: "session.update",
      params: { sessionID: "session-a", time: { archived: 0 }, directory: "/test/project" },
    }])
    expect((globalUpsertedSessions[0] as Session)?.time?.archived).toBe(0)
    expect(registeredSessionDirectories).toEqual([{ sessionID: "session-a", directory: "/test/project" }])
  })

  test("fails when the server keeps the session archived", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 2 } } as Session,
    }
    const source = createStore({}, {
      session: [],
    })
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    // A silent server-side no-op must surface as a failure, not a success toast.
    expect(await unarchiveSession("session-a")).toBe(false)
    expect(globalUpsertedSessions).toEqual([])
    expect(registeredSessionDirectories).toEqual([])
  })

  test("rejects a restore response that arrives after a runtime switch", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 0 } } as Session,
    }
    const source = createStore({}, {
      session: [],
    })
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://restore-runtime-a.test", runtimeKey: "restore-runtime-a" })
    beforeSessionUpdateResolve = () => {
      switchRuntimeEndpoint({ apiBaseUrl: "http://restore-runtime-b.test", runtimeKey: "restore-runtime-b" })
    }
    const { unarchiveSession, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    expect(await unarchiveSession("session-a")).toBe(false)
    expect(getRuntimeKey()).toBe("restore-runtime-b")
    // The stale response must not reconcile the runtime the user switched to.
    expect(globalUpsertedSessions).toEqual([])
    expect(registeredSessionDirectories).toEqual([])
  })

  test("keeps confirmed sessions and fails the rest when the runtime changes mid-batch", async () => {
    sessionUpdateResult = {
      data: { id: "session-a", directory: "/test/project", time: { created: 1, archived: 0 } } as Session,
    }
    const source = createStore({}, {
      session: [],
    })
    const { switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://restore-batch-a.test", runtimeKey: "restore-batch-a" })
    beforeSessionUpdateResolve = (sessionId) => {
      if (sessionId === "session-b") {
        switchRuntimeEndpoint({ apiBaseUrl: "http://restore-batch-b.test", runtimeKey: "restore-batch-b" })
      }
    }
    const { unarchiveSessions, setActionRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, createChildStores([["/test/project", source]]), () => "/test/project")

    const result = await unarchiveSessions(["session-a", "session-b", "session-c"])

    // session-a was confirmed before the switch and stays restored; session-b's
    // response is stale and session-c is never attempted, so both are reported
    // as failures instead of being silently dropped.
    expect(result).toEqual({ restoredIds: ["session-a"], failedIds: ["session-b", "session-c"] })
    expect(globalUpsertedSessions).toHaveLength(1)
    // session-c must not reach the SDK after the runtime changed.
    expect(replyCalls.filter((call) => call.method === "session.update").map((call) => call.params.sessionID))
      .toEqual(["session-a", "session-b"])
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

describe("shareSession live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    sessionShareResult = {}
  })

  test("updates the directory live store after unsharing", async () => {
    const sharedSession = { id: "session-a", time: { created: 1 }, share: { url: "https://share.example/a" } } as Session
    const unsharedSession = { id: "session-a", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const otherStore = createStore({}, { session: [{ id: "other", time: { created: 1 } } as Session] })
    const childStores = createChildStores([
      ["/test/project", sessionStore],
      ["/other/project", otherStore],
    ])
    sessionShareResult = { data: unsharedSession }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await unshareSession("session-a")

    expect(result).toEqual({ ...unsharedSession, share: undefined })
    expect(replyCalls.find((call) => call.method === "session.unshare")?.params.directory).toBe("/test/project")
    expect(sessionStore.getState().session[0].share).toBe(undefined)
    expect(otherStore.getState().session[0].id).toBe("other")
    expect(globalUpsertedSessions).toEqual([{ ...unsharedSession, share: undefined }])
  })

  test("clears a stale share URL echoed by a successful unshare response", async () => {
    const sharedSession = { id: "session-a", time: { created: 1 }, share: { url: "https://share.example/a" } } as Session
    const staleResponse = { id: "session-a", time: { created: 1, updated: 2 }, share: { url: "https://share.example/a" } } as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: staleResponse }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await unshareSession("session-a")

    expect(result?.share).toBe(undefined)
    expect(sessionStore.getState().session[0].share).toBe(undefined)
    expect((globalUpsertedSessions[0] as Session).share).toBe(undefined)
  })

  test("updates the directory live store after sharing", async () => {
    const unsharedSession = { id: "session-a", time: { created: 1 } } as Session
    const sharedSession = { id: "session-a", time: { created: 1, updated: 2 }, share: { url: "https://share.example/a" } } as Session
    const sessionStore = createStore({}, { session: [unsharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: sharedSession }

    const { setActionRefs, shareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await shareSession("session-a")

    expect(result).toBe(sharedSession)
    expect(replyCalls.find((call) => call.method === "session.share")?.params.directory).toBe("/test/project")
    expect(sessionStore.getState().session[0].share?.url).toBe("https://share.example/a")
    expect(globalUpsertedSessions).toEqual([sharedSession])
  })

  test("preserves live directory metadata while normalizing a null share response", async () => {
    const sharedSession = {
      id: "session-a",
      time: { created: 1 },
      directory: "/test/project",
      project: { worktree: "/test/project" },
      share: { url: "https://share.example/a" },
    } as SessionWithDirectory
    const unsharedSession = {
      id: "session-a",
      time: { created: 1, updated: 2 },
      share: null,
    } as unknown as Session
    const sessionStore = createStore({}, { session: [sharedSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: unsharedSession }

    const { setActionRefs, unshareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await unshareSession("session-a")

    const liveSession = sessionStore.getState().session[0] as SessionWithDirectory
    expect(liveSession.share).toBe(undefined)
    expect(liveSession.directory).toBe("/test/project")
    expect(liveSession.project?.worktree).toBe("/test/project")
  })

  test("strips oversized diff snapshots before updating session stores", async () => {
    const sessionWithDiff = {
      id: "session-a",
      time: { created: 1, updated: 2 },
      share: { url: "https://share.example/a" },
      summary: {
        diffs: [{ file: "a.txt", before: "old", after: "new", additions: 1, deletions: 1 }],
      },
    } as unknown as Session
    const sessionStore = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionShareResult = { data: sessionWithDiff }

    const { setActionRefs, shareSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    const result = await shareSession("session-a")

    const storedDiff = ((sessionStore.getState().session[0] as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0]
    const globalDiff = (((globalUpsertedSessions[0] as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0])
    const resultDiff = ((result as { summary?: { diffs?: Array<Record<string, unknown>> } }).summary?.diffs ?? [])[0]
    expect(storedDiff.before).toBe(undefined)
    expect(storedDiff.after).toBe(undefined)
    expect(globalDiff.before).toBe(undefined)
    expect(resultDiff.after).toBe(undefined)
  })
})

describe("updateSessionTitle live state", () => {
  beforeEach(() => {
    replyCalls.length = 0
    globalUpsertedSessions.length = 0
    sessionUpdateResult = {}
  })

  test("updates the live directory store after renaming", async () => {
    const oldSession = { id: "session-a", title: "Old Title", time: { created: 1, updated: 1 } } as Session
    const updatedSession = { id: "session-a", title: "New Title", time: { created: 1, updated: 2 } } as Session
    const sessionStore = createStore({}, { session: [oldSession] })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionUpdateResult = { data: updatedSession }

    const { setActionRefs, updateSessionTitle } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await updateSessionTitle("session-a", "New Title")

    const updateCall = replyCalls.find((call) => call.method === "session.update")
    expect(updateCall?.params.sessionID).toBe("session-a")
    expect(updateCall?.params.title).toBe("New Title")
    expect(updateCall?.params.directory).toBe("/test/project")
    expect(globalUpsertedSessions).toEqual([updatedSession])
    expect(sessionStore.getState().session[0].title).toBe("New Title")
  })
})

describe("optimisticSend target directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionMessagesResult = { data: [] }
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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")
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
      providerID: "provider",
      modelID: "model",
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
    const retainedMessage = { id: "msg_1", role: "user", sessionID: "session-reverted" } as Message
    const revertedMessage = { id: "msg_2", role: "user", sessionID: "session-reverted" } as Message
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: "msg_2" } } as Session],
      message: { "session-reverted": [retainedMessage, revertedMessage] },
      part: { msg_2: [{ id: "part_2", type: "text", text: "old branch" } as Part] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticMessage: Message | null = null
    const optimisticShadow = new Set([revertedMessage.id])

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
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
      providerID: "provider",
      modelID: "model",
      send: async () => {},
    })

    expect(targetStore.getState().session[0].revert).toBe(undefined)
    expect(targetStore.getState().message["session-reverted"].map((message) => message.id)).toEqual([
      "msg_1",
      (optimisticMessage as unknown as Message).id,
    ])
    expect(targetStore.getState().part.msg_2).toBe(undefined)
    expect(optimisticShadow.has(revertedMessage.id)).toBe(false)
    expect(optimisticShadow.has((optimisticMessage as unknown as Message).id)).toBe(true)
  })

  test("restores the reverted branch when sending fails", async () => {
    const retainedMessage = { id: "msg_1", role: "user", sessionID: "session-reverted" } as Message
    const revertedMessage = { id: "msg_2", role: "user", sessionID: "session-reverted" } as Message
    const revertedPart = { id: "part_2", type: "text", text: "old branch" } as Part
    const targetStore = createStore({}, {
      session: [{ id: "session-reverted", revert: { messageID: "msg_2" } } as Session],
      message: { "session-reverted": [retainedMessage, revertedMessage] },
      part: { msg_2: [revertedPart] },
    })
    const childStores = createChildStores([["/target/project", targetStore]])

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
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
      providerID: "provider",
      modelID: "model",
      send: async () => { throw new Error("rejected") },
    })).rejects.toThrow("rejected")

    expect(targetStore.getState().session[0].revert?.messageID).toBe("msg_2")
    expect(targetStore.getState().message["session-reverted"]).toEqual([retainedMessage, revertedMessage])
    expect(targetStore.getState().part.msg_2).toEqual([revertedPart])
  })

  test("allows callers to block final send when runtime changes after optimistic insert", async () => {
    const targetStore = createStore({})
    const childStores = createChildStores([["/target/project", targetStore]])
    let optimisticAdd: OptimisticAddCall | null = null
    let optimisticRemove: OptimisticRemoveCall | null = null
    let finalSendCalled = false
    const { getRuntimeKey, switchRuntimeEndpoint } = await import("../lib/runtime-switch")
    switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-a.test", runtimeKey: "runtime-a" })

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
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
        content: "hello",
        providerID: "provider",
        modelID: "model",
        beforeOptimisticInsert: () => {
          expect(getRuntimeKey()).toBe("runtime-a")
        },
        send: async () => {
          switchRuntimeEndpoint({ apiBaseUrl: "http://runtime-b.test", runtimeKey: "runtime-b" })
          if (getRuntimeKey() !== "runtime-a") throw new Error("Auto-review stopped because the runtime changed.")
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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
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
      providerID: "provider",
      modelID: "model",
      send: async (messageID) => {
        sentMessageID = messageID
        sessionMessagesResult = {
          data: [{
            info: { id: messageID, role: "user", sessionID: "session-confirmed", time: { created: 1 } } as Message,
            parts: [{ id: "server-part", type: "text", text: "hello" } as Part],
          }],
        }
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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
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
      providerID: "provider",
      modelID: "model",
      send: async (messageID) => {
        sentMessageID = messageID
        sessionMessagesResult = {
          data: [{
            info: { id: messageID, role: "user", sessionID: "session-tunnel", time: { created: 1 } } as Message,
            parts: [{ id: "server-part", type: "text", text: "hello" } as Part],
          }],
        }
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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/target/project")
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
        providerID: "provider",
        modelID: "model",
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
    scopedClientDirectories.length = 0
    sessionRevertResult = {}
  })

  test("passes directory from child store when permission is found", async () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-a", "perm-1", "once")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-1")
    expect(replyCalls[0].params.reply).toBe("once")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })

  test("passes directory from session mapping when permission not in store", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-b", "perm-2", "always")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-2")
    expect(replyCalls[0].params.reply).toBe("always")
    expect(replyCalls[0].params.directory).toBe("/other/project")
  })

  test("passes directory from current directory as last resort", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/fallback/dir")

    await respondToPermission("unknown-session", "perm-3", "reject")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-3")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/fallback/dir")
  })

  test("uses an explicit event directory before incomplete local routing state", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/stale/current")

    await respondToPermission("unknown-session", "perm-event", "once", "/event/project")

    expect(scopedClientDirectories).toContain("/event/project")
    expect(replyCalls[0].params.directory).toBe("/event/project")
  })
})

describe("revertToMessage passes session directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    sessionRevertResult = {}
    Object.assign(inputState, {
      pendingInputText: "previous draft",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
    })
  })

  test("routes revert through the session directory instead of the current directory", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
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
    sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/current/project")

    await revertToMessage("session-a", "msg_2")

    expect(replyCalls.find((call) => call.method === "session.revert")?.params.directory).toBe("/test/project")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert?.messageID).toBe("msg_2")
    expect(currentStore.getState().session).toHaveLength(0)
    expect(inputState.pendingInputText).toBe("edit this")
  })

  test("rolls back optimistic revert when the SDK returns an error", async () => {
    const session = { id: "session-a", time: { created: 1 } } as Session
    const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
    const sessionStore = createStore({}, {
      session: [session],
      message: { "session-a": [targetMessage] },
      part: { "msg_2": [targetPart] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionRevertResult = { error: { message: "rejected" }, response: { status: 500 } }

    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown
    try {
      await revertToMessage("session-a", "msg_2")
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("session.revert failed (500)")
    expect((sessionStore.getState().session[0] as Session & { revert?: { messageID?: string } }).revert).toBe(undefined)
    expect(inputState.pendingInputText).toBe("previous draft")
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
    permissionReplyError = null
  })

  test("passes directory and reply=reject", async () => {
    const permission: PermissionRequest = {
      id: "perm-10",
      sessionID: "session-a",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await dismissPermission("session-a", "perm-10")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-10")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("respondToQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("passes directory to question.reply", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("session-a", "q-1", [["answer1"]])

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-1")
    expect(replyCalls[0].params.directory).toBe("/test/project")
    expect(scopedClientDirectories).toEqual(["/test/project"])
  })

  test("removes stale question from child store when reply returns not found", async () => {
    const question: QuestionRequest = {
      id: "q-stale",
      sessionID: "session-a",
      questions: [
        {
          question: "Choose an option",
          header: "Choice",
          options: [{ label: "Yes", description: "Proceed" }],
        },
      ],
    }
    const store = createStore({}, { question: { "session-a": [question] } })
    const childStores = createChildStores([["/test/project", store]])
    questionReplyError = Object.assign(new Error("question.reply failed (404): QuestionNotFoundError"), { status: 404 })

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    let thrown: unknown
    try {
      await respondToQuestion("session-a", "q-stale", [["Yes"]])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(store.getState().question["session-a"]).toBe(undefined)
  })
})

describe("rejectQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("passes directory to question.reject", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, rejectQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await rejectQuestion("session-a", "q-2")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-2")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

function buildQuestion(id: string, sessionId: string): QuestionRequest {
  return {
    id,
    sessionID: sessionId,
    questions: [
      {
        question: "Choose an option",
        header: "Choice",
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  }
}

function buildPermission(id: string, sessionId: string): PermissionRequest {
  return {
    id,
    sessionID: sessionId,
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
  }
}

describe("dismissOpenQuestionsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    questionReplyError = null
  })

  test("returns false and rejects nothing when no questions are pending", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(false)
    expect(replyCalls.filter((call) => call.method === "question.reject")).toHaveLength(0)
  })

  test("rejects every pending question in the session subtree (root + subagent child)", async () => {
    const rootQuestion = buildQuestion("q-root", "session-a")
    const childQuestion = buildQuestion("q-child", "session-child")
    const store = createStore({}, {
      session: [
        { id: "session-a", time: { created: 1 } } as Session,
        { id: "session-child", parentID: "session-a", time: { created: 2 } } as Session,
      ],
      question: {
        "session-a": [rootQuestion],
        "session-child": [childQuestion],
      },
    })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(2)
    const rejectedIds = rejectCalls.map((call) => call.params.requestID).sort()
    expect(rejectedIds).toEqual(["q-child", "q-root"])
    // Optimistic clear: the questions are removed from the local store so the
    // prompt disappears instantly, without waiting for the reject round-trip.
    expect(store.getState().question["session-a"]).toBe(undefined)
    expect(store.getState().question["session-child"]).toBe(undefined)
  })

  test("swallows QuestionNotFoundError so a stranded question never blocks the send", async () => {
    const staleQuestion = buildQuestion("q-stale", "session-a")
    const store = createStore({}, {
      session: [{ id: "session-a", time: { created: 1 } } as Session],
      question: { "session-a": [staleQuestion] },
    })
    const childStores = createChildStores([["/test/project", store]])
    questionRejectError = Object.assign(new Error("question.reject failed (404): QuestionNotFoundError"), { status: 404 })

    const { setActionRefs, dismissOpenQuestionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    const dismissed = await dismissOpenQuestionsForSession("session-a")

    expect(dismissed).toBe(true)
    const rejectCalls = replyCalls.filter((call) => call.method === "question.reject")
    expect(rejectCalls).toHaveLength(1)
    expect(rejectCalls[0].params.requestID).toBe("q-stale")
    // The stale entry is cleared from the store even though the server reported not-found.
    expect(store.getState().question["session-a"]).toBe(undefined)
  })
})

describe("dismissPermission not-found handling", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    permissionReplyError = null
  })

  test("clears the stale permission and rethrows on PermissionNotFoundError", async () => {
    const permission = buildPermission("perm-stale", "session-a")
    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])
    permissionReplyError = Object.assign(new Error("permission.reply failed (404): PermissionNotFoundError"), { status: 404 })

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await expect(dismissPermission("session-a", "perm-500")).rejects.toThrow()
    // A non-not-found failure leaves store reconciliation to the next server event.
    expect(store.getState().permission["session-a"]).toHaveLength(1)
  })
})

describe("dismissOpenPermissionsForSession", () => {
  beforeEach(() => {
    replyCalls.length = 0
    scopedClientDirectories.length = 0
    permissionReplyError = null
  })

  test("returns false and rejects nothing when no permissions are pending", async () => {
    const store = createStore({}, { session: [{ id: "session-a", time: { created: 1 } } as Session] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissOpenPermissionsForSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

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
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

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
