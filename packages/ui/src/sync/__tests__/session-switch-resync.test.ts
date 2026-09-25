import { describe, expect, test, beforeEach, mock } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { SyncEvent, ToolTransition } from "@/lib/opencode/events"
import type { FormRequest, PermissionRequest } from "@/lib/opencode/model"

const listPendingFormsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
const listPendingPermissionsCalls: Array<{ directories?: Array<string | null | undefined> }> = []
let pendingFormsResponse: FormRequest[] = []
let pendingPermissionsResponse: PermissionRequest[] = []
let pendingFormsShouldThrow = false
let pendingPermissionsShouldThrow = false

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    listPendingForms: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingFormsCalls.push(opts ?? {})
      if (pendingFormsShouldThrow) throw new Error("form.list failed: simulated")
      return pendingFormsResponse
    }),
    listPendingPermissions: mock(async (opts?: { directories?: Array<string | null | undefined> }) => {
      listPendingPermissionsCalls.push(opts ?? {})
      if (pendingPermissionsShouldThrow) throw new Error("permission.list failed: simulated")
      return pendingPermissionsResponse
    }),
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    setDirectory: () => undefined,
  },
}))

const autoAcceptSnapshots: Array<{ snapshot: { sessions: Record<string, boolean>; revision?: number }; runtimeKey?: string }> = []

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      isSessionAutoAccepting: () => false,
      applySnapshot: (snapshot: { sessions: Record<string, boolean>; revision?: number }, runtimeKey?: string) => {
        autoAcceptSnapshots.push({ snapshot, runtimeKey })
      },
    }),
  },
}))

const agentCompletions: Array<Record<string, unknown>> = []

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: () => ({
    notifications: {
      notifyAgentCompletion: async (payload: Record<string, unknown>) => {
        agentCompletions.push(payload)
      },
    },
  }),
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
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

const infoToasts: Array<{ title: string; id?: string }> = []

mock.module("@/components/ui", () => ({
  toast: {
    info: (title: string, options?: { id?: string }) => { infoToasts.push({ title, id: options?.id }) },
    error: () => undefined,
    success: () => undefined,
    dismiss: () => undefined,
  },
}))

import { INITIAL_STATE, type State } from "../types"
import { ChildStoreManager, type DirectoryStore } from "../child-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { sessionEvents } from "@/lib/sessionEvents"
const {
  createEventRoutingIndex,
  handleEvent,
  resyncBlockingRequestsForActiveDirectory,
  resyncBlockingRequestsForDirectory,
  setActiveSession,
} = await import("../sync-context")

function buildForm(overrides: Partial<FormRequest> = {}): FormRequest {
  return {
    id: "frm_1",
    sessionID: "ses_a",
    title: "Continue?",
    fields: [],
    ...overrides,
  } as FormRequest
}

function buildPermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_a",
    action: "bash",
    resources: [],
    metadata: {},
    ...overrides,
  } as PermissionRequest
}

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 } } as State["session"][number]],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

