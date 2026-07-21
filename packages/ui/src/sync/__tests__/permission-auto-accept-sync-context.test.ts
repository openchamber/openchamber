import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { usePermissionStore } from "@/stores/permissionStore"

mock.module("@/lib/desktop", () => ({
  getDesktopHomeDirectory: async () => null,
  isDesktopLocalOriginActive: () => false,
  isDesktopShell: () => false,
  isElectronShell: () => false,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => true,
  requestDirectoryAccess: async () => null,
  requestExistingFileAccess: async () => null,
  requestFileAccess: async () => null,
  startAccessingDirectory: async () => false,
  stopAccessingDirectory: async () => false,
  usesFramelessElectronChrome: () => false,
}))

mock.module("@/lib/runtimeSurface", () => ({
  isMobileSurfaceRuntime: () => false,
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/repo",
    getScopedSdkClient: () => ({}),
    listPendingPermissions: async () => [],
    listPendingQuestions: async () => [],
    setDirectory: () => undefined,
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
    setState: () => undefined,
  },
}))

mock.module("@/stores/useTodosPersistStore", () => ({
  useTodosPersistStore: { getState: () => ({}) },
}))

mock.module("@/components/ui", () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined, dismiss: () => undefined },
}))

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"

const ORIGINAL_PERMISSION_STORE_STATE = usePermissionStore.getState()

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [{ id: "root", title: "root", time: { created: 1, updated: 1 }, version: "1" } as State["session"][number]],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

const permission = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: "perm-1",
  sessionID: "root",
  permission: "bash",
  patterns: [],
  metadata: {},
  always: [],
  ...overrides,
}) as PermissionRequest

describe("sync-context permission auto-accept visibility", () => {
  let store: StoreApi<DirectoryStore>
  let childStores: {
    children: Map<string, StoreApi<DirectoryStore>>
    mark: (directory: string) => void
    getChild: (directory: string) => StoreApi<DirectoryStore> | undefined
    ensureChild: (directory: string) => StoreApi<DirectoryStore>
  }

  beforeEach(() => {
    usePermissionStore.setState(ORIGINAL_PERMISSION_STORE_STATE, true)
    store = createDirectoryStore({})
    childStores = {
      children: new Map([["/repo", store]]),
      mark: () => undefined,
      getChild: (directory: string) => childStores.children.get(directory),
      ensureChild: () => store,
    }
  })

  afterEach(() => {
    usePermissionStore.setState(ORIGINAL_PERMISSION_STORE_STATE, true)
  })

  test("keeps server-owned pending permissions visible until permission.replied arrives", () => {
    const routingIndex = createEventRoutingIndex()

    handleEvent(
      "/repo",
      { id: "evt-asked", type: "permission.asked", properties: permission() },
      childStores as never,
      routingIndex,
    )

    expect(store.getState().permission.root?.map((entry) => entry.id)).toEqual(["perm-1"])

    handleEvent(
      "/repo",
      { id: "evt-replied", type: "permission.replied", properties: { sessionID: "root", requestID: "perm-1", reply: "once" } },
      childStores as never,
      routingIndex,
    )

    expect(store.getState().permission.root).toEqual([])
  })
})
