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
})
