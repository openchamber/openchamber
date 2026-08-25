import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { GitHubPullRequestStatus, RuntimeAPIs } from "@/lib/api/types"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

const { getFreshestPrStatusForBranch, getGitHubPrStatusKey, useGitHubPrStatusStore } = await import("./useGitHubPrStatusStore")

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const params = (github: RuntimeAPIs["github"], branch = "main") => ({
  directory: "/repo",
  branch,
  remoteName: "origin",
  canShow: true,
  github,
  githubAuthChecked: true,
  githubConnected: true,
})

describe("GitHub PR status cache ownership", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    useGitHubPrStatusStore.setState({ entries: {}, activeRequestCount: 0, totalRequestCount: 0 })
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
  })

  test("keys colliding paths by runtime and requested remote", () => {
    const originA = getGitHubPrStatusKey("/repo", "main", "origin")
    const upstreamA = getGitHubPrStatusKey("/repo", "main", "upstream")
    runtimeKey = "runtime-b"
    const originB = getGitHubPrStatusKey("/repo", "main", "origin")

    expect(new Set([originA, upstreamA, originB]).size).toBe(3)
  })

  test("passive branch readers follow the freshest remote-keyed status", () => {
    const automatic = getGitHubPrStatusKey("/repo", "feature")
    const origin = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(automatic)
    useGitHubPrStatusStore.getState().ensureEntry(origin)
    useGitHubPrStatusStore.getState().updateStatus(automatic, () => ({
      connected: true,
      pr: { number: 7, title: "old", url: "u7", state: "open", draft: false, base: "main", head: "feature" },
      checks: { state: "pending", total: 3, success: 1, failure: 0, pending: 2 },
    }))
    useGitHubPrStatusStore.getState().updateStatus(origin, () => ({
      connected: true,
      pr: { number: 7, title: "current", url: "u7", state: "open", draft: false, base: "main", head: "feature" },
      checks: { state: "success", total: 3, success: 3, failure: 0, pending: 0 },
    }))
    useGitHubPrStatusStore.setState((state) => ({
      entries: {
        ...state.entries,
        [automatic]: { ...state.entries[automatic], lastRefreshAt: 1 },
        [origin]: { ...state.entries[origin], lastRefreshAt: 2 },
      },
    }))

    const freshest = getFreshestPrStatusForBranch(useGitHubPrStatusStore.getState().entries, "/repo", "feature")
    expect(freshest?.pr?.title).toBe("current")
    expect(freshest?.checks?.pending).toBe(0)
  })

  test("rejects a response after params change", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const github = { prStatus: () => request.promise } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })

    useGitHubPrStatusStore.getState().setParams(key, params(github, "next"))
    request.resolve({ connected: true, pr: null })
    await loading

    expect(useGitHubPrStatusStore.getState().entries[key]?.status).toBe(null)
    expect(useGitHubPrStatusStore.getState().entries[key]?.isLoading).toBe(false)
  })

  test("rejects an old runtime response after reset", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const github = { prStatus: () => request.promise } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })

    runtimeKey = "runtime-b"
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
    request.resolve({ connected: true, pr: null })
    await loading

    expect(useGitHubPrStatusStore.getState().entries[key]?.status).toBe(null)
    expect(useGitHubPrStatusStore.getState().activeRequestCount).toBe(0)
  })

  test("throttles repeated non-forced refreshes after a failure", async () => {
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        throw new Error("GitHub rate limited")
      },
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))

    await useGitHubPrStatusStore.getState().refresh(key)
    await useGitHubPrStatusStore.getState().refresh(key)

    expect(requestCount).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.error).toBe("GitHub rate limited")
  })

  test("does not throttle replacement params when a queued request becomes stale", async () => {
    const first = deferred<GitHubPullRequestStatus>()
    const second = deferred<GitHubPullRequestStatus>()
    let staleRequestCount = 0
    let replacementRequestCount = 0
    const firstGitHub = { prStatus: () => first.promise } as unknown as RuntimeAPIs["github"]
    const secondGitHub = { prStatus: () => second.promise } as unknown as RuntimeAPIs["github"]
    const staleGitHub = {
      prStatus: async () => {
        staleRequestCount += 1
        return { connected: true, pr: null }
      },
    } as unknown as RuntimeAPIs["github"]
    const replacementGitHub = {
      prStatus: async () => {
        replacementRequestCount += 1
        return { connected: true, pr: null }
      },
    } as unknown as RuntimeAPIs["github"]
    const firstKey = getGitHubPrStatusKey("/repo", "first", "origin")
    const secondKey = getGitHubPrStatusKey("/repo", "second", "origin")
    const queuedKey = getGitHubPrStatusKey("/repo", "queued", "origin")

    for (const [key, github, branch] of [
      [firstKey, firstGitHub, "first"],
      [secondKey, secondGitHub, "second"],
      [queuedKey, staleGitHub, "queued"],
    ] as const) {
      useGitHubPrStatusStore.getState().ensureEntry(key)
      useGitHubPrStatusStore.getState().setParams(key, params(github, branch))
    }

    const firstRefresh = useGitHubPrStatusStore.getState().refresh(firstKey, { force: true })
    const secondRefresh = useGitHubPrStatusStore.getState().refresh(secondKey, { force: true })
    const staleRefresh = useGitHubPrStatusStore.getState().refresh(queuedKey, { force: true })
    await Promise.resolve()
    useGitHubPrStatusStore.getState().setParams(queuedKey, params(replacementGitHub, "queued"))
    first.resolve({ connected: true, pr: null })
    second.resolve({ connected: true, pr: null })
    await Promise.all([firstRefresh, secondRefresh, staleRefresh])

    await useGitHubPrStatusStore.getState().refresh(queuedKey)

    expect(staleRequestCount).toBe(0)
    expect(replacementRequestCount).toBe(1)
  })

  test("rejects a server-cached response older than the held status", async () => {
    const newer: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 2_000,
      pr: { number: 7, title: "t", url: "u", state: "open", draft: false, base: "main", head: "f" },
      checks: { state: "pending", total: 3, success: 2, failure: 0, pending: 1 },
    }
    const older: GitHubPullRequestStatus = {
      ...newer,
      fetchedAt: 1_000,
      checks: { state: "success", total: 3, success: 3, failure: 0, pending: 0 },
    }

    const responses = [newer, older]
    const github = { prStatus: async () => responses.shift()! } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.checks?.pending).toBe(1)

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })
    const held = useGitHubPrStatusStore.getState().entries[key]?.status
    expect(held?.fetchedAt).toBe(2_000)
    expect(held?.checks?.pending).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.isLoading).toBe(false)
  })
})

