import { describe, expect, test } from "bun:test"
import { getBackgroundNetworkState, runBackgroundNetworkTask, runSessionListNetworkTask } from "./background-network"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe("runBackgroundNetworkTask", () => {
  test("caps concurrent tasks at the limit and drains waiters in order", async () => {
    const { limit } = getBackgroundNetworkState()
    const gates = Array.from({ length: limit + 2 }, () => deferred<string>())
    const started: number[] = []
    const results = gates.map((gate, index) => runBackgroundNetworkTask(() => {
      started.push(index)
      return gate.promise
    }))

    await Promise.resolve()
    expect(started).toEqual(Array.from({ length: limit }, (_, index) => index))
    expect(getBackgroundNetworkState().active).toBe(limit)
    expect(getBackgroundNetworkState().waiting).toBe(2)

    gates[0].resolve("a")
    await results[0]
    expect(started).toContain(limit)

    for (const [index, gate] of gates.entries()) gate.resolve(`v${index}`)
    expect(await Promise.all(results)).toEqual(["a", ...gates.slice(1).map((_, index) => `v${index + 1}`)])
    expect(getBackgroundNetworkState().active).toBe(0)
    expect(getBackgroundNetworkState().waiting).toBe(0)
  })

  test("releases the slot when a task rejects", async () => {
    await expect(runBackgroundNetworkTask(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(getBackgroundNetworkState().active).toBe(0)
    const value = await runBackgroundNetworkTask(() => Promise.resolve(42))
    expect(value).toBe(42)
  })

  test("a blocked background read and a blocked directory leave capacity for other session lists", async () => {
    const background = deferred<void>()
    const directory = deferred<void>()
    const backgroundRead = runBackgroundNetworkTask(() => background.promise)
    const directoryRead = runSessionListNetworkTask(() => directory.promise)
    try {
      for (let index = 0; index < 24; index += 1) {
        expect(await runSessionListNetworkTask(async () => index)).toBe(index)
        const state = getBackgroundNetworkState()
        expect(state.active + state.sessionLists.active).toBeLessThanOrEqual(3)
      }
    } finally {
      background.resolve()
      directory.resolve()
      await Promise.all([backgroundRead, directoryRead])
    }
    expect(getBackgroundNetworkState().sessionLists.active).toBe(0)
  })

  test("session-list failures release their own capacity", async () => {
    await expect(runSessionListNetworkTask(async () => { throw new Error("offline") })).rejects.toThrow("offline")
    expect(getBackgroundNetworkState().sessionLists.active).toBe(0)
    expect(await runSessionListNetworkTask(async () => "recovered")).toBe("recovered")
  })

  test("active-session recovery runs before queued metadata without increasing concurrency", async () => {
    const blocked = Array.from({ length: getBackgroundNetworkState().limit }, () => deferred<void>())
    const occupied = blocked.map((task) => runBackgroundNetworkTask(() => task.promise))
    const order: string[] = []
    const metadata = runBackgroundNetworkTask(async () => { order.push("metadata") })
    const activeSession = runBackgroundNetworkTask(async () => { order.push("active-session") }, "active-session")
    for (const task of blocked) task.resolve()
    await Promise.all([...occupied, metadata, activeSession])
    expect(order).toEqual(["active-session", "metadata"])
  })

  test("two blocked background reads cannot consume the reserved session-list capacity", async () => {
    const blocked = Array.from({ length: getBackgroundNetworkState().limit }, () => deferred<void>())
    const reads = blocked.map((task) => runBackgroundNetworkTask(() => task.promise))
    try {
      expect(await runSessionListNetworkTask(async () => "loaded")).toBe("loaded")
      expect(getBackgroundNetworkState().active).toBe(2)
    } finally {
      for (const task of blocked) task.resolve()
      await Promise.all(reads)
    }
  })
})
