import { beforeEach, describe, expect, test } from "bun:test"
import type { WorktreeMetadata } from "@/types/worktree"
import { persistWorktreeTopology, readPersistedWorktreeTopology } from "./worktree-topology-cache"

class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const worktree = (path: string): WorktreeMetadata => ({ path, branch: path.split("/").pop() ?? "main" }) as WorktreeMetadata
let storage: TestStorage

beforeEach(() => {
  storage = new TestStorage()
})

describe("worktree topology persistence", () => {
  test("restores independent runtime topologies across A -> B -> A", () => {
    persistWorktreeTopology("runtime-a", new Map([["/repo", [worktree("/repo/a")]]]), storage)
    persistWorktreeTopology("runtime-b", new Map([["/repo", [worktree("/repo/b")]]]), storage)

    expect(readPersistedWorktreeTopology("runtime-a", storage).get("/repo")?.[0]?.path).toBe("/repo/a")
    expect(readPersistedWorktreeTopology("runtime-b", storage).get("/repo")?.[0]?.path).toBe("/repo/b")
  })

  test("claims the legacy topology for only the first runtime", () => {
    storage.setItem("oc.worktreeMap", JSON.stringify([["/repo", [worktree("/repo/legacy")]]]))

    expect(readPersistedWorktreeTopology("runtime-a", storage).get("/repo")?.[0]?.path).toBe("/repo/legacy")
    expect(readPersistedWorktreeTopology("runtime-b", storage).size).toBe(0)
    expect(storage.getItem("oc.worktreeMap")).toBeNull()
  })

  test("bounds retained runtime namespaces", () => {
    for (let index = 0; index < 10; index += 1) {
      persistWorktreeTopology(`runtime-${index}`, new Map([[`/repo-${index}`, [worktree(`/repo-${index}/wt`)]]]), storage)
    }

    const envelope = JSON.parse(storage.getItem("oc.worktreeMap.v2") ?? "{}") as { runtimes?: Record<string, unknown> }
    expect(Object.keys(envelope.runtimes ?? {})).toHaveLength(8)
  })
})
