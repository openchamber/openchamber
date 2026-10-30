import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { ModelSelection, Session, SessionStatus } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import type { MessagePage } from "@/lib/opencode/client"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { createPendingDraftWorktreeRequest, resolvePendingDraftWorktreeRequest } from "@/lib/worktrees/pendingDraftWorktree"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { ChildStoreManager } from "./child-store"
import { sendRecoveredFormAnswer, setActionRefs, setOptimisticRefs } from "./session-actions"
import { resetRecoverableQuestions } from "./recoverable-questions"
import { SessionMessageLoader, setImperativeSessionMessageLoader, type SessionMessagePageSource } from "./session-message-loader"
import { DraftSendError, useSessionUIStore, type NewSessionDraftState, type PendingDraftSend } from "./session-ui-store"
import { readLastActiveSession } from "./last-session-cache"
import { setSyncRefs } from "./sync-refs"

// The first message of a new session, sent from the draft. The real stores,
// loader and send path run; only OpenCode's answers are scripted, and the
// network is refused so every other read fails fast and is swallowed where
// the code expects it to be.

const DIRECTORY = "/repo"

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Lets the chain of awaits after a resolved promise run. */
const flush = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const sessionRecord = (id: string, directory: string): Session => ({
  id,
  projectID: "project",
  directory,
  title: "New session",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

const openDraft = (draftId: number): NewSessionDraftState => ({
  draftId,
  open: true,
  target: "project",
  selectedProjectId: null,
  directoryOverride: DIRECTORY,
  preparedChatDirectory: null,
  pendingWorktreeRequestId: null,
  bootstrapPendingDirectory: null,
  preserveDirectoryOverride: false,
  parentID: null,
})

const originalClient = {
  createSession: opencodeClient.createSession,
  sendMessage: opencodeClient.sendMessage,
  shellSession: opencodeClient.shellSession,
  directory: opencodeClient.getDirectory(),
}
const originalSelection = useSessionUIStore.getState()
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")

let childStores: ChildStoreManager
let loader: SessionMessageLoader
let historyReads = 0
let creation = deferred<void>()
let createSessionCalls: Array<{ id: string | undefined; directory: string | null | undefined }> = []
let sendCalls: Array<{
  id: string
  model: ModelSelection | undefined
  text: string
  context: string[]
  pendingAtSend: PendingDraftSend | undefined
  statusAtSend: SessionStatus | undefined
}> = []
let shellCalls: string[] = []

const sdk: SessionMessagePageSource = {
  getSessionMessages: async (): Promise<MessagePage> => {
    historyReads += 1
    return { items: [], cursor: {} }
  },
}

const send = (content: string, inputMode: "normal" | "shell" = "normal", draftSnapshot?: NewSessionDraftState) =>
  useSessionUIStore.getState().sendMessage(content, "provider", "model", "build", undefined, undefined, undefined, undefined, inputMode, {
    userInitiated: true,
    draftSnapshot,
  })

const messagesOf = (sessionId: string) => childStores.getChild(DIRECTORY)?.getState().message[sessionId] ?? []

test("a recovered answer uses the real send path without consuming the main composer's armed goal", async () => {
  const session = sessionRecord("ses_question", DIRECTORY)
  childStores.ensureChild(DIRECTORY, { bootstrap: false }).setState({ session: [session] })
  useSessionGoalArmStore.getState().setArmed(true, "main composer objective")
  resetRecoverableQuestions()
  try {
    await sendRecoveredFormAnswer({
      form: { id: "frm_question", sessionID: session.id, title: "Question", fields: [{ key: "q0", type: "string" }] },
      directory: DIRECTORY,
      sessionID: session.id,
      toolMessageID: "msg_question",
      evidence: "tool-interrupted",
    }, "the recovered answer")

    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]?.id).toBe(session.id)
    expect(sendCalls[0]?.text).toBe("the recovered answer")
    expect(useSessionGoalArmStore.getState().armed).toBe(true)
    expect(useSessionGoalArmStore.getState().objectiveOverride).toBe("main composer objective")
  } finally {
    useSessionGoalArmStore.getState().setArmed(false)
    resetRecoverableQuestions()
  }
})

