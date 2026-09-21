import { beforeEach, describe, expect, mock, test } from "bun:test"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

const { gitBaseBranchEntryKey, useGitBaseBranchStore } = await import("./useGitBaseBranchStore")

describe("git base branch overrides", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    useGitBaseBranchStore.setState({ overrides: {} })
  })

  test("keys the same repository per branch and runtime", () => {
    const featureA = gitBaseBranchEntryKey("/repo", "feature-a")
    const featureB = gitBaseBranchEntryKey("/repo", "feature-b")
    runtimeKey = "runtime-b"
    const featureARemote = gitBaseBranchEntryKey("/repo", "feature-a")

    expect(new Set([featureA, featureB, featureARemote]).size).toBe(3)
  })

  test("a base picked for one branch does not apply to another branch", () => {
    const store = useGitBaseBranchStore.getState()
    store.setOverride("/repo", "feature-a", "main")

    expect(store.getOverride("/repo", "feature-a")).toBe("main")
    // feature-b must fall back to its own detection, not feature-a's choice.
    expect(store.getOverride("/repo", "feature-b")).toBeNull()
  })

  test("different branches of one repository keep independent bases", () => {
    const store = useGitBaseBranchStore.getState()
    store.setOverride("/repo", "feature-a", "main")
    store.setOverride("/repo", "feature-b", "develop")

    expect(store.getOverride("/repo", "feature-a")).toBe("main")
    expect(store.getOverride("/repo", "feature-b")).toBe("develop")
  })

  test("clearOverride removes only the targeted branch's choice", () => {
    const store = useGitBaseBranchStore.getState()
    store.setOverride("/repo", "feature-a", "main")
    store.setOverride("/repo", "feature-b", "develop")
    store.clearOverride("/repo", "feature-a")

    expect(store.getOverride("/repo", "feature-a")).toBeNull()
    expect(store.getOverride("/repo", "feature-b")).toBe("develop")
  })

  test("rejects empty directory, branch, or base", () => {
    const store = useGitBaseBranchStore.getState()
    store.setOverride("", "feature-a", "main")
    store.setOverride("/repo", "", "main")
    store.setOverride("/repo", "feature-a", "")
    store.clearOverride("", "feature-a")

    expect(useGitBaseBranchStore.getState().overrides).toEqual({})
    expect(store.getOverride("", "feature-a")).toBeNull()
    expect(store.getOverride("/repo", "")).toBeNull()
  })
})
