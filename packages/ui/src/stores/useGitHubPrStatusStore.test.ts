import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ChangeRequestStatus, GitHubPullRequestStatus, RuntimeAPIs, SourceControlReadContext } from "@/lib/api/types"
import { getBoundSourceControlReadContexts } from "@/lib/source-control/identity"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

const {
  getFreshestPrStatusForBranch,
  getFreshestActiveSourceControlStatusForBranch,
  getFreshestSourceControlStatusForBranch,
  getGitHubPrStatusKey,
  getSourceControlStatusKey,
  useGitHubPrStatusStore,
} = await import("./useGitHubPrStatusStore")

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const readContext = (overrides: Partial<{
  provider: "github" | "gitlab"
  instance: string
  accountId: string
  repositoryId: string
  bindingRevision: number
  directory: string
  primaryRemote: string
}> = {}) => ({
  directory: "/repo",
  provider: "github" as const,
  instance: "github.com",
  accountId: "github.com#1",
  repositoryId: "repo_one",
  bindingRevision: 1,
  primaryRemote: "origin",
  ...overrides,
})

const canonicalStatus = (
  status: GitHubPullRequestStatus,
  context: SourceControlReadContext,
  branch: string,
): ChangeRequestStatus => {
  const project = status.repo ? {
    ...context,
    id: `${status.repo.owner}/${status.repo.repo}`,
    owner: status.repo.owner,
    name: status.repo.repo,
    url: status.repo.url,
  } : null
  const changeRequestProject = project ?? {
    ...context,
    id: context.repositoryId,
    owner: "",
    name: "",
    url: "",
  }
  return {
    identity: context,
    fetchedAt: status.fetchedAt,
    project,
    branch: status.branch ?? branch,
    changeRequest: status.pr ? {
      ...context,
      ...status.pr,
      id: String(status.pr.number),
      project: changeRequestProject,
    } : null,
    ci: status.checks ? { summary: status.checks } : null,
    canMerge: status.canMerge,
    defaultBranch: status.defaultBranch,
    resolvedRemoteName: status.resolvedRemoteName,
  }
}

const params = (loadStatus: () => Promise<GitHubPullRequestStatus>, branch = "main") => {
  const context = readContext()
  return {
    directory: context.directory,
    branch,
    remoteName: context.primaryRemote,
    canShow: true,
    identity: context,
    readContext: context,
    sourceControl: {
      changeRequestStatus: async () => canonicalStatus(await loadStatus(), context, branch),
    },
    authChecked: true,
    connected: true,
  }
}