beforeAll(() => {
  const refuse = async () => { throw new Error("network disabled in tests") }
  Object.defineProperty(globalThis, "fetch", { value: refuse, configurable: true, writable: true })
})

afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch)
})

beforeEach(() => {
  historyReads = 0
  creation = deferred<void>()
  createSessionCalls = []
  sendCalls = []
  shellCalls = []
  childStores = new ChildStoreManager()
  loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: getRuntimeKey() })
  setActionRefs(childStores, () => DIRECTORY)
  // The send reads the created record (its model) from the directory store.
  setSyncRefs(opencodeClient.getSdkClient(), childStores, DIRECTORY)
  setOptimisticRefs(
    (input) => loader.optimisticAdd({ ...input, directory: input.directory ?? DIRECTORY }),
    (input) => loader.optimisticRemove({ ...input, directory: input.directory ?? DIRECTORY }),
    (input) => loader.optimisticConfirm({ ...input, directory: input.directory ?? DIRECTORY }),
  )
  setImperativeSessionMessageLoader(loader)
  opencodeClient.setDirectory(DIRECTORY)
  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  opencodeClient.createSession = async (params, directory) => {
    createSessionCalls.push({ id: params?.id, directory })
    await creation.promise
    return sessionRecord(params?.id ?? "ses_server", directory ?? DIRECTORY)
  }
  opencodeClient.sendMessage = async (params) => {
    sendCalls.push({
      id: params.id,
      model: params.model,
      text: params.text,
      context: (params.context ?? []).map((item) => item.text),
      pendingAtSend: useSessionUIStore.getState().pendingDraftSends.get(params.id),
      statusAtSend: childStores.getChild(DIRECTORY)?.getState().session_status[params.id],
    })
    params.beforeSend?.()
    return params.messageId ?? "msg_sent"
  }
  // A shell command answers only when it exits.
  opencodeClient.shellSession = async (params) => {
    shellCalls.push(params.sessionId)
    return new Promise<string>(() => undefined)
  }
})

afterEach(() => {
  opencodeClient.createSession = originalClient.createSession
  opencodeClient.sendMessage = originalClient.sendMessage
  opencodeClient.shellSession = originalClient.shellSession
  opencodeClient.setDirectory(originalClient.directory)
  useSessionUIStore.setState({ ...originalSelection, pendingDraftSends: new Map() })
  setImperativeSessionMessageLoader(null)
  loader.dispose()
  childStores.disposeAll()
})

const startDraftSend = async (draftId: number, content = "hello", inputMode: "normal" | "shell" = "normal") => {
  const draft = openDraft(draftId)
  useSessionUIStore.setState({ newSessionDraft: draft, currentSessionId: null, currentSessionDirectory: null })
  const sending = send(content, inputMode, draft)
  // The awaiter is attached now; a rejection asserted later is not unhandled.
  sending.catch(() => undefined)
  await flush()
  const sessionId = useSessionUIStore.getState().currentSessionId
  if (!sessionId) throw new Error("the draft did not become a session")
  return { draft, sending, sessionId }
}

