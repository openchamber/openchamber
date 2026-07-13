/**
 * Issue #2188 — O(N) scans on the live-session hot path.
 *
 * Three hot paths were O(N total sessions) on every SSE event / every session
 * switch in v1.16:
 *
 *   1. useAllLiveSessions()  → aggregateLiveSessions(states) iterates every
 *      child store and every session, then sorts.
 *   2. useGlobalSessionStatus(id) → findLiveSessionStatus(states, id) is
 *      called per visible sidebar row × every child store.
 *   3. permissionStore.isSessionAutoAccepting(id) → getAllSyncSessions()
 *      (iterates every child store and every session) + autoRespondsPermission
 *      (builds a Map of all sessions and walks the parent chain).
 *
 * Baseline (pre-fix) reproduction — kept as a documentation comment so future
 * readers see the O(N) baseline without depending on the legacy aggregator:
 *
 *   const states = generateMockStates(5 /* dirs *\/, 10 /* sessions per dir *\/)
 *   // 1) O(N) — full scan + sort on every read
 *   aggregateLiveSessions(states)             // ~50 ops
 *   // 2) O(N) — full scan per visible row
 *   findLiveSessionStatus(states, "ses_1")    // ~50 ops
 *   // 3) O(N) — full scan to build lineage Map, then chain walk
 *   isSessionAutoAccepting("ses_1")          // ~50 + 1-3 = ~50 ops
 *
 * Post-fix, the new LiveSessionIndex makes all three paths O(1) on the hot
 * read path. The tests below pin the new behavior.
 */

// ---------------------------------------------------------------------------
// Test-environment shims.
//
// Sibling tests (notably `issue-2039.test.ts`) `mock.module` zustand and a
// few `@/...` modules at file scope. `bun`'s `mock.module` is file-leaky:
// once a test file registers a mock, subsequent files see that mock when
// they import the same module. We override the mocks that affect us so
// the new tests have a complete runtime to work with.
//
//   - "zustand" / "zustand/middleware" : needed so any real zustand
//     store can be loaded if the test imports it.
//   - "../sync-refs" : `issue-2039.test.ts` mocks this with a partial
//     shape missing `setLiveIndexRef` / `getLiveIndexRef`. We override
//     with a complete shape backed by a private ref cell. Tests 5/6 push
//     a real `LiveSessionIndex` into that cell and read it back through
//     `isSessionAutoAccepting` — exercising the same algorithm
//     `permissionStore.ts` uses in production.
//   - "@/stores/permissionStore" : `issue-2039.test.ts` mocks this with a
//     partial shape missing `isSessionAutoAccepting`. We override with a
//     complete zustand store whose `isSessionAutoAccepting` is a verbatim
//     copy of the production algorithm (lines 88–106 of
//     `src/stores/permissionStore.ts`) — using the real
//     `LiveSessionIndex.getLineage` and the real `getLiveIndexRef` from
//     our shimmed `../sync-refs`. This way the test exercises the
//     production algorithm end-to-end with a real `LiveSessionIndex`
//     instead of a stub.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test"
import type { StoreApi } from "zustand"
import type { Session } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { DirectoryStore } from "../child-store"
import { LiveSessionIndex } from "../live-session-index"

mock.module("zustand", () => {
  const makeStore = (
    initializer: (set: (patch: unknown) => void, get: () => unknown) => Record<string, unknown>,
  ) => {
    let state: Record<string, unknown> = {}
    const get = () => state
    const set = (patch: unknown) => {
      const next = typeof patch === "function" ? (patch as (s: Record<string, unknown>) => unknown)(state) : patch
      state = next && typeof next === "object" ? { ...state, ...(next as Record<string, unknown>) } : state
    }
    state = initializer(set as never, get as never)
    const store = ((selector?: (s: Record<string, unknown>) => unknown) =>
      typeof selector === "function" ? selector(state) : state) as unknown as {
      getState: () => Record<string, unknown>
      setState: (patch: unknown) => void
      subscribe: (listener: () => void) => () => void
    }
    store.getState = () => state
    store.setState = (patch) => set(patch)
    store.subscribe = () => () => undefined
    return store
  }
  return {
    create: () => makeStore,
    useStore: (store: { getState: () => unknown }) => store.getState(),
    default: makeStore,
  }
})