describe("resyncBlockingRequestsForDirectory", () => {
  beforeEach(() => {
    listPendingFormsCalls.length = 0
    listPendingPermissionsCalls.length = 0
    pendingFormsResponse = []
    pendingPermissionsResponse = []
    pendingFormsShouldThrow = false
    pendingPermissionsShouldThrow = false
    setActiveSession("", "")
  })

  test("calls listPendingForms and listPendingPermissions exactly once for the directory", async () => {
    const store = createDirectoryStore({})
    pendingFormsResponse = [buildForm()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(listPendingFormsCalls).toHaveLength(1)
    expect(listPendingFormsCalls[0]).toEqual({ directories: ["/repo"] })
    expect(listPendingPermissionsCalls).toHaveLength(1)
    expect(listPendingPermissionsCalls[0]).toEqual({ directories: ["/repo"] })
  })

  test("resume recovery refreshes blocking requests only for the active materialized directory", async () => {
    const childStores = new ChildStoreManager()
    childStores.ensureChild("/resume-active", { bootstrap: false }).setState({
      session: [{ id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 } } as State["session"][number]],
    })
    childStores.ensureChild("/resume-inactive", { bootstrap: false }).setState({
      session: [{ id: "ses_b", title: "ses_b", time: { created: 1, updated: 1 } } as State["session"][number]],
    })
    pendingFormsResponse = [buildForm()]

    await resyncBlockingRequestsForActiveDirectory("/resume-active", childStores)

    expect(listPendingFormsCalls).toEqual([{ directories: ["/resume-active"] }])
    expect(listPendingPermissionsCalls).toEqual([{ directories: ["/resume-active"] }])
    expect(childStores.getChild("/resume-active")?.getState().form.ses_a?.[0]?.id).toBe("frm_1")
    expect(childStores.getChild("/resume-inactive")?.getState().form.ses_b).toBe(undefined)
  })

  test("resume recovery does not materialize or fetch an unopened directory", async () => {
    const childStores = new ChildStoreManager()

    await resyncBlockingRequestsForActiveDirectory("/unopened", childStores)

    expect(childStores.getChild("/unopened")).toBe(undefined)
    expect(listPendingFormsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  test("merges newly fetched forms/permissions into the directory store", async () => {
    const store = createDirectoryStore({})
    pendingFormsResponse = [buildForm()]
    pendingPermissionsResponse = [buildPermission()]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().form["ses_a"]).toHaveLength(1)
    expect(store.getState().form["ses_a"]?.[0]?.id).toBe("frm_1")
    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_1")
  })

  test("preserves an in-flight SSE-delivered form whose signature changed during the fetch", async () => {
    const store = createDirectoryStore({
      form: { ses_a: [{ ...buildForm(), id: "frm_initial" }] },
    })
    pendingFormsResponse = []

    const promise = resyncBlockingRequestsForDirectory("/repo", store)
    store.setState({
      form: { ses_a: [{ ...buildForm(), id: "frm_sse_arrived" }] },
    })
    await promise

    expect(store.getState().form["ses_a"]).toHaveLength(1)
    expect(store.getState().form["ses_a"]?.[0]?.id).toBe("frm_sse_arrived")
  })

  test("clears stale entries when API returns no pending requests and signature unchanged", async () => {
    const store = createDirectoryStore({
      form: { ses_a: [{ ...buildForm(), id: "frm_stale" }] },
    })
    pendingFormsResponse = []
    pendingPermissionsResponse = []

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().form["ses_a"]).toEqual(undefined)
  })

  test("ignores forms for sessions the directory does not know about", async () => {
    const store = createDirectoryStore({})
    pendingFormsResponse = [{ ...buildForm(), sessionID: "ses_unknown" }]

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().form["ses_unknown"]).toEqual(undefined)
  })

  test("returns early without fetching when no candidate sessions are known", async () => {
    const store = createDirectoryStore({ session: [] })
    await resyncBlockingRequestsForDirectory("/repo", store)
    expect(listPendingFormsCalls).toHaveLength(0)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  test("recovers an explicit session candidate before directory bootstrap materializes it", async () => {
    const store = createDirectoryStore({ session: [] })
    pendingFormsResponse = [buildForm()]

    await resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"], { includePermissions: false })

    expect(listPendingFormsCalls).toEqual([{ directories: ["/repo"] }])
    expect(listPendingPermissionsCalls).toHaveLength(0)
    expect(store.getState().form.ses_a?.[0]?.id).toBe("frm_1")
  })

  test("limits explicit form-only recovery to the requested session", async () => {
    const store = createDirectoryStore({
      session: [
        { id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 } },
        { id: "ses_b", title: "ses_b", time: { created: 1, updated: 1 } },
      ] as State["session"],
    })
    pendingFormsResponse = [
      buildForm(),
      buildForm({ id: "frm_b", sessionID: "ses_b" }),
    ]

    await resyncBlockingRequestsForDirectory("/repo", store, ["ses_a"], { includePermissions: false })

    expect(store.getState().form.ses_a?.[0]?.id).toBe("frm_1")
    expect(store.getState().form.ses_b).toBe(undefined)
    expect(listPendingPermissionsCalls).toHaveLength(0)
  })

  // Regression: prior to the fix, listPendingForms silently returned [] on
  // fetch failure, indistinguishable from a successful empty server response.
  // The resync then walked the candidate set and deleted any form that
  // wasn't in the (empty) result — wiping legitimate in-flight prompts on a
  // transient network blip. The client method now throws on failure and the
  // outer try/catch preserves existing state.
  test("preserves existing forms when listPendingForms throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      form: { ses_a: [{ ...buildForm(), id: "frm_in_flight" }] },
    })
    pendingFormsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().form["ses_a"]).toHaveLength(1)
    expect(store.getState().form["ses_a"]?.[0]?.id).toBe("frm_in_flight")
  })

  test("preserves existing permissions when listPendingPermissions throws (transient fetch failure)", async () => {
    const store = createDirectoryStore({
      permission: { ses_a: [{ ...buildPermission(), id: "perm_in_flight" }] },
    })
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    expect(store.getState().permission["ses_a"]).toHaveLength(1)
    expect(store.getState().permission["ses_a"]?.[0]?.id).toBe("perm_in_flight")
  })

  test("permission fetch failure does not block form resync (and vice versa)", async () => {
    const store = createDirectoryStore({})
    pendingFormsResponse = [buildForm()]
    pendingPermissionsShouldThrow = true

    await resyncBlockingRequestsForDirectory("/repo", store)

    // Form block ran successfully despite permission block failing.
    expect(store.getState().form["ses_a"]).toHaveLength(1)
    expect(store.getState().form["ses_a"]?.[0]?.id).toBe("frm_1")
    expect(listPendingPermissionsCalls).toHaveLength(1)
  })

  test("refreshes Git once when a mutating tool settles, from a snapshot or a live transition", () => {
    const childStores = new ChildStoreManager()
    childStores.ensureChild("/repo", { bootstrap: false })
    const routingIndex = createEventRoutingIndex()
    const refreshes: Array<{ directory: string; paths?: string[] }> = []
    const unsubscribe = sessionEvents.onGitRefreshHint((hint) => refreshes.push(hint))
    const toolState = (status: "pending" | "running" | "completed") => {
      if (status === "pending") return { status, input: {}, raw: "" }
      if (status === "running") return { status, input: {}, time: { start: 1 } }
      return { status, input: {}, output: "", metadata: {}, time: { start: 1, end: 2 } }
    }
    // SAFETY: this fixture supplies the sync event discriminator and the tool
    // part identity, tool name, and state fields consumed by the reducer.
    const partEvent = (partID: string, tool: string, status: "pending" | "running" | "completed") => ({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_a",
        part: {
          id: partID,
          callID: partID,
          messageID: "msg_assistant",
          sessionID: "ses_a",
          type: "tool",
          tool,
          state: toolState(status),
        },
      },
    }) as SyncEvent
    // SAFETY: same fixture contract for the live v2 transition frame.
    const transitionEvent = (partID: string, transition: ToolTransition) => ({
      type: "message.tool.transition",
      properties: { sessionID: "ses_a", messageID: "msg_assistant", partID, transition },
    }) as SyncEvent
    const send = (event: SyncEvent) => handleEvent("/repo", event, childStores, routingIndex, getRuntimeKey())

    try {
      // Snapshot path: a completed `patch` refreshes once, a repeat and a read do not.
      send(partEvent("prt_patch", "patch", "pending"))
      send(partEvent("prt_patch", "patch", "completed"))
      send(partEvent("prt_patch", "patch", "completed"))
      send(partEvent("prt_read", "read", "completed"))
      expect(refreshes).toEqual([{ directory: "/repo" }])

      // Live path: OpenCode v2 settles a running shell call through a transition.
      send(partEvent("prt_shell", "shell", "running"))
      send(transitionEvent("prt_shell", { kind: "success", executed: true, output: "", end: 2 }))
      expect(refreshes).toHaveLength(2)

      // A failed edit may still have written the file.
      send(partEvent("prt_edit", "edit", "running"))
      send(transitionEvent("prt_edit", { kind: "failed", executed: true, error: "boom", end: 2 }))
      expect(refreshes).toHaveLength(3)
    } finally {
      unsubscribe()
      childStores.disposeAll()
    }
  })
})

