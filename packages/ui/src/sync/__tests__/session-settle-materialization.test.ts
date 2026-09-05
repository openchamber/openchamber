import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "../types"
import { ChildStoreManager } from "../child-store"
import {
  SessionMessageLoader,
  setImperativeSessionMessageLoader,
  type SessionMessageLoadState,
  type SessionMessageTarget,
} from "../session-message-loader"
import { useNotificationStore } from "../notification-store"

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingQuestions: mock(async () => []),
    listPendingPermissions: mock(async () => []),
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
  useTodosPersistStore: {
    getState: () => ({
      setSessionTodos: () => undefined,
    }),
  },
}))

mock.module("sonner", () => ({
  toast: {
    dismiss: () => undefined,
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}))

const {
  createEventRoutingIndex,
  handleEvent,
  setActiveSession,
} = await import("../sync-context")
const { getRuntimeKey } = await import("@/lib/runtime-switch")

function createSessionFixture(id: string): Session {
  // SAFETY: minimal session fixture for tests
  return { id, title: "Test", time: { created: 1, updated: 1 }, version: "1" } as Session
}

function createUserMessageFixture(id: string, sessionID: string): Message {
  // SAFETY: minimal user message fixture for tests
  return { id, role: "user", sessionID, time: { created: 1 } } as Message
}

function createAssistantMessageFixture(id: string, sessionID: string): Message {
  // SAFETY: minimal assistant message fixture for tests
  return { id, role: "assistant", sessionID, time: { created: 2, completed: 3 } } as Message
}

function createTextPartFixture(id: string, messageID: string, sessionID: string, text: string): Part {
  // SAFETY: minimal text part fixture for tests
  return { id, messageID, sessionID, type: "text", text } as Part
}

function createFailedStepEvent(sessionID: string, messageID: string, name: string, message: string): Event {
  // SAFETY: session.next.step.failed event fixture for tests
  return {
    type: "session.next.step.failed",
    properties: {
      sessionID,
      assistantMessageID: messageID,
      error: { name, message },
    },
  } as Event
}

function createSessionErrorEvent(sessionID: string, name: string, message: string): Event {
  // SAFETY: session.error event fixture for tests
  return {
    type: "session.error",
    properties: {
      sessionID,
      error: { name, message },
    },
  } as Event
}

function createSessionIdleEvent(sessionID: string): Event {
  // SAFETY: session.idle event fixture for tests
  return {
    type: "session.idle",
    properties: { sessionID },
  } as Event
}

function createPartDeltaEvent(sessionID: string, messageID: string, partID: string, delta: string): Event {
  // SAFETY: message.part.delta event fixture for tests
  return {
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, delta },
  } as Event
}