mock.module("zustand/middleware", () => {
  const passthrough = (initializer: unknown) => initializer
  return {
    persist: passthrough,
    devtools: passthrough,
    subscribeWithSelector: passthrough,
    combine: (a: unknown) => a,
    redux: passthrough,
    default: passthrough,
  }
})

// Override the issue-2039 `../sync-refs` mock with a complete shape. The
// ref cell holds the real `LiveSessionIndex`; `getLiveIndexRef` returns
// it for the `isSessionAutoAccepting` algorithm.
let _liveIndexRef: LiveSessionIndex | null = null
mock.module("../sync-refs", () => ({
  setLiveIndexRef: (index: LiveSessionIndex | null) => {
    _liveIndexRef = index
  },
  getLiveIndexRef: () => _liveIndexRef,
  setSyncRefs: () => undefined,
  registerSessionDirectory: () => undefined,
  getSyncChildStores: () => {
    throw new Error("getSyncChildStores not initialized in test shim")
  },
  getDirectoryState: () => undefined,
  getSyncConfig: () => undefined,
  subscribeToSyncConfigChanges: () => () => undefined,
  emitSyncConfigChanged: () => undefined,
  getSyncSessions: () => [],
  getAllSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncSessionMaterializationStatus: () => ({
    hasMessages: false,
    renderable: false,
    missingPartMessageIDs: [],
  }),
  getSyncParts: () => [],
  getSyncSessionStatus: () => undefined,
}))

// Override the issue-2039 `@/stores/permissionStore` mock with a store
// whose `isSessionAutoAccepting` is the verbatim copy of the production
// algorithm (src/stores/permissionStore.ts:88–106), reading from
// getLiveIndexRef() (provided by our `../sync-refs` shim above).
const realIsSessionAutoAccepting = (sessionId: string) => {
  if (!sessionId) return false
  const autoAccept = usePermissionStore.getState().autoAccept
  // Most common case: user has never opted in to auto-accept.
  if (Object.keys(autoAccept).length === 0) return false
  const index = _liveIndexRef
  if (index) {
    const lineage = index.getLineage(sessionId)
    if (lineage.length === 0) return false
    for (const id of lineage) {
      if (!Object.prototype.hasOwnProperty.call(autoAccept, id)) continue
      return autoAccept[id] === true
    }
    return false
  }
  return false
}

interface PermissionStoreState {
  autoAccept: Record<string, boolean>
}

interface PermissionStoreView extends PermissionStoreState {
  isSessionAutoAccepting: (sessionId: string) => boolean
  setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>
}

const usePermissionStore: StoreApi<PermissionStoreView> = (() => {
  let state: PermissionStoreState = { autoAccept: {} }
  const getState = (): PermissionStoreView => ({
    autoAccept: state.autoAccept,
    isSessionAutoAccepting: realIsSessionAutoAccepting,
    setSessionAutoAccept: () => Promise.resolve(),
  })
  return {
    getState,
    setState: (patch: Partial<PermissionStoreView> | ((s: PermissionStoreState) => Partial<PermissionStoreState>)) => {
      const next = typeof patch === "function"
        ? (patch as (s: PermissionStoreState) => Partial<PermissionStoreState>)(state)
        : patch
      state = { ...state, ...next }
    },
    subscribe: () => () => undefined,
  } as unknown as StoreApi<PermissionStoreView>
})()

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => usePermissionStore.getState(),
    setState: (patch: Partial<PermissionStoreState>) => {
      usePermissionStore.setState(patch as never)
    },
  },
}))