describe("GitHub PR status stale terminal associations", () => {
  const originalSetInterval = globalThis.setInterval
  const originalSetTimeout = globalThis.setTimeout
  const originalClearInterval = globalThis.clearInterval
  const originalClearTimeout = globalThis.clearTimeout
  let intervalCallbacks: Array<() => void> = []

  beforeEach(() => {
    runtimeKey = "runtime-a"
    intervalCallbacks = []

    const setIntervalStub = ((handler: TimerHandler) => {
      if (typeof handler === "function") {
        intervalCallbacks.push(handler as () => void)
      }
      return 1
    }) as unknown as typeof setInterval
    const setTimeoutStub = (() => 1) as unknown as typeof setTimeout
    const clearIntervalStub = (() => undefined) as typeof clearInterval
    const clearTimeoutStub = (() => undefined) as typeof clearTimeout

    globalThis.setInterval = setIntervalStub
    globalThis.setTimeout = setTimeoutStub
    globalThis.clearInterval = clearIntervalStub
    globalThis.clearTimeout = clearTimeoutStub

    // bun:test has no DOM; the store uses window timers and optional document visibility.
    Object.assign(globalThis, {
      window: {
        setInterval: setIntervalStub,
        setTimeout: setTimeoutStub,
        clearInterval: clearIntervalStub,
        clearTimeout: clearTimeoutStub,
      },
      document: { visibilityState: "visible" },
    })

    useGitHubPrStatusStore.setState({ entries: {}, activeRequestCount: 0, totalRequestCount: 0 })
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
  })

  afterEach(() => {
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
    globalThis.setInterval = originalSetInterval
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearInterval = originalClearInterval
    globalThis.clearTimeout = originalClearTimeout
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { document?: unknown }).document
  })

  test("forced refresh replaces a merged PR with a newer open PR", async () => {
    const merged: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
    }
    const newerOpen: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 2_000,
      pr: { number: 15, title: "new", url: "u15", state: "open", draft: false, base: "main", head: "feature" },
    }
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        return requestCount === 1 ? merged : newerOpen
      },
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github, "feature"))

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })
    expect(requestCount).toBe(2)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(15)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.state).toBe("open")
  })

  test("forced refresh clears a merged PR when no open PR remains", async () => {
    const merged: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      repo: { owner: "acme", repo: "app", url: "https://github.com/acme/app" },
      pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
    }
    const empty: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 2_000,
      repo: { owner: "acme", repo: "app", url: "https://github.com/acme/app" },
      pr: null,
    }
    const github = {
      prStatus: async () => empty,
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.setState((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          ...state.entries[key]!,
          status: merged,
          isInitialStatusResolved: true,
          lastRefreshAt: Date.now(),
        },
      },
    }))
    useGitHubPrStatusStore.getState().setParams(key, params(github, "feature"))

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })

    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr).toBeNull()
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.repo).toEqual({
      owner: "acme",
      repo: "app",
      url: "https://github.com/acme/app",
    })
  })

  test("watcher discovery revalidates a cached merged PR", async () => {
    const merged: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
    }
    const newerOpen: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 2_000,
      pr: { number: 15, title: "new", url: "u15", state: "open", draft: false, base: "main", head: "feature" },
    }
    const responses = [merged, newerOpen]
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        return responses.shift()!
      },
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github, "feature"))
    useGitHubPrStatusStore.getState().startWatching(key)

    for (let i = 0; i < 50 && useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number !== 12; i += 1) {
      await Promise.resolve()
    }
    expect(requestCount).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)
    expect(intervalCallbacks).toHaveLength(1)

    // Discovery poll for terminal state (lastDiscoveryPollAt starts at 0).
    intervalCallbacks[0]!()
    for (let i = 0; i < 50 && useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number !== 15; i += 1) {
      await Promise.resolve()
    }

    expect(requestCount).toBe(2)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(15)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.state).toBe("open")
  })

  test("watcher discovery clears a cached merged PR when no open PR exists", async () => {
    const merged: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
    }
    const empty: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 2_000,
      pr: null,
    }
    const responses = [merged, empty]
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        return responses.shift()!
      },
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github, "feature"))
    useGitHubPrStatusStore.getState().startWatching(key)

    for (let i = 0; i < 50 && useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number !== 12; i += 1) {
      await Promise.resolve()
    }
    expect(requestCount).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)

    intervalCallbacks[0]!()
    for (let i = 0; i < 50 && useGitHubPrStatusStore.getState().entries[key]?.status?.pr != null; i += 1) {
      await Promise.resolve()
    }

    expect(requestCount).toBe(2)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr).toBeNull()
  })

  test("seeds sibling entries from a closed PR without freezing discovery", () => {
    const closed: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 9, title: "closed", url: "u9", state: "closed", draft: false, base: "main", head: "feature" },
    }
    const autoKey = getGitHubPrStatusKey("/repo", "feature", null)
    const originKey = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.setState({
      entries: {
        [autoKey]: {
          status: closed,
          isLoading: false,
          error: null,
          isInitialStatusResolved: true,
          lastRefreshAt: Date.now(),
          lastDiscoveryPollAt: 0,
          watchers: 0,
          params: null,
          identity: {
            runtimeKey: "runtime-a",
            directory: "/repo",
            branch: "feature",
            remoteName: null,
          },
          resolvedRemoteName: "origin",
          paramsRevision: 0,
        },
      },
      activeRequestCount: 0,
      totalRequestCount: 0,
    })

    useGitHubPrStatusStore.getState().ensureEntry(originKey)
    const seeded = useGitHubPrStatusStore.getState().entries[originKey]
    expect(seeded?.status?.pr?.number).toBe(9)
    // Seeding is display continuity only: the seeded entry has never refreshed
    // or polled, so its own discovery still runs immediately.
    expect(seeded?.lastRefreshAt).toBe(0)
    expect(seeded?.lastDiscoveryPollAt).toBe(0)
  })

  test("keeps a cached PR when a forced refresh fails", async () => {
    const merged: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
    }
    const github = {
      prStatus: async () => {
        throw new Error("GitHub unavailable")
      },
    } as unknown as RuntimeAPIs["github"]
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.setState((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          ...state.entries[key]!,
          status: merged,
          isInitialStatusResolved: true,
          lastRefreshAt: Date.now(),
        },
      },
    }))
    useGitHubPrStatusStore.getState().setParams(key, params(github, "feature"))

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })

    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)
    expect(useGitHubPrStatusStore.getState().entries[key]?.error).toBe("GitHub unavailable")
  })

  test("persists a merged branch association as history", () => {
    const merged: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
    }
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params({} as RuntimeAPIs["github"], "feature"))
    useGitHubPrStatusStore.setState((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          ...state.entries[key]!,
          status: merged,
          isInitialStatusResolved: true,
          lastRefreshAt: Date.now(),
        },
      },
    }))

    const persisted = useGitHubPrStatusStore.persist.getOptions().partialize?.(
      useGitHubPrStatusStore.getState(),
    ) as { entries?: Record<string, { status?: GitHubPullRequestStatus | null }> } | undefined
    expect(persisted?.entries?.[key]?.status?.pr?.number).toBe(12)
  })

  test("still persists an open branch association", () => {
    const open: GitHubPullRequestStatus = {
      connected: true,
      fetchedAt: 1_000,
      pr: { number: 15, title: "new", url: "u15", state: "open", draft: false, base: "main", head: "feature" },
    }
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params({} as RuntimeAPIs["github"], "feature"))
    useGitHubPrStatusStore.setState((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          ...state.entries[key]!,
          status: open,
          isInitialStatusResolved: true,
          lastRefreshAt: Date.now(),
        },
      },
    }))

    const persisted = useGitHubPrStatusStore.persist.getOptions().partialize?.(
      useGitHubPrStatusStore.getState(),
    ) as { entries?: Record<string, { status?: GitHubPullRequestStatus | null }> } | undefined
    expect(persisted?.entries?.[key]?.status?.pr?.number).toBe(15)
  })

  test("hydrate keeps a persisted merged PR but forces the next discovery poll", () => {
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    const hydrated = useGitHubPrStatusStore.persist.getOptions().merge?.(
      {
        entries: {
          [key]: {
            status: {
              connected: true,
              fetchedAt: 1_000,
              repo: { owner: "acme", repo: "app", url: "https://github.com/acme/app" },
              pr: { number: 12, title: "old", url: "u12", state: "merged", draft: false, base: "main", head: "feature" },
              checks: { state: "success", total: 1, success: 1, failure: 0, pending: 0 },
              canMerge: true,
            },
            isInitialStatusResolved: true,
            lastRefreshAt: Date.now(),
            lastDiscoveryPollAt: Date.now(),
            identity: {
              runtimeKey: "runtime-a",
              directory: "/repo",
              branch: "feature",
              remoteName: "origin",
            },
            resolvedRemoteName: "origin",
          },
        },
      },
      useGitHubPrStatusStore.getState(),
    ) as {
      entries: Record<string, {
        status: GitHubPullRequestStatus | null
        isInitialStatusResolved: boolean
        lastDiscoveryPollAt: number
      }>
    }

    expect(hydrated.entries[key]?.status?.pr?.number).toBe(12)
    expect(hydrated.entries[key]?.status?.repo).toEqual({
      owner: "acme",
      repo: "app",
      url: "https://github.com/acme/app",
    })
    expect(hydrated.entries[key]?.isInitialStatusResolved).toBe(true)
    // Restored history must not inherit a fresh discovery timestamp, otherwise
    // a newer open PR would wait a full discovery interval after every reload.
    expect(hydrated.entries[key]?.lastDiscoveryPollAt).toBe(0)
  })
})
