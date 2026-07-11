import { describe, expect, test } from "bun:test"

import { SessionSyncCoordinator } from "../session-sync-coordinator"

describe("SessionSyncCoordinator", () => {
  test("coalesces duplicate materialization in the same store lifecycle", async () => {
    const coordinator = new SessionSyncCoordinator()
    const scope = {}
    let calls = 0
    let release: (() => void) | undefined
    const request = () => {
      calls += 1
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }

    const first = coordinator.run({ scope, key: "/repo\nses_1", request })
    const duplicate = coordinator.run({ scope, key: "/repo\nses_1", request })

    expect(calls).toBe(1)
    expect(duplicate).toBe(first)
    release?.()
    await Promise.all([first, duplicate])
  })

  test("does not reuse a detached provider store promise after remount", async () => {
    const coordinator = new SessionSyncCoordinator()
    const detachedStore = {}
    const activeStore = {}
    const releases: Array<() => void> = []
    let calls = 0
    const request = () => {
      calls += 1
      return new Promise<void>((resolve) => releases.push(resolve))
    }

    const detached = coordinator.run({ scope: detachedStore, key: "/repo\nses_1", request })
    const active = coordinator.run({ scope: activeStore, key: "/repo\nses_1", request })

    expect(calls).toBe(2)
    expect(active).not.toBe(detached)
    releases.forEach((release) => release())
    await Promise.all([detached, active])
  })

  test("clears a rejected request so the same store can retry", async () => {
    const coordinator = new SessionSyncCoordinator()
    const scope = {}
    let calls = 0
    const request = async () => {
      calls += 1
      if (calls === 1) throw new Error("runtime not ready")
    }

    await expect(coordinator.run({ scope, key: "/repo\nses_1", request })).rejects.toThrow("runtime not ready")
    await coordinator.run({ scope, key: "/repo\nses_1", request })
    expect(calls).toBe(2)
  })
})