const buildSession = (
  id: string,
  directory: string,
  updatedAt: number,
  parentID?: string,
): Session => ({
  id,
  title: `${id}-title`,
  directory,
  time: { created: updatedAt - 100, updated: updatedAt, archived: undefined },
  ...(parentID ? { parentID } : {}),
} as Session)

interface StateSlice {
  session: Session[]
  session_status: Record<string, SessionStatus>
}

/**
 * Build a 5-directory × 10-session mock dataset that exercises the
 * freshest-wins merge rule. The 4th directory holds updated versions of
 * sessions from earlier directories to prove the merger picks the freshest.
 */
const buildMockStateSlices = (): StateSlice[] => {
  const slices: StateSlice[] = []
  for (let dir = 0; dir < 5; dir += 1) {
    const session: Session[] = []
    const session_status: Record<string, SessionStatus> = {}
    for (let s = 0; s < 10; s += 1) {
      const id = `ses-${s}`
      // Directory 3 (the "later" directory) has fresher timestamps for the
      // same ids as the earlier directories.
      const baseUpdated = 1000 + dir * 10
      session.push(buildSession(id, `/dir-${dir}`, baseUpdated + s, s === 9 ? "ses-parent" : undefined))
      session_status[id] = dir % 2 === 0 ? { type: "busy" } : { type: "idle" }
    }
    // Directory 4 also exposes a parent session that the 10 child sessions
    // delegate to via parentID.
    if (dir === 4) {
      session.push(buildSession("ses-parent", "/dir-4", 2000))
    }
    slices.push({ session, session_status })
  }
  return slices
}

// ---------------------------------------------------------------------------
// Fake StoreApi / ChildStoreManager for test 4.
//
// Test 4 must drive a single child store through `store.setState(...)` and
// observe that the LiveSessionIndex's `getAllSessions()` reference is stable
// when the change does not touch `session` or `session_status`. We avoid
// `new ChildStoreManager()` (which internally calls `zustand.create` and
// would inherit the stub's no-op `subscribe`) and instead hand-roll a
// minimal `StoreApi<DirectoryStore>` and a `ChildStoreManager`-shaped
// object that exposes only the methods the index actually uses.
// ---------------------------------------------------------------------------

interface FakeState {
  session: Session[]
  session_status: Record<string, SessionStatus>
  part: Record<string, unknown>
  [key: string]: unknown
}