describe("session settlement materialization and error dispatch", () => {
  const refreshTailCalls: Array<{ scope: { directory: string; sessionID: string }; limit?: number }> = []

  class MockSessionMessageLoader extends SessionMessageLoader {
    constructor() {
      // SAFETY: minimal loader instance with mock configuration for test isolation
      super(new ChildStoreManager(), {
        sdk: createOpencodeClient({ baseUrl: "https://test.local" }),
        runtimeKey: "test-runtime",
      })
    }

    override refreshTail = mock(async (target: SessionMessageTarget, limit?: number) => {
      refreshTailCalls.push({ scope: target, limit })
    })

    override getSnapshot = mock((): SessionMessageLoadState => ({
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      limit: 50,
      cursor: undefined,
      complete: true,
      generation: 1,
      updatedAt: Date.now(),
    }))
  }

  const mockLoader = new MockSessionMessageLoader()

  beforeEach(() => {
    refreshTailCalls.length = 0
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {} },
        project: { unseenCount: {}, unseenHasError: {} },
      },
    })
    setImperativeSessionMessageLoader(mockLoader)
    setActiveSession("", "")
  })

  test("session.next.step.failed enqueues settled-error materialization and records error notification", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      ...INITIAL_STATE,
      session: [createSessionFixture("ses_failed")],
      message: {
        ses_failed: [createUserMessageFixture("msg_user_1", "ses_failed")],
      },
    })

    const routingIndex = createEventRoutingIndex()
    setActiveSession("/repo", "ses_failed")

    const failedEvent = createFailedStepEvent("ses_failed", "msg_assistant_1", "APIError", "402 Insufficient Balance")
    handleEvent("/repo", failedEvent, childStores, routingIndex, getRuntimeKey())

    // Check that error was recorded in notification store immediately
    const notifications = useNotificationStore.getState().list
    const errorNotice = notifications.find(
      (n): n is Extract<typeof n, { type: "error" }> => n.session === "ses_failed" && n.type === "error",
    )
    expect(errorNotice).toBeDefined()
    expect(errorNotice?.type).toBe("error")
    expect(errorNotice?.error?.name).toBe("APIError")
    expect(errorNotice?.error?.message).toBe("402 Insufficient Balance")

    // Allow the async materialization microtask to run
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Check that refreshTail was triggered to fetch the authoritative assistant error message
    expect(refreshTailCalls).toHaveLength(1)
    expect(refreshTailCalls[0]?.scope).toEqual({ directory: "/repo", sessionID: "ses_failed" })
  })

  test("session.error enqueues settled-error materialization and records error notification", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      ...INITIAL_STATE,
      session: [createSessionFixture("ses_error")],
      message: {
        ses_error: [createUserMessageFixture("msg_user_2", "ses_error")],
      },
    })

    const routingIndex = createEventRoutingIndex()
    setActiveSession("/repo", "ses_error")

    const errorEvent = createSessionErrorEvent("ses_error", "ProviderError", "Connection failed")
    handleEvent("/repo", errorEvent, childStores, routingIndex, getRuntimeKey())

    const notifications = useNotificationStore.getState().list
    const errorNotice = notifications.find(
      (n): n is Extract<typeof n, { type: "error" }> => n.session === "ses_error" && n.type === "error",
    )
    expect(errorNotice).toBeDefined()
    expect(errorNotice?.error?.name).toBe("ProviderError")
    expect(errorNotice?.error?.message).toBe("Connection failed")

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(refreshTailCalls).toHaveLength(1)
    expect(refreshTailCalls[0]?.scope).toEqual({ directory: "/repo", sessionID: "ses_error" })
  })

  test("session.idle on an unanswered user turn enqueues settled-unanswered-turn materialization", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      ...INITIAL_STATE,
      session: [createSessionFixture("ses_unanswered")],
      message: {
        ses_unanswered: [createUserMessageFixture("msg_user_3", "ses_unanswered")],
      },
    })

    const routingIndex = createEventRoutingIndex()
    setActiveSession("/repo", "ses_unanswered")

    const idleEvent = createSessionIdleEvent("ses_unanswered")
    handleEvent("/repo", idleEvent, childStores, routingIndex, getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(refreshTailCalls).toHaveLength(1)
    expect(refreshTailCalls[0]?.scope).toEqual({ directory: "/repo", sessionID: "ses_unanswered" })
  })

  test("session.idle on an already answered assistant turn does not enqueue materialization", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      ...INITIAL_STATE,
      session: [createSessionFixture("ses_answered")],
      message: {
        ses_answered: [
          createUserMessageFixture("msg_user_4", "ses_answered"),
          createAssistantMessageFixture("msg_assistant_4", "ses_answered"),
        ],
      },
      part: {
        msg_assistant_4: [
          createTextPartFixture("prt_1", "msg_assistant_4", "ses_answered", "Hello"),
        ],
      },
    })

    const routingIndex = createEventRoutingIndex()
    setActiveSession("/repo", "ses_answered")

    const idleEvent = createSessionIdleEvent("ses_answered")
    handleEvent("/repo", idleEvent, childStores, routingIndex, getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(refreshTailCalls).toHaveLength(0)
  })

  test("settlement materialization supersedes earlier non-settlement recovery cooldown", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      ...INITIAL_STATE,
      session: [createSessionFixture("ses_supersede")],
      message: {
        ses_supersede: [createUserMessageFixture("msg_user_5", "ses_supersede")],
      },
    })

    const routingIndex = createEventRoutingIndex()
    setActiveSession("/repo", "ses_supersede")

    // First trigger a missing-delta-part recovery event
    const deltaEvent = createPartDeltaEvent("ses_supersede", "msg_assistant_5", "prt_missing", "chunk")
    handleEvent("/repo", deltaEvent, childStores, routingIndex, getRuntimeKey())

    // Immediately trigger session.next.step.failed (within cooldown window)
    const failedEvent = createFailedStepEvent("ses_supersede", "msg_assistant_5", "APIError", "402 Insufficient Balance")
    handleEvent("/repo", failedEvent, childStores, routingIndex, getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, 10))

    // Both should have proceeded (settlement was not blocked by delta recovery cooldown)
    expect(refreshTailCalls.length).toBeGreaterThanOrEqual(1)
    expect(refreshTailCalls.some((call) => call.scope.sessionID === "ses_supersede")).toBe(true)
  })
})