const boundParams = (context = readContext(), branch = "feature") => ({
  directory: context.directory,
  branch,
  remoteName: context.primaryRemote,
  canShow: true,
  identity: context,
  readContext: context,
  sourceControl: {
    changeRequestStatus: async () => ({ identity: context, project: null, branch, changeRequest: null }),
  },
  authChecked: true,
  connected: true,
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

  test("isolates bound status by account and binding revision", () => {
    const accountA = getSourceControlStatusKey(readContext({ accountId: "github.com#1" }), "main")
    const accountB = getSourceControlStatusKey(readContext({ accountId: "github.com#2" }), "main")
    const nextRevision = getSourceControlStatusKey(readContext({ bindingRevision: 2 }), "main")

    expect(new Set([accountA, accountB, nextRevision]).size).toBe(3)
  })

  test("retains every watched entry when a new key temporarily exceeds the cache target", () => {
    useGitHubPrStatusStore.getState().ensureEntry("template")
    const template = useGitHubPrStatusStore.getState().entries.template
    expect(template).toBeDefined()
    if (!template) throw new Error("template entry was not created")
    const watchedEntries = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
      `watched-${index}`,
      { ...template, watchers: 1 },
    ]))
    useGitHubPrStatusStore.setState({ entries: watchedEntries })

    useGitHubPrStatusStore.getState().ensureEntry("new-entry")

    const entries = useGitHubPrStatusStore.getState().entries
    expect(Object.keys(entries)).toHaveLength(201)
    expect(entries["new-entry"]).toBeDefined()
    expect(Array.from({ length: 200 }, (_, index) => entries[`watched-${index}`]?.watchers).every((count) => count === 1)).toBe(true)
  })

  test("does not create status demand for missing or needs-attention bindings", () => {
    const repository = { repositoryId: "repo_one", configRevision: "config_one", bare: false, remotes: [] }
    expect(getBoundSourceControlReadContexts({ status: "missing", repository, revision: 0, binding: null }, "/repo")).toEqual([])
    expect(getBoundSourceControlReadContexts({
      status: "needs-attention",
      repository,
      revision: 2,
      binding: {
        repositoryId: "repo_one", revision: 2, state: "needs-attention", configRevision: "config_one",
        providers: [{ provider: "github", instance: "github.com", accountId: "github.com#1", primaryRemote: "origin", readiness: "account-unavailable", endpoint: null }],
        remotes: [],
        auxiliary: [],
      },
    }, "/repo")).toEqual([])
  })

  test("authoritative missing binding clears status and rejects an in-flight completion", async () => {
    const request = deferred<Awaited<ReturnType<RuntimeAPIs["sourceControl"]["changeRequestStatus"]>>>()
    const sourceControl = { changeRequestStatus: () => request.promise }
    const context = readContext()
    const key = getSourceControlStatusKey(context, "main")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, { ...boundParams(context, "main"), sourceControl })
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })

    useGitHubPrStatusStore.getState().clearDirectoryStatus("/repo")
    request.resolve({ identity: context, project: null, branch: "main", changeRequest: null })
    await loading

    const entry = useGitHubPrStatusStore.getState().entries[key]
    expect(entry?.status).toBeNull()
    expect(entry?.isInitialStatusResolved).toBe(false)
    expect(entry?.params).toBeNull()
    expect(entry?.isLoading).toBe(false)
  })

  test("rejects a bound response after its account context changes", async () => {
    const request = deferred<Awaited<ReturnType<RuntimeAPIs["sourceControl"]["changeRequestStatus"]>>>()
    const sourceControl = { changeRequestStatus: () => request.promise }
    const firstContext = readContext({ accountId: "github.com#1" })
    const key = getSourceControlStatusKey(firstContext, "main")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, {
      directory: firstContext.directory,
      branch: "main",
      remoteName: firstContext.primaryRemote,
      canShow: true,
      identity: firstContext,
      readContext: firstContext,
      sourceControl,
      authChecked: true,
      connected: true,
    })
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })
    const secondContext = readContext({ accountId: "github.com#2" })
    useGitHubPrStatusStore.getState().setParams(key, {
      directory: secondContext.directory,
      branch: "main",
      remoteName: secondContext.primaryRemote,
      canShow: true,
      identity: secondContext,
      readContext: secondContext,
      sourceControl,
      authChecked: true,
      connected: true,
    })
    request.resolve({ identity: firstContext, project: null, branch: "main", changeRequest: null })
    await loading

    expect(useGitHubPrStatusStore.getState().entries[key]?.status).toBeNull()
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

  test("provider-neutral branch readers return GitLab status", () => {
    const identity = { provider: "gitlab", instance: "https://gitlab.example.com" } as const
    const key = getSourceControlStatusKey(readContext({ ...identity, accountId: "gitlab-account" }), "feature")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().updateStatus(key, () => ({
      connected: true,
      identity,
      project: {
        ...identity,
        id: "1",
        owner: "team",
        name: "repo",
        url: "https://gitlab.example.com/team/repo",
      },
      branch: "feature",
      changeRequest: {
        ...identity,
        id: "12",
        number: 12,
        project: {
          ...identity,
          id: "1",
          owner: "team",
          name: "repo",
          url: "https://gitlab.example.com/team/repo",
        },
        title: "GitLab MR",
        url: "https://gitlab.example.com/team/repo/-/merge_requests/12",
        state: "open",
        draft: false,
        base: "main",
        head: "feature",
      },
      pr: null,
      repo: null,
    }))
    useGitHubPrStatusStore.setState((state) => ({
      entries: { ...state.entries, [key]: { ...state.entries[key], lastRefreshAt: 2 } },
    }))

    const freshest = getFreshestSourceControlStatusForBranch(
      useGitHubPrStatusStore.getState().entries,
      readContext({ ...identity, accountId: "gitlab-account" }),
      "feature",
    )
    expect(freshest?.changeRequest?.title).toBe("GitLab MR")
  })

  test("keeps simultaneous same-instance bound responses isolated by exact authority", async () => {
    const firstContext = readContext({ accountId: "github.com#1", repositoryId: "repo_one", bindingRevision: 3, primaryRemote: "origin" })
    const secondContext = readContext({ accountId: "github.com#2", repositoryId: "repo_two", bindingRevision: 7, primaryRemote: "upstream" })
    const firstRequest = deferred<Awaited<ReturnType<RuntimeAPIs["sourceControl"]["changeRequestStatus"]>>>()
    const secondRequest = deferred<Awaited<ReturnType<RuntimeAPIs["sourceControl"]["changeRequestStatus"]>>>()
    const firstKey = getSourceControlStatusKey(firstContext, "feature")
    const secondKey = getSourceControlStatusKey(secondContext, "feature")
    useGitHubPrStatusStore.getState().ensureEntry(firstKey)
    useGitHubPrStatusStore.getState().setParams(firstKey, {
      ...boundParams(firstContext),
      sourceControl: { changeRequestStatus: () => firstRequest.promise },
    })
    useGitHubPrStatusStore.getState().ensureEntry(secondKey)
    useGitHubPrStatusStore.getState().setParams(secondKey, {
      ...boundParams(secondContext),
      sourceControl: { changeRequestStatus: () => secondRequest.promise },
    })

    const firstRefresh = useGitHubPrStatusStore.getState().refresh(firstKey, { force: true })
    const secondRefresh = useGitHubPrStatusStore.getState().refresh(secondKey, { force: true })
    secondRequest.resolve({
      identity: secondContext, project: null, branch: "feature", changeRequest: null, defaultBranch: "second-main",
    })
    firstRequest.resolve({
      identity: firstContext, project: null, branch: "feature", changeRequest: null, defaultBranch: "first-main",
    })
    await Promise.all([firstRefresh, secondRefresh])

    const entries = useGitHubPrStatusStore.getState().entries
    expect(entries[firstKey]?.status?.defaultBranch).toBe("first-main")
    expect(entries[secondKey]?.status?.defaultBranch).toBe("second-main")
    expect(getFreshestSourceControlStatusForBranch(entries, firstContext, "feature")?.defaultBranch).toBe("first-main")
    expect(getFreshestSourceControlStatusForBranch(entries, secondContext, "feature")?.defaultBranch).toBe("second-main")
  })

  test("passive readers ignore superseded and unconfirmed bound status", () => {
    const previousContext = readContext({ accountId: "github.com#1", bindingRevision: 3 })
    const currentContext = readContext({ accountId: "github.com#2", bindingRevision: 4 })
    const previousKey = getSourceControlStatusKey(previousContext, "feature")
    const currentKey = getSourceControlStatusKey(currentContext, "feature")
    useGitHubPrStatusStore.getState().ensureEntry(previousKey)
    useGitHubPrStatusStore.getState().setParams(previousKey, boundParams(previousContext))
    useGitHubPrStatusStore.getState().updateStatus(previousKey, () => ({
      connected: true,
      identity: previousContext,
      project: null,
      branch: "feature",
      changeRequest: null,
      defaultBranch: "previous-main",
    }))

    useGitHubPrStatusStore.getState().ensureEntry(currentKey)
    useGitHubPrStatusStore.getState().setParams(currentKey, boundParams(currentContext))

    const entries = useGitHubPrStatusStore.getState().entries
    expect(getFreshestActiveSourceControlStatusForBranch(entries, [currentContext], "feature")).toBeNull()

    useGitHubPrStatusStore.getState().updateStatus(currentKey, () => ({
      connected: true,
      identity: currentContext,
      project: null,
      branch: "feature",
      changeRequest: null,
      defaultBranch: "current-main",
    }))
    expect(getFreshestActiveSourceControlStatusForBranch(
      useGitHubPrStatusStore.getState().entries,
      [currentContext],
      "feature",
    )?.defaultBranch).toBe("current-main")
  })

  test("rejects an older binding read that completes after a newer one", () => {
    const store = useGitHubPrStatusStore.getState()
    const olderOwnerId = "older-owner"
    const newerOwnerId = "newer-owner"
    const olderRequest = store.beginActiveContextsLoad("runtime-a", "/repo", olderOwnerId)
    const newerRequest = store.beginActiveContextsLoad("runtime-a", "/repo", newerOwnerId)
    const olderContext = readContext({ repositoryId: "old_repo", bindingRevision: 7 })
    const newerContext = readContext({ repositoryId: "new_repo", bindingRevision: 1 })

    expect(store.commitActiveContexts("runtime-a", "/repo", olderOwnerId, olderRequest, [olderContext])).toBe(false)
    store.commitActiveContexts("runtime-a", "/repo", newerOwnerId, newerRequest, [newerContext])
    store.commitActiveContexts("runtime-a", "/repo", olderOwnerId, olderRequest, [olderContext])

    expect(useGitHubPrStatusStore.getState().activeContextRegistrations[JSON.stringify(["runtime-a", "/repo"])])
      .toEqual({ [newerOwnerId]: { requestId: newerRequest, contexts: [newerContext] } })
  })

  test("keeps mounted owners on the newest authoritative contexts", () => {
    const store = useGitHubPrStatusStore.getState()
    const firstOwner = "first-owner"
    const secondOwner = "second-owner"
    const firstRequest = store.beginActiveContextsLoad("runtime-a", "/repo", firstOwner)
    store.commitActiveContexts("runtime-a", "/repo", firstOwner, firstRequest, [readContext({ repositoryId: "old_repo" })])
    const secondRequest = store.beginActiveContextsLoad("runtime-a", "/repo", secondOwner)
    const currentContext = readContext({ repositoryId: "new_repo", bindingRevision: 1 })
    store.commitActiveContexts("runtime-a", "/repo", secondOwner, secondRequest, [currentContext])

    store.releaseActiveContexts("runtime-a", "/repo", secondOwner)

    expect(useGitHubPrStatusStore.getState().activeContextRegistrations[JSON.stringify(["runtime-a", "/repo"])])
      .toEqual({ [firstOwner]: { requestId: secondRequest, contexts: [currentContext] } })
  })

  test("releases active binding contexts with their owner", () => {
    const store = useGitHubPrStatusStore.getState()
    const ownerId = "test-owner"
    const requestId = store.beginActiveContextsLoad("runtime-a", "/repo", ownerId)
    store.commitActiveContexts("runtime-a", "/repo", ownerId, requestId, [readContext()])

    store.releaseActiveContexts("runtime-a", "/repo", ownerId)

    expect(useGitHubPrStatusStore.getState().activeContextRegistrations[JSON.stringify(["runtime-a", "/repo"])])
      .toBe(undefined)
  })

  test("allows an earlier owner to finish after a newer pending owner releases", () => {
    const store = useGitHubPrStatusStore.getState()
    const firstOwner = "first-owner"
    const cancelledOwner = "cancelled-owner"
    const firstRequest = store.beginActiveContextsLoad("runtime-a", "/repo", firstOwner)
    store.beginActiveContextsLoad("runtime-a", "/repo", cancelledOwner)

    store.releaseActiveContexts("runtime-a", "/repo", cancelledOwner)

    expect(store.commitActiveContexts("runtime-a", "/repo", firstOwner, firstRequest, [readContext()])).toBe(true)
  })

  test("passive readers prefer an active provider with a change request", () => {
    const githubContext = readContext({ bindingRevision: 3 })
    const gitlabContext = readContext({
      provider: "gitlab",
      instance: "https://gitlab.example.com",
      accountId: "gitlab-account",
      bindingRevision: 3,
    })
    const githubKey = getSourceControlStatusKey(githubContext, "feature")
    const gitlabKey = getSourceControlStatusKey(gitlabContext, "feature")
    useGitHubPrStatusStore.getState().ensureEntry(githubKey)
    useGitHubPrStatusStore.getState().setParams(githubKey, boundParams(githubContext))
    useGitHubPrStatusStore.getState().updateStatus(githubKey, () => ({
      connected: true,
      identity: githubContext,
      project: null,
      branch: "feature",
      changeRequest: null,
      pr: { number: 7, title: "PR", url: "https://github.com/acme/app/pull/7", state: "open", draft: false, base: "main", head: "feature" },
    }))
    useGitHubPrStatusStore.getState().ensureEntry(gitlabKey)
    useGitHubPrStatusStore.getState().setParams(gitlabKey, boundParams(gitlabContext))
    useGitHubPrStatusStore.getState().updateStatus(gitlabKey, () => ({
      connected: true,
      identity: gitlabContext,
      project: null,
      branch: "feature",
      changeRequest: null,
    }))
    useGitHubPrStatusStore.setState((state) => ({
      entries: state.entries[githubKey] && state.entries[gitlabKey]
        ? {
            ...state.entries,
            [githubKey]: { ...state.entries[githubKey], lastRefreshAt: 1 },
            [gitlabKey]: { ...state.entries[gitlabKey], lastRefreshAt: 2 },
          }
        : state.entries,
    }))

    expect(getFreshestActiveSourceControlStatusForBranch(
      useGitHubPrStatusStore.getState().entries,
      [githubContext, gitlabContext],
      "feature",
    )?.pr?.number).toBe(7)
  })

  test("setting one bound authority does not clear another bound branch status", () => {
    const githubKey = getGitHubPrStatusKey("/repo", "feature", "origin")
    const gitlabIdentity = { provider: "gitlab", instance: "https://gitlab.example.com" } as const
    const gitlabKey = getSourceControlStatusKey(readContext({ ...gitlabIdentity, accountId: "gitlab-account" }), "feature")
    useGitHubPrStatusStore.getState().ensureEntry(githubKey)
    useGitHubPrStatusStore.getState().updateStatus(githubKey, () => ({
      connected: true,
      pr: { number: 7, title: "stale", url: "u7", state: "open", draft: false, base: "main", head: "feature" },
    }))
    useGitHubPrStatusStore.getState().ensureEntry(gitlabKey)

    useGitHubPrStatusStore.getState().setParams(gitlabKey, {
      directory: "/repo",
      branch: "feature",
      remoteName: "origin",
      canShow: true,
      identity: gitlabIdentity,
      authChecked: true,
      connected: true,
    })

    expect(useGitHubPrStatusStore.getState().entries[githubKey]?.status?.pr?.title).toBe("stale")
  })

  test("rejects a response after params change", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const loadStatus = () => request.promise
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus))
    const loading = useGitHubPrStatusStore.getState().refresh(key, { force: true })

    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, "next"))
    request.resolve({ connected: true, pr: null })
    await loading

    expect(useGitHubPrStatusStore.getState().entries[key]?.status).toBe(null)
    expect(useGitHubPrStatusStore.getState().entries[key]?.isLoading).toBe(false)
  })

  test("rejects an old runtime response after reset", async () => {
    const request = deferred<GitHubPullRequestStatus>()
    const loadStatus = () => request.promise
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus))
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
    const loadStatus = async (): Promise<GitHubPullRequestStatus> => {
      requestCount += 1
      throw new Error("GitHub rate limited")
    }
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus))

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
    const firstStatus = () => first.promise
    const secondStatus = () => second.promise
    const staleStatus = async (): Promise<GitHubPullRequestStatus> => {
      staleRequestCount += 1
      return { connected: true, pr: null }
    }
    const replacementStatus = async (): Promise<GitHubPullRequestStatus> => {
      replacementRequestCount += 1
      return { connected: true, pr: null }
    }
    const firstKey = getGitHubPrStatusKey("/repo", "first", "origin")
    const secondKey = getGitHubPrStatusKey("/repo", "second", "origin")
    const queuedKey = getGitHubPrStatusKey("/repo", "queued", "origin")

    for (const [key, loadStatus, branch] of [
      [firstKey, firstStatus, "first"],
      [secondKey, secondStatus, "second"],
      [queuedKey, staleStatus, "queued"],
    ] as const) {
      useGitHubPrStatusStore.getState().ensureEntry(key)
      useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, branch))
    }

    const firstRefresh = useGitHubPrStatusStore.getState().refresh(firstKey, { force: true })
    const secondRefresh = useGitHubPrStatusStore.getState().refresh(secondKey, { force: true })
    const staleRefresh = useGitHubPrStatusStore.getState().refresh(queuedKey, { force: true })
    await Promise.resolve()
    useGitHubPrStatusStore.getState().setParams(queuedKey, params(replacementStatus, "queued"))
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
    const loadStatus = async () => responses.shift()!
    const key = getGitHubPrStatusKey("/repo", "main", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus))

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
    const loadStatus = async () => {
      requestCount += 1
      return requestCount === 1 ? merged : newerOpen
    }
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, "feature"))

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
    const loadStatus = async () => empty
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
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, "feature"))

    await useGitHubPrStatusStore.getState().refresh(key, { force: true })

    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr).toBeNull()
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.repo).toEqual({
      accountId: "github.com#1",
      bindingRevision: 1,
      directory: "/repo",
      id: "acme/app",
      instance: "github.com",
      name: "app",
      owner: "acme",
      primaryRemote: "origin",
      provider: "github",
      repo: "app",
      repositoryId: "repo_one",
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
    const loadStatus = async () => {
      requestCount += 1
      return responses.shift()!
    }
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, "feature"))
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
    const loadStatus = async () => {
      requestCount += 1
      return responses.shift()!
    }
    const key = getGitHubPrStatusKey("/repo", "feature", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, "feature"))
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
    const loadStatus = async (): Promise<GitHubPullRequestStatus> => {
      throw new Error("GitHub unavailable")
    }
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
    useGitHubPrStatusStore.getState().setParams(key, params(loadStatus, "feature"))

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
    const context = readContext()
    const key = getSourceControlStatusKey(context, "feature")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, boundParams(context))
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
    const context = readContext()
    const key = getSourceControlStatusKey(context, "feature")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, boundParams(context))
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
    const context = readContext()
    const key = getSourceControlStatusKey(context, "feature")
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
              provider: "github",
              instance: "github.com",
              accountId: context.accountId,
              repositoryId: context.repositoryId,
              bindingRevision: context.bindingRevision,
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

  test("rejects legacy persistence without bound account dimensions", () => {
    const legacyKey = JSON.stringify(["runtime-a", "/repo", "feature", "origin"])
    const hydrated = useGitHubPrStatusStore.persist.getOptions().merge?.(
      {
        entries: {
          [legacyKey]: {
            status: {
              connected: true,
              pr: { number: 21, title: "legacy", url: "u21", state: "open", draft: false, base: "main", head: "feature" },
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
    ) as ReturnType<typeof useGitHubPrStatusStore.getState>

    expect(hydrated.entries[legacyKey]).toBe(undefined)
    expect(Object.keys(hydrated.entries)).toHaveLength(0)
  })

  test("rejects persisted status whose branch disagrees with its bound key", () => {
    const context = readContext()
    const key = getSourceControlStatusKey(context, "feature")
    const hydrated = useGitHubPrStatusStore.persist.getOptions().merge?.(
      {
        entries: {
          [key]: {
            status: { connected: true, branch: "other", pr: null },
            isInitialStatusResolved: true,
            lastRefreshAt: Date.now(),
            lastDiscoveryPollAt: 0,
            identity: {
              runtimeKey: "runtime-a",
              provider: context.provider,
              instance: context.instance,
              accountId: context.accountId,
              repositoryId: context.repositoryId,
              bindingRevision: context.bindingRevision,
              directory: context.directory,
              branch: "feature",
              remoteName: context.primaryRemote,
            },
            resolvedRemoteName: context.primaryRemote,
          },
        },
      },
      useGitHubPrStatusStore.getState(),
    )

    expect(hydrated?.entries[key]).toBe(undefined)
  })

  test("strips provider-neutral nested objects from persisted display status", () => {
    const context = readContext()
    const key = getSourceControlStatusKey(context, "feature")
    const hydrated = useGitHubPrStatusStore.persist.getOptions().merge?.(
      {
        entries: {
          [key]: {
            status: {
              connected: true,
              branch: "feature",
              pr: null,
              project: { provider: "github", instance: "github.com", unsafe: true },
              changeRequest: { provider: "github", instance: "github.com", unsafe: true },
              ci: { unsafe: true },
            },
            isInitialStatusResolved: true,
            lastRefreshAt: Date.now(),
            lastDiscoveryPollAt: 0,
            identity: {
              runtimeKey: "runtime-a",
              provider: context.provider,
              instance: context.instance,
              accountId: context.accountId,
              repositoryId: context.repositoryId,
              bindingRevision: context.bindingRevision,
              directory: context.directory,
              branch: "feature",
              remoteName: context.primaryRemote,
            },
            resolvedRemoteName: context.primaryRemote,
          },
        },
      },
      useGitHubPrStatusStore.getState(),
    )

    expect(hydrated?.entries[key]?.status).toEqual({ connected: true, branch: "feature", pr: null })

    const project = {
      provider: "github" as const,
      instance: "github.com",
      id: "acme/app",
      owner: "acme",
      name: "app",
      url: "https://github.com/acme/app",
    }
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, boundParams(context))
    useGitHubPrStatusStore.getState().updateStatus(key, () => ({
      connected: true,
      identity: context,
      project,
      branch: "feature",
      changeRequest: {
        ...context,
        id: "acme/app#1",
        number: 1,
        project,
        title: "Feature",
        url: "https://github.com/acme/app/pull/1",
        state: "open",
        draft: false,
        base: "main",
        head: "feature",
      },
      ci: { summary: { state: "success", total: 1, success: 1, failure: 0, pending: 0 } },
      pr: null,
      repo: null,
    }))
    useGitHubPrStatusStore.setState((state) => {
      const entry = state.entries[key]
      return entry ? { entries: { ...state.entries, [key]: { ...entry, lastRefreshAt: Date.now() } } } : state
    })

    const persisted = useGitHubPrStatusStore.persist.getOptions().partialize?.(useGitHubPrStatusStore.getState())
    const serialized = JSON.stringify(persisted)
    expect(serialized).not.toContain('"changeRequest"')
    expect(serialized).not.toContain('"project"')
    expect(serialized).not.toContain('"ci"')
  })

  test("rejects current persistence whose serialized key disagrees with embedded authority", () => {
    const keyContext = readContext({ accountId: "github.com#1", repositoryId: "repo_one", bindingRevision: 3 })
    const embeddedContext = readContext({ accountId: "github.com#2", repositoryId: "repo_two", bindingRevision: 7 })
    const key = getSourceControlStatusKey(keyContext, "feature")
    const current = useGitHubPrStatusStore.getState()
    const hydrated = useGitHubPrStatusStore.persist.getOptions().merge?.(
      {
        entries: {
          [key]: {
            status: null,
            isInitialStatusResolved: true,
            lastRefreshAt: Date.now(),
            lastDiscoveryPollAt: Date.now(),
            identity: {
              runtimeKey: "runtime-a",
              provider: embeddedContext.provider,
              instance: embeddedContext.instance,
              accountId: embeddedContext.accountId,
              repositoryId: embeddedContext.repositoryId,
              bindingRevision: embeddedContext.bindingRevision,
              directory: embeddedContext.directory,
              branch: "feature",
              remoteName: embeddedContext.primaryRemote,
            },
            resolvedRemoteName: embeddedContext.primaryRemote,
          },
        },
      },
      current,
    )

    expect(hydrated).toEqual({ ...current, entries: {} })
  })
})
