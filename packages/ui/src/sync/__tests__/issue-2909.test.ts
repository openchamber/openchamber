import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"

// ---------------------------------------------------------------------------
// issue-2909 — "after the update, sending a prompt makes the user's message
// disappear from the chat; no model execution is visible; the run later shows
// as complete; reopening the session shows a network error"
//
// Root cause under test: the sortable message-ID prefix (6 bytes, wraps every
// 2^36 ms ≈ 2.18 years) rolled over at 2026-08-14T11:19:55Z — the day of the
// v1.18.4 release and of this report. After the rollover a newly created
// message gets an ID like `msg_000d…` that is lexically SMALLER than every
// pre-existing `msg_ffff…` ID, so ID-ordering (still used by the OpenCode
// server for its "recent N messages" window and cursors) no longer matches
// chronological order.
//
// `fetchRecentSendConfirmationRecords` (session-actions.ts) answers "did my
// send land?" by fetching `session.messages({ limit: 30 })` and checking
// whether the sent ID is in the returned window. After the rollover the
// freshly-sent post-rollover message sorts BELOW all pre-rollover records, so
// it is missing from the ID-ordered window and the client rolls an ACCEPTED
// prompt back: the user's message vanishes, no assistant output is shown, the
// run still completes server-side, and reopening the session shows a stale or
// failed transcript.
//
// The failing test below encodes the expected behavior (an accepted prompt
// must not be rolled back purely because the ID-ordered window missed it) and
// fails against current main. The passing test proves the lexical inversion.
// ---------------------------------------------------------------------------

let sessionMessagesResult: { data?: unknown; error?: unknown; response?: { status?: number } } = { data: [] }
/** Records the server accepted — served by the direct per-message fetch. */
const sessionMessageRecords = new Map<string, { info: Message; parts: Part[] }>()
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []

const mockSdk = {
  session: {
    messages: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.messages", params })
      return Promise.resolve(sessionMessagesResult)
    }),
    message: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.message", params })
      const record = sessionMessageRecords.get(String(params.messageID))
      if (record) return Promise.resolve({ data: record })
      return Promise.resolve({ error: { message: "not found" }, response: { status: 404 } })
    }),
  },
} as unknown as OpencodeClient

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: () => null,
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    setDirectory: () => {},
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      lastDisconnectReason: null,
      probeConnection: async () => true,
    }),
  },
}))

mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => null,
      currentSessionId: null,
      setCurrentSession: () => {},
      setSessionDirectory: () => {},
    }),
  },
}))

mock.module("./input-store", () => ({
  useInputStore: {
    getState: () => ({
      pendingInputText: "",
      pendingInputMode: "normal" as const,
      attachedFiles: [],
      clearAttachedFiles: () => {},
      addRestoredAttachment: () => {},
    }),
    setState: () => {},
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: () => null,
  mergeSessionDirectoryMetadata: (incoming: Session) => incoming,
  isGlobalSessionRecencyOnlyUpdate: () => false,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      upsertSession: () => {},
      removeSessions: () => {},
    }),
  },
}))

mock.module("./session-deletion-cleanup", () => ({
  cleanupPersistedSessionState: () => {},
}))

mock.module("./sync-refs", () => ({
  getSyncSessionDirectory: () => null,
  registerSessionDirectory: () => {},
}))

function createStore(state?: Partial<DirectoryStore>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
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
  } as unknown as import("../child-store").ChildStoreManager
}

const HIGH_ID_PREFIX = "msg_fffff"
const LOW_ID_PREFIX = "msg_00000"