describe("the first message of a draft", () => {
  test("shows in the selected session before the server answers, then goes out on the session's own model", async () => {
    const { sending, sessionId } = await startDraftSend(1)
    const state = useSessionUIStore.getState()
    const store = childStores.getChild(DIRECTORY)!

    expect(/^ses_/.test(sessionId)).toBe(true)
    expect(state.newSessionDraft.open).toBe(false)
    expect(state.currentSessionDirectory).toBe(DIRECTORY)
    expect(state.pendingDraftSends.get(sessionId)).toEqual({ draftId: 1, sessionCreated: false })
    const [message] = messagesOf(sessionId)
    expect(messagesOf(sessionId)).toHaveLength(1)
    expect(store.getState().part[message.id]?.[0]).toMatchObject({ type: "text", text: "hello" })
    // No agent works yet: the session shows "Creating session…" alone.
    expect(store.getState().session_status[sessionId]).toBeUndefined()
    expect(createSessionCalls).toEqual([{ id: sessionId, directory: DIRECTORY }])
    expect(sendCalls).toEqual([])
    expect(historyReads).toBe(0)

    creation.resolve()
    await sending

    expect(store.getState().session.map((session) => session.id)).toContain(sessionId)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]).toMatchObject({ id: sessionId, text: "hello", model: undefined })
    // The line "Creating session…" is gone once the session exists; Send
    // waits until the prompt request has left.
    expect(sendCalls[0].pendingAtSend).toEqual({ draftId: 1, sessionCreated: true })
    // Busy from the moment the session exists.
    expect(sendCalls[0].statusAtSend).toEqual({ type: "busy" })
    expect(useSessionUIStore.getState().pendingDraftSends.has(sessionId)).toBe(false)
    expect(messagesOf(sessionId)).toHaveLength(1)
  })

  test("a goal write that fails after the server created the session keeps the session, with Send free again", async () => {
    // The goal write reaches the network, which is refused here: it fails
    // after the create response.
    useSessionGoalArmStore.getState().setArmed(true)
    try {
      const { sending, sessionId } = await startDraftSend(11)
      creation.resolve()
      const error = await sending.then(() => null, (reason: DraftSendError) => reason)

      expect(error).toBeInstanceOf(DraftSendError)
      expect(error).toMatchObject({ sessionId, sessionCreated: true })
      const state = useSessionUIStore.getState()
      expect(state.currentSessionId).toBe(sessionId)
      expect(state.newSessionDraft.open).toBe(false)
      expect(state.pendingDraftSends.size).toBe(0)
      expect(createSessionCalls).toHaveLength(1)
      expect(sendCalls).toEqual([])
      expect(messagesOf(sessionId)).toEqual([])
      expect(childStores.getChild(DIRECTORY)?.getState().session.map((session) => session.id)).toContain(sessionId)
      // Nothing reached the agent: the session is not working.
      expect(childStores.getChild(DIRECTORY)?.getState().session_status[sessionId]).toEqual({ type: "idle" })
      // The arm comes back for the next try.
      expect(useSessionGoalArmStore.getState().armed).toBe(true)
    } finally {
      useSessionGoalArmStore.getState().setArmed(false)
    }
  })

  test("a session the server created under another id is not this one: the draft comes back, nothing is sent", async () => {
    opencodeClient.createSession = async (params, directory) => {
      createSessionCalls.push({ id: params?.id, directory })
      await creation.promise
      return sessionRecord("ses_server_minted", directory ?? DIRECTORY)
    }
    const { draft, sending, sessionId } = await startDraftSend(12)
    creation.resolve()
    const error = await sending.then(() => null, (reason: DraftSendError) => reason)

    expect(error).toMatchObject({ sessionId, sessionCreated: false })
    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBeNull()
    expect(state.newSessionDraft).toMatchObject({ open: true, draftId: draft.draftId })
    expect(sendCalls).toEqual([])
    expect(messagesOf(sessionId)).toEqual([])
  })

  test("refuses a second send of the same draft while the session is being created", async () => {
    const { draft, sending, sessionId } = await startDraftSend(2)

    await expect(send("again", "normal", draft)).rejects.toThrow("still being created")

    expect(createSessionCalls).toHaveLength(1)
    expect(messagesOf(sessionId)).toHaveLength(1)
    creation.resolve()
    await sending
    expect(sendCalls).toHaveLength(1)
  })

  test("a shell command releases Send when it starts, not when it exits", async () => {
    const { sessionId } = await startDraftSend(3, "ls", "shell")
    expect(useSessionUIStore.getState().pendingDraftSends.get(sessionId)).toEqual({ draftId: 3, sessionCreated: false })

    creation.resolve()
    await flush()

    expect(shellCalls).toEqual([sessionId])
    expect(useSessionUIStore.getState().pendingDraftSends.has(sessionId)).toBe(false)
    // As in an existing session, the command's row arrives from the server.
    expect(messagesOf(sessionId)).toEqual([])
  })

  test("a session the server did not create takes the message back and reopens the draft", async () => {
    const { draft, sending, sessionId } = await startDraftSend(4)

    creation.reject(new Error("offline"))
    const error = await sending.then(() => null, (reason: DraftSendError) => reason)

    expect(error).toBeInstanceOf(DraftSendError)
    expect(error).toMatchObject({ sessionId, directory: DIRECTORY, sessionCreated: false, message: "Failed to create session" })
    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBeNull()
    expect(state.newSessionDraft).toMatchObject({ open: true, draftId: draft.draftId, directoryOverride: DIRECTORY })
    expect(state.pendingDraftSends.size).toBe(0)
    expect(messagesOf(sessionId)).toEqual([])
    expect(childStores.getChild(DIRECTORY)?.getState().session_status[sessionId]).toEqual({ type: "idle" })
    expect(sendCalls).toEqual([])

    // The same draft can be sent again.
    creation = deferred<void>()
    const retry = send("hello", "normal", draft)
    await flush()
    expect(createSessionCalls).toHaveLength(2)
    creation.resolve()
    await retry
    expect(sendCalls).toHaveLength(1)
  })

  test("a draft that waited for a new worktree reopens on that worktree after a failed creation and can send again", async () => {
    const requestId = createPendingDraftWorktreeRequest()
    const draft: NewSessionDraftState = { ...openDraft(9), directoryOverride: "/repo-root", pendingWorktreeRequestId: requestId }
    useSessionUIStore.setState({ newSessionDraft: draft, currentSessionId: null, currentSessionDirectory: null })
    const sending = send("hello", "normal", draft)
    sending.catch(() => undefined)
    await flush()
    // Still the draft: the worktree is being made.
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()
    expect(createSessionCalls).toEqual([])

    resolvePendingDraftWorktreeRequest(requestId, DIRECTORY)
    await flush()
    const sessionId = useSessionUIStore.getState().currentSessionId
    expect(sessionId).not.toBeNull()
    expect(createSessionCalls).toEqual([{ id: sessionId, directory: DIRECTORY }])

    creation.reject(new Error("offline"))
    await sending.then(() => null, () => null)

    const reopened = useSessionUIStore.getState().newSessionDraft
    expect(reopened).toMatchObject({ open: true, draftId: 9, pendingWorktreeRequestId: null, directoryOverride: DIRECTORY })

    creation = deferred<void>()
    const retry = send("hello", "normal", reopened)
    await flush()
    expect(createSessionCalls).toHaveLength(2)
    expect(createSessionCalls[1].directory).toBe(DIRECTORY)
    creation.resolve()
    await retry
    expect(sendCalls).toHaveLength(1)
  })

  test("a send that fails before the create response waits for it: a created session stays, with Send free again", async () => {
    // "/name" that no store knows gets one live lookup, which fails here
    // before the creation settles.
    const originalListCommands = opencodeClient.listCommands
    opencodeClient.listCommands = async () => { throw new Error("lookup failed") }
    try {
      const { sending, sessionId } = await startDraftSend(8, "/unknown-command")
      let settled = false
      sending.then(() => { settled = true }, () => { settled = true })
      await flush()
      expect(settled).toBe(false)
      expect(useSessionUIStore.getState().pendingDraftSends.get(sessionId)).toEqual({ draftId: 8, sessionCreated: false })

      creation.resolve()
      const error = await sending.then(() => null, (reason: DraftSendError) => reason)

      expect(error).toMatchObject({ sessionId, sessionCreated: true, message: "lookup failed" })
      const state = useSessionUIStore.getState()
      expect(state.currentSessionId).toBe(sessionId)
      expect(state.newSessionDraft.open).toBe(false)
      expect(state.pendingDraftSends.size).toBe(0)
      // The create marked it busy; the failed send takes that back.
      expect(childStores.getChild(DIRECTORY)?.getState().session_status[sessionId]).toEqual({ type: "idle" })
      expect(childStores.getChild(DIRECTORY)?.getState().session.map((session) => session.id)).toContain(sessionId)
    } finally {
      opencodeClient.listCommands = originalListCommands
    }
  })

  test("a created session whose first prompt fails keeps the session and rolls the message back", async () => {
    opencodeClient.sendMessage = async () => {
      throw Object.assign(new Error("rejected"), { status: 400 })
    }
    const { sending, sessionId } = await startDraftSend(5)

    creation.resolve()
    const error = await sending.then(() => null, (reason: DraftSendError) => reason)

    expect(error).toBeInstanceOf(DraftSendError)
    expect(error).toMatchObject({ sessionId, sessionCreated: true })
    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBe(sessionId)
    expect(state.newSessionDraft.open).toBe(false)
    expect(state.pendingDraftSends.size).toBe(0)
    expect(messagesOf(sessionId)).toEqual([])
    expect(childStores.getChild(DIRECTORY)?.getState().session.map((session) => session.id)).toContain(sessionId)
  })

  test("a draft opened meanwhile keeps the view when the first session gets created", async () => {
    const { sending, sessionId } = await startDraftSend(6)

    useSessionUIStore.getState().openNewSessionDraft()
    const nextDraft = useSessionUIStore.getState().newSessionDraft
    expect(nextDraft.open).toBe(true)
    expect(nextDraft.draftId).not.toBe(6)

    creation.resolve()
    await sending

    const state = useSessionUIStore.getState()
    expect(state.currentSessionId).toBeNull()
    expect(state.newSessionDraft).toBe(nextDraft)
    expect(messagesOf(sessionId)).toHaveLength(1)
    expect(sendCalls).toHaveLength(1)
  })

  test("switching away and back during creation shows the one message without a history read", async () => {
    const { sending, sessionId } = await startDraftSend(7)

    useSessionUIStore.getState().setCurrentSession("ses_other", DIRECTORY)
    creation.resolve()
    await sending
    expect(useSessionUIStore.getState().currentSessionId).toBe("ses_other")

    const readsBefore = historyReads
    useSessionUIStore.getState().setCurrentSession(sessionId, DIRECTORY)
    await flush()

    expect(useSessionUIStore.getState().currentSessionId).toBe(sessionId)
    expect(messagesOf(sessionId)).toHaveLength(1)
    expect(historyReads).toBe(readsBefore)
  })

  test("a runtime switch during creation keeps the draft and its text on the captured runtime", async () => {
    const originalRuntimeKey = getRuntimeKey()
    const originalApiBaseUrl = getRuntimeApiBaseUrl()
    try {
      const { draft, sending } = await startDraftSend(13)

      useSessionUIStore.getState().prepareForRuntimeSwitch(originalRuntimeKey)
      switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-switched.test", runtimeKey: "runtime-switched" })
      creation.resolve()
      const error = await sending.then(() => null, (reason: DraftSendError) => reason)

      expect(error).toBeInstanceOf(DraftSendError)
      expect(error).toMatchObject({ sessionCreated: false })
      // The captured runtime forgets the empty session and keeps the draft.
      expect(readLastActiveSession(originalRuntimeKey)).toBeNull()

      useSessionUIStore.getState().restoreForRuntimeSwitch(originalRuntimeKey, "runtime-switched")
      const state = useSessionUIStore.getState()
      expect(state.currentSessionId).toBeNull()
      expect(state.newSessionDraft).toMatchObject({ open: true, draftId: draft.draftId })
    } finally {
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey })
      useSessionUIStore.getState().restoreForRuntimeSwitch(originalRuntimeKey, "runtime-switched")
    }
  })

  test("a runtime switch during creation keeps a draft the user opened afterwards", async () => {
    const originalRuntimeKey = getRuntimeKey()
    const originalApiBaseUrl = getRuntimeApiBaseUrl()
    try {
      const { sending } = await startDraftSend(14)
      useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: "/other", preserveDirectoryOverride: true })
      const newerDraftId = useSessionUIStore.getState().newSessionDraft.draftId

      useSessionUIStore.getState().prepareForRuntimeSwitch(originalRuntimeKey)
      switchRuntimeEndpoint({ apiBaseUrl: "https://runtime-switched.test", runtimeKey: "runtime-switched-2" })
      creation.resolve()
      await sending.then(() => null, () => null)

      useSessionUIStore.getState().restoreForRuntimeSwitch(originalRuntimeKey, "runtime-switched-2")
      const state = useSessionUIStore.getState()
      expect(state.currentSessionId).toBeNull()
      expect(state.newSessionDraft).toMatchObject({ open: true, draftId: newerDraftId })
    } finally {
      switchRuntimeEndpoint({ apiBaseUrl: originalApiBaseUrl, runtimeKey: originalRuntimeKey })
      useSessionUIStore.getState().restoreForRuntimeSwitch(originalRuntimeKey, "runtime-switched-2")
    }
  })
})