// OpenChamber's server publishes these two frames on the same stream as
// OpenCode's events. They address the app, not a directory, so they must be
// consumed before any directory routing happens.
describe("OpenChamber-native frames", () => {
  beforeEach(() => {
    infoToasts.length = 0
    agentCompletions.length = 0
    autoAcceptSnapshots.length = 0
  })

  test("raises the restart-interrupted toast and dispatches the agent-completion notification", () => {
    const childStores = new ChildStoreManager()
    const routingIndex = createEventRoutingIndex()
    const event: SyncEvent = {
      type: "openchamber.notification",
      properties: {
        kind: "opencode-restart-interrupted",
        sessionId: "ses_a",
        directory: "/repo",
        title: "Agent finished",
        body: "The turn completed",
        tag: "ses_a",
      },
    }

    try {
      handleEvent("global", event, childStores, routingIndex, getRuntimeKey())

      expect(infoToasts.map((entry) => entry.id)).toEqual(["opencode-restart-interrupted"])
      expect(agentCompletions).toHaveLength(1)
      expect(agentCompletions[0]).toMatchObject({
        title: "Agent finished",
        body: "The turn completed",
        tag: "ses_a",
        kind: "opencode-restart-interrupted",
        sessionId: "ses_a",
        directory: "/repo",
        requireHidden: false,
      })
      // A global frame must not materialize a directory store on its way through.
      expect(childStores.children.size).toBe(0)
    } finally {
      childStores.disposeAll()
    }
  })

  test("applies an auto-accept policy snapshot to the permission store", () => {
    const childStores = new ChildStoreManager()
    const routingIndex = createEventRoutingIndex()
    const event: SyncEvent = {
      type: "openchamber.permission-auto-accept",
      properties: { sessions: { ses_a: true, ses_b: false }, revision: 7 },
    }

    try {
      handleEvent("global", event, childStores, routingIndex, getRuntimeKey())

      expect(autoAcceptSnapshots).toEqual([{
        snapshot: { sessions: { ses_a: true, ses_b: false }, revision: 7 },
        runtimeKey: getRuntimeKey(),
      }])
      expect(childStores.children.size).toBe(0)
    } finally {
      childStores.disposeAll()
    }
  })
})