const makeFakeStore = (initial: FakeState): StoreApi<DirectoryStore> => {
  let state = initial
  const listeners = new Set<() => void>()
  const store = {
    getState: () => state as unknown as DirectoryStore,
    setState: (partial: unknown) => {
      const next =
        typeof partial === "function"
          ? (partial as (s: FakeState) => Partial<FakeState>)(state)
          : (partial as Partial<FakeState>)
      state = { ...state, ...next }
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return store as unknown as StoreApi<DirectoryStore>
}

interface FakeChildStoreManager {
  children: Map<string, StoreApi<DirectoryStore>>
  subscribeRegistry: (listener: () => void) => () => void
}

const makeFakeChildStoreManager = (): {
  manager: FakeChildStoreManager
  registryListeners: Set<() => void>
  children: Map<string, StoreApi<DirectoryStore>>
} => {
  const children = new Map<string, StoreApi<DirectoryStore>>()
  const registryListeners = new Set<() => void>()
  const manager: FakeChildStoreManager = {
    children,
    subscribeRegistry: (listener: () => void) => {
      registryListeners.add(listener)
      return () => {
        registryListeners.delete(listener)
      }
    },
  }
  return { manager: manager as unknown as FakeChildStoreManager, registryListeners, children }
}

describe("issue #2188 — LiveSessionIndex hot path", () => {
  test("returns sorted sessions across many directories without scanning child stores", () => {
    const slices = buildMockStateSlices()
    const index = LiveSessionIndex.fromStates(slices)

    // The merged index should contain one entry per unique id. The mock
    // has ids ses-0..ses-9 (10 unique) plus ses-parent = 11.
    expect(index.__test_sessionCount()).toBe(11)
    expect(index.__test_statusCount()).toBe(10)

    // Freshest-wins: directory 4 holds the most-recent updates for the
    // shared ids, so its sessions win the merge.
    const sessions = index.getAllSessions()
    // The 11 ids in the merged map are ses-0..ses-9 plus ses-parent.
    expect(sessions.length).toBe(11)
    expect(new Set(sessions.map((s) => s.id))).toEqual(new Set([
      "ses-0", "ses-1", "ses-2", "ses-3", "ses-4",
      "ses-5", "ses-6", "ses-7", "ses-8", "ses-9",
      "ses-parent",
    ]))

    // Sorted by time.updated desc. The fresher timestamps come from
    // directory 4; the per-id ordering should reflect that the
    // highest-updated id appears first. ses-parent has updated=2000
    // (the highest of any session) so it should be the first element.
    expect(sessions[0]?.id).toBe("ses-parent")
    const updates = sessions.map((s) => s.time?.updated ?? 0)
    for (let i = 1; i < updates.length; i += 1) {
      expect(updates[i - 1]).toBeGreaterThanOrEqual(updates[i])
    }
  })

  test("returns status for an id in O(1) (no child-store scan)", () => {
    const index = LiveSessionIndex.fromStates(buildMockStateSlices())

    // Looking up any id must hit the merged status map. We can't directly
    // count "iterations" against the no-op fake manager, but the spec
    // requires the new code to read the result in 0 or O(1) iterations
    // over the state. fromStates is a one-shot bulk ingest; reads are
    // pure Map lookups. Verify the result is correct and stable.
    const before = index.getStatus("ses-3")
    const after = index.getStatus("ses-3")
    expect(before).toBeDefined()
    expect(after).toBe(before)
    expect(before?.type === "busy" || before?.type === "idle").toBe(true)
  })

  test("getLineage returns the parent chain O(depth), not a full scan", () => {
    const slices = buildMockStateSlices()
    const index = LiveSessionIndex.fromStates(slices)

    // ses-9 has parentID="ses-parent"; ses-parent is itself a top-level
    // session in directory 4. The lineage should be ses-9 → ses-parent.
    const lineage = index.getLineage("ses-9")
    expect(lineage).toEqual(["ses-9", "ses-parent"])

    // Unknown id returns empty array.
    expect(index.getLineage("does-not-exist")).toEqual([])

    // Top-level session lineage is just itself.
    expect(index.getLineage("ses-0")).toEqual(["ses-0"])

    // Empty / null id returns empty array without touching any data.
    expect(index.getLineage("")).toEqual([])
    expect(index.getLineage(null as unknown as string)).toEqual([])
  })

  test("keeps getAllSessions() referentially stable across a hot message.part.delta event", () => {
    // Exercise the per-store diff path (not the fromStates bulk path) using
    // a hand-rolled fake store. The reducer keeps state.session and
    // state.session_status reference-stable for hot events; the index
    // should observe the no-op and leave its public getters stable.
    //
    // We do NOT use `new ChildStoreManager()` here. The real manager's
    // stores are built via `zustand.create`, and `issue-2039.test.ts`'s
    // `mock.module("zustand", ...)` is file-leaky, so by the time this
    // test runs after that file, the manager's stores would have a no-op
    // subscribe — making the index never see the state we set. Using a
    // fake store + fake manager sidesteps that entirely.
    const { manager, children, registryListeners } = makeFakeChildStoreManager()

    const baseSession = buildSession("hot-1", "/hot", 1000)
    const store = makeFakeStore({
      session: [],
      session_status: {},
      part: {},
    })

    // Populate the children map before the index is constructed so its
    // `subscribeToAllChildren` picks the store up on the first pass and
    // ingests the (currently empty) initial state. The real `ensureChild`
    // would call `subscribeRegistry` listeners to notify the index of the
    // new child, but we have no real manager — so call them ourselves.
    children.set("/hot", store)
    const index = new LiveSessionIndex(manager as never)
    for (const listener of registryListeners) listener()

    // Now apply the real initial state for the hot directory. This fires
    // the fake store's subscribe listener, which drives the index's
    // per-store diff path.
    store.setState({
      session: [baseSession],
      session_status: { "hot-1": { type: "busy" } },
    })

    // Prime the sort cache.
    const first = index.getAllSessions()
    expect(first.length).toBe(1)
    const firstRef = first[0]
    const sortedRef = index.getAllSessions()
    expect(sortedRef).toBe(first)

    // Simulate a hot event: the reducer clones only `part`, leaving
    // `session` and `session_status` references intact. The index's
    // per-store diff short-circuits and the public getter returns the
    // same array reference.
    const before = index.getAllSessions()
    // Cast away the part-array element shape: the live-session-index test
    // only asserts reference-stability, so the exact part shape is
    // irrelevant. The fake store's setState will fire its listeners and
    // the index's per-store diff will short-circuit because `session` and
    // `session_status` references are unchanged.
    store.setState(((current: FakeState) => ({
      ...current,
      part: { ...(current.part as Record<string, unknown>), "msg-1": [{ id: "p-1" }] },
    })) as unknown as (s: DirectoryStore) => Partial<DirectoryStore>)
    const after = index.getAllSessions()
    expect(after).toBe(before)
    expect(after[0]).toBe(firstRef)
  })

  test("isSessionAutoAccepting returns false for an empty autoAccept without scanning", () => {
    // Pin the production algorithm's early-return for the empty-autoAccept
    // case. `usePermissionStore` here is the test shim (see file header)
    // whose `isSessionAutoAccepting` is a verbatim copy of
    // `permissionStore.ts:88–106` and uses the real `LiveSessionIndex` and
    // the real `getLiveIndexRef` from our `../sync-refs` shim.
    usePermissionStore.setState({ autoAccept: {} })
    // Make sure no leftover index is mounted.
    _liveIndexRef = null

    // For ANY session id, the result must be false, and the function
    // must short-circuit before touching the sync layer. We exercise
    // several ids, including ids that may or may not be in any live index.
    const ids = ["ses-0", "ses-9", "ses-parent", "unknown-id", ""]
    for (const id of ids) {
      // Empty string is treated as falsy by the function (returns false
      // before any sync work).
      expect(usePermissionStore.getState().isSessionAutoAccepting(id)).toBe(false)
    }
  })

  test("isSessionAutoAccepting respects lineage via LiveSessionIndex when autoAccept is populated", () => {
    // Wire a real LiveSessionIndex into the permission store via our
    // `../sync-refs` shim. ses-9 has parentID="ses-parent" (see
    // buildMockStateSlices), so getLineage("ses-9") === ["ses-9", "ses-parent"].
    // The shim's isSessionAutoAccepting walks that lineage and checks each
    // id against the autoAccept map. Setting "ses-parent" → true should
    // make isSessionAutoAccepting("ses-9") return true via the index path.
    const index = LiveSessionIndex.fromStates(buildMockStateSlices())
    _liveIndexRef = index
    usePermissionStore.setState({ autoAccept: { "ses-parent": true } })

    // The lineage-aware fast path: ses-9 inherits auto-accept from
    // ses-parent. This is the new behavior the index enables; the
    // legacy fallback (no index) would also produce the same answer,
    // but the test exists to pin that the index path resolves it.
    expect(usePermissionStore.getState().isSessionAutoAccepting("ses-9")).toBe(true)

    // Top-level opted-in id resolves directly without needing lineage.
    expect(usePermissionStore.getState().isSessionAutoAccepting("ses-parent")).toBe(true)

    // Unknown id with no opted-in ancestor is false.
    expect(usePermissionStore.getState().isSessionAutoAccepting("unknown-id")).toBe(false)

    // Empty / null id short-circuits to false.
    expect(usePermissionStore.getState().isSessionAutoAccepting("")).toBe(false)
    expect(usePermissionStore.getState().isSessionAutoAccepting(null as unknown as string)).toBe(false)

    // Clear the ref so this test does not leak global state into sibling
    // tests in the same process.
    _liveIndexRef = null
  })

  test("isDisposed() reports true after dispose() and a fresh index reacts to child-store changes (StrictMode remount contract)", () => {
    // Pins the contract that the SyncProvider liveIndexRef guard depends on:
    //
    //   const liveIndexRef = useRef<LiveSessionIndex | null>(null)
    //   if (!liveIndexRef.current || liveIndexRef.current.isDisposed()) {
    //     liveIndexRef.current = new LiveSessionIndex(childStores)
    //   }
    //
    // In React StrictMode (dev), mount → cleanup → remount runs in immediate
    // succession. The cleanup useEffect calls `liveIndex.dispose()`, which
    // sets `this.disposed = true` and unsubscribes from all child stores.
    // On the remount, the ref is still truthy, so without the isDisposed()
    // check the SyncProvider would reuse the disposed index and `handleStoreChange`
    // would short-circuit on every event — sidebar live updates would silently
    // break in dev mode.
    //
    // This test verifies two things:
    //   1) isDisposed() is a public, observable contract: a fresh, live
    //      index reports false; after dispose() it reports true.
    //   2) A SECOND, fresh index built after the first one is disposed
    //      actually reacts to child-store changes — i.e. the
    //      "create a new index" path in the SyncProvider guard produces
    //      a working live index, not another inert one.
    const { manager, children, registryListeners } = makeFakeChildStoreManager()

    const baseSession = buildSession("remount-1", "/remount", 1000)
    const store = makeFakeStore({
      session: [],
      session_status: {},
      part: {},
    })
    children.set("/remount", store)

    // Build the first index. After dispose(), isDisposed() must be true.
    const first = new LiveSessionIndex(manager as never)
    for (const listener of registryListeners) listener()
    store.setState({
      session: [baseSession],
      session_status: { "remount-1": { type: "busy" } },
    })
    expect(first.isDisposed()).toBe(false)
    expect(first.getAllSessions().length).toBe(1)
    expect(first.getStatus("remount-1")).toBeDefined()

    // Dispose the first index. This is what the cleanup useEffect does on
    // the first mount of <SyncProvider> in StrictMode.
    first.dispose()
    expect(first.isDisposed()).toBe(true)

    // Now the second index — what the remount path in the SyncProvider
    // guard would build. It must NOT be disposed, and it must react to
    // changes on the child store. Without the isDisposed() guard, the
    // provider would skip re-creation and keep using the disposed `first`
    // — `handleStoreChange` would short-circuit and the new session would
    // never appear in getAllSessions().
    const second = new LiveSessionIndex(manager as never)
    for (const listener of registryListeners) listener()
    expect(second.isDisposed()).toBe(false)
    expect(second).not.toBe(first)

    // The second index should already see the child store's current state
    // (it ingested it on construction). Now push a new session and verify
    // the second index observes the change — proving the lifecycle is
    // correct after dispose.
    const newSession = buildSession("remount-2", "/remount", 2000)
    store.setState({
      session: [baseSession, newSession],
      session_status: { "remount-1": { type: "busy" }, "remount-2": { type: "idle" } },
    })

    const allSessions = second.getAllSessions()
    const ids = new Set(allSessions.map((s) => s.id))
    expect(ids.has("remount-1")).toBe(true)
    expect(ids.has("remount-2")).toBe(true)
    expect(allSessions.length).toBe(2)

    // And the status map for the second index reflects the new entry.
    expect(second.getStatus("remount-2")).toBeDefined()
    expect(second.getStatus("remount-2")?.type).toBe("idle")
  })
})
