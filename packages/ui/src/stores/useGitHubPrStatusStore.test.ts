import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { GitHubPullRequestStatus, RuntimeAPIs } from "@/lib/api/types"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

const { getGitHubPrStatusKey, useGitHubPrStatusStore } = await import("./useGitHubPrStatusStore")

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
})
