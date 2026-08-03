import { describe, expect, test } from "bun:test"
import { getBackgroundNetworkState, runBackgroundNetworkTask } from "./background-network"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
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
})