/** 30 pre-rollover messages (high `msg_ffff…` IDs, ascending time.created). */
function buildPreRolloverMessages(count: number, sessionID: string): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${HIGH_ID_PREFIX}${String(index + 1).padStart(4, "0")}`,
    role: index % 2 === 0 ? "user" : "assistant",
    sessionID,
    parentID: "",
    modelID: "",
    providerID: "",
    system: "",
    agent: "",
    model: "",
    metadata: {},
    time: { created: index + 1, completed: index % 2 === 0 ? 0 : index + 1 },
  })) as unknown as Message[]
}

/** Simulates the OpenCode server's ID-ordered "recent N" message window. */
function idOrderedRecentWindow(serverList: Array<{ info: Message; parts: Part[] }>, limit: number) {
  return [...serverList]
    .sort((a, b) => (a.info.id < b.info.id ? 1 : a.info.id > b.info.id ? -1 : 0))
    .slice(0, limit)
}

describe("issue-2909 — post-rollover prompt send is rolled back although the server accepted it", () => {
  beforeEach(() => {
    replyCalls.length = 0
    sessionMessagesResult = { data: [] }
    sessionMessageRecords.clear()
  })

  test("new message IDs now sort BEFORE pre-rollover IDs (lexical inversion)", () => {
    const preRollover = buildPreRolloverMessages(1, "session-x")[0]
    expect(preRollover.id.startsWith(HIGH_ID_PREFIX)).toBe(true)
    // `ascendingId` derives the 6-byte prefix from `now * 0x1000`, which
    // wrapped at 2026-08-14T11:19:55Z. Any ID generated today starts with a
    // small `msg_0000…` prefix and therefore sorts before every `msg_ffff…`
    // ID created before the rollover.
    expect(`${LOW_ID_PREFIX}0001` < preRollover.id).toBe(true)
  })

  test("an accepted prompt survives an ambiguous send failure even when the ID-ordered window misses its post-rollover ID", async () => {
    const sessionID = "session-rollover"
    const directory = "/test/project"
    const existing = buildPreRolloverMessages(30, sessionID)

    const store = createStore({
      session: [{ id: sessionID, title: "Existing chat" } as Session],
      message: { [sessionID]: existing },
      part: Object.fromEntries(existing.map((m) => [m.id, [] as Part[]])),
      session_status: { [sessionID]: { type: "idle" } },
    })
    const childStores = createChildStores([[directory, store]])

    // The server's full message list: the 30 pre-rollover records PLUS the
    // prompt the server accepted. Its "recent 30" window is ID-ordered, so
    // the post-rollover `msg_0000…` prompt sorts below all `msg_ffff…`
    // records and is excluded from the window the client sees.
    const serverList: Array<{ info: Message; parts: Part[] }> = existing.map((m) => ({ info: m, parts: [] as Part[] }))
    let sentMessageID = ""

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("../session-actions")
    setActionRefs(mockSdk, childStores, () => directory)
    setOptimisticRefs(
      (input) => {
        store.setState((state) => ({
          message: {
            ...state.message,
            [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message],
          },
          part: { ...state.part, [input.message.id]: input.parts },
        }))
      },
      (input) => {
        store.setState((state) => ({
          message: {
            ...state.message,
            [input.sessionID]: (state.message[input.sessionID] ?? []).filter((m) => m.id !== input.messageID),
          },
          part: Object.fromEntries(Object.entries(state.part).filter(([id]) => id !== input.messageID)),
        }))
      },
      (input) => {
        // optimisticConfirm — the accepted message is confirmed, not rolled back.
        void input
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: sessionID,
        directory,
        content: "please fix the bug",
        providerID: "provider",
        modelID: "model",
        onMessageID: (messageID) => {
          sentMessageID = messageID
        },
        send: async (messageID) => {
          sentMessageID = messageID
          // The server ACCEPTS the prompt and starts a run; the HTTP response
          // is then lost, so the client sees an ambiguous failure. The
          // confirmation refetch gets the ID-ordered recent window.
          const acceptedRecord = {
            info: {
              id: messageID,
              role: "user",
              sessionID,
              parentID: "",
              modelID: "model",
              providerID: "provider",
              system: "",
              agent: "",
              model: "",
              metadata: {},
              time: { created: Date.now(), completed: 0 },
            } as unknown as Message,
            parts: [{ id: "part-1", type: "text", text: "please fix the bug" } as Part],
          }
          serverList.push(acceptedRecord)
          sessionMessageRecords.set(messageID, acceptedRecord)
          sessionMessagesResult = { data: idOrderedRecentWindow(serverList, 30) }
          const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
          error.status = 504
          throw error
        },
      })
    } catch (error) {
      caught = error
    }

    // The prompt IS in the server's full list (it was accepted).
    expect(serverList.some((record) => record.info.id === sentMessageID)).toBe(true)
    // Today's generated ID is post-rollover: it sorts before the old IDs.
    expect(sentMessageID < existing[0].id).toBe(true)
    // The confirmation refetch window (ID-ordered, limit 30) excludes it.
    expect(idOrderedRecentWindow(serverList, 30).some((record) => record.info.id === sentMessageID)).toBe(false)

    // EXPECTED (acceptance): an accepted prompt must not be rolled back just
    // because the ID-ordered recent window misses its post-rollover ID. The
    // send should resolve without error and the message must remain in the
    // chat. Against current main this FAILS: optimisticSend rethrows and the
    // optimistic message is removed.
    expect(caught).toBe(null)
    expect(store.getState().message[sessionID].some((m) => m.id === sentMessageID)).toBe(true)
  })

  test("the direct per-message fetch confirms the accepted prompt even when the recent-window scan would miss it", async () => {
    const sessionID = "session-rollover"
    const directory = "/test/project"
    const existing = buildPreRolloverMessages(30, sessionID)

    const store = createStore({
      session: [{ id: sessionID, title: "Existing chat" } as Session],
      message: { [sessionID]: existing },
      part: Object.fromEntries(existing.map((m) => [m.id, [] as Part[]])),
      session_status: { [sessionID]: { type: "idle" } },
    })
    const childStores = createChildStores([[directory, store]])

    const serverList: Array<{ info: Message; parts: Part[] }> = existing.map((m) => ({ info: m, parts: [] as Part[] }))
    let sentMessageID = ""
    let optimisticRemoveCalled = false

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("../session-actions")
    setActionRefs(mockSdk, childStores, () => directory)
    setOptimisticRefs(
      (input) => {
        store.setState((state) => ({
          message: {
            ...state.message,
            [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message],
          },
          part: { ...state.part, [input.message.id]: input.parts },
        }))
      },
      (input) => {
        optimisticRemoveCalled = true
        store.setState((state) => ({
          message: {
            ...state.message,
            [input.sessionID]: (state.message[input.sessionID] ?? []).filter((m) => m.id !== input.messageID),
          },
          part: Object.fromEntries(Object.entries(state.part).filter(([id]) => id !== input.messageID)),
        }))
      },
    )

    let caught: unknown = null
    try {
      await optimisticSend({
        sessionId: sessionID,
        directory,
        content: "please fix the bug",
        providerID: "provider",
        modelID: "model",
        onMessageID: (messageID) => {
          sentMessageID = messageID
        },
        send: async (messageID) => {
          sentMessageID = messageID
          const acceptedRecord = {
            info: {
              id: messageID,
              role: "user",
              sessionID,
              parentID: "",
              modelID: "model",
              providerID: "provider",
              system: "",
              agent: "",
              model: "",
              metadata: {},
              time: { created: Date.now(), completed: 0 },
            } as unknown as Message,
            parts: [{ id: "part-1", type: "text", text: "please fix the bug" } as Part],
          }
          serverList.push(acceptedRecord)
          sessionMessageRecords.set(messageID, acceptedRecord)
          // The recent-window scan alone would miss the post-rollover ID.
          sessionMessagesResult = { data: idOrderedRecentWindow(serverList, 30) }
          const error = new Error("Failed to send message (504): gateway timeout") as Error & { status?: number }
          error.status = 504
          throw error
        },
      })
    } catch (error) {
      caught = error
    }

    // The direct per-message fetch is the authoritative confirmation: it is
    // keyed by message ID, so it finds the accepted prompt even though the
    // ID-ordered recent window excludes it. The send resolves, the optimistic
    // message is confirmed in place, and nothing is rolled back.
    expect(caught).toBe(null)
    expect(optimisticRemoveCalled).toBe(false)
    expect(replyCalls.some((call) => call.method === "session.message" && call.params.messageID === sentMessageID)).toBe(true)
    expect(store.getState().message[sessionID].some((m) => m.id === sentMessageID)).toBe(true)
    expect(store.getState().part[sentMessageID]?.[0]?.id).toBe("part-1")
  })
})
