import { beforeEach, describe, expect, test } from "bun:test"
import { useGitHubPrStatusStore } from "@/stores/useGitHubPrStatusStore"
import { reconcileRegisteredContextDirectories, type RegisteredContextDirectories } from "./registeredContextDirectories"

const OWNER = "sidebar-owner"

const readContext = (directory: string) => ({
  directory,
  provider: "github" as const,
  instance: "github.com",
  accountId: "github.com#1",
  repositoryId: "repo_one",
  bindingRevision: 1,
  primaryRemote: "origin",
})

const registrationOf = (runtimeKey: string, directory: string) =>
  useGitHubPrStatusStore.getState().activeContextRegistrations[JSON.stringify([runtimeKey, directory])]?.[OWNER]

// What the sidebar does for each shown directory: reconcile, then load and commit.
const show = (registered: RegisteredContextDirectories, runtimeKey: string, directories: string[]) => {
  const store = useGitHubPrStatusStore.getState()
  reconcileRegisteredContextDirectories(registered, runtimeKey, new Set(directories), (key, directory) => {
    store.releaseActiveContexts(key, directory, OWNER)
  })
}

const load = (runtimeKey: string, directory: string) => {
  const store = useGitHubPrStatusStore.getState()
  const requestId = store.beginActiveContextsLoad(runtimeKey, directory, OWNER)
  return () => store.commitActiveContexts(runtimeKey, directory, OWNER, requestId, [readContext(directory)])
}

describe("reconcileRegisteredContextDirectories", () => {
  beforeEach(() => {
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
  })

  test("deleting one worktree keeps the other worktrees' registrations while their fresh read is in flight", () => {
    const registered: RegisteredContextDirectories = new Map()
    show(registered, "runtime-a", ["/wt-a", "/wt-b", "/wt-c"])
    for (const directory of ["/wt-a", "/wt-b", "/wt-c"]) load("runtime-a", directory)()
    const before = { a: registrationOf("runtime-a", "/wt-a"), c: registrationOf("runtime-a", "/wt-c") }
    const lateCommitForB = load("runtime-a", "/wt-b")

    show(registered, "runtime-a", ["/wt-a", "/wt-c"])

    expect(registrationOf("runtime-a", "/wt-a")).toBe(before.a)
    expect(registrationOf("runtime-a", "/wt-c")).toBe(before.c)
    expect(registrationOf("runtime-a", "/wt-b")).toBeUndefined()
    expect(lateCommitForB()).toBe(false)
    expect(registrationOf("runtime-a", "/wt-b")).toBeUndefined()
    expect([...registered]).toEqual([["/wt-a", "runtime-a"], ["/wt-c", "runtime-a"]])
  })

  test("adding a worktree or renaming another's branch releases nothing", () => {
    const registered: RegisteredContextDirectories = new Map()
    show(registered, "runtime-a", ["/wt-a", "/wt-c"])
    load("runtime-a", "/wt-a")()
    load("runtime-a", "/wt-c")()
    const before = useGitHubPrStatusStore.getState().activeContextRegistrations

    // The shown set is rebuilt from directory and branch, so a new worktree or a
    // renamed branch reaches here as the same directories plus maybe one more.
    show(registered, "runtime-a", ["/wt-a", "/wt-c", "/wt-d"])

    expect(useGitHubPrStatusStore.getState().activeContextRegistrations).toBe(before)
    expect(registered.get("/wt-d")).toBe("runtime-a")
  })

  test("a runtime switch releases what was registered under the previous runtime", () => {
    const registered: RegisteredContextDirectories = new Map()
    show(registered, "runtime-a", ["/wt-a"])
    load("runtime-a", "/wt-a")()

    show(registered, "runtime-b", ["/wt-a"])

    expect(registrationOf("runtime-a", "/wt-a")).toBeUndefined()
    expect(registered.get("/wt-a")).toBe("runtime-b")
  })

  test("an empty shown set, as on unmount, releases every registration", () => {
    const registered: RegisteredContextDirectories = new Map()
    show(registered, "runtime-a", ["/wt-a", "/wt-c"])
    load("runtime-a", "/wt-a")()
    load("runtime-a", "/wt-c")()

    show(registered, "runtime-a", [])

    expect(useGitHubPrStatusStore.getState().activeContextRegistrations).toEqual({})
    expect(registered.size).toBe(0)
  })
})
