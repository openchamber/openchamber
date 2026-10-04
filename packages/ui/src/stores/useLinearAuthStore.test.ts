import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { LinearAPI, LinearAuthStatus } from "@/lib/api/types"

mock.module("@/lib/runtime-fetch", () => ({ runtimeFetch: async () => new Response("{}") }))

const { useLinearAuthStore } = await import("./useLinearAuthStore")

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

// Only `authStatus` is exercised here; the rest of the surface is present so
// the stub is a real `LinearAPI` rather than an assertion over a fragment.
const unreachable = () => Promise.reject(new Error("not used in this test"))
const linearApi = (authStatus: LinearAPI["authStatus"]): LinearAPI => ({
  authStatus,
  authStart: unreachable,
  authDisconnect: unreachable,
  authActivate: unreachable,
  issuesList: unreachable,
  issueGet: unreachable,
  issueStates: unreachable,
  issueUpdate: unreachable,
  mappingGet: unreachable,
  mappingSet: unreachable,
  sessionStatusPost: unreachable,
  preferencesGet: unreachable,
  preferencesSet: unreachable,
})

describe("Linear auth is scoped to the connected instance", () => {
  beforeEach(() => {
    useLinearAuthStore.getState().resetForRuntimeSwitch()
  })

  test("a switch drops the previous instance's login", async () => {
    await useLinearAuthStore.getState().refreshStatus(
      linearApi(async () => ({ connected: true })),
      { force: true },
    )
    expect(useLinearAuthStore.getState().status?.connected).toBe(true)

    useLinearAuthStore.getState().resetForRuntimeSwitch()

    expect(useLinearAuthStore.getState().status).toBeNull()
    expect(useLinearAuthStore.getState().hasChecked).toBe(false)
  })

  test("a status still in flight for the previous instance cannot land in the new one", async () => {
    const pending = deferred<LinearAuthStatus>()
    const refresh = useLinearAuthStore.getState().refreshStatus(
      linearApi(() => pending.promise),
      { force: true },
    )

    useLinearAuthStore.getState().resetForRuntimeSwitch()
    pending.resolve({ connected: true })
    await refresh

    expect(useLinearAuthStore.getState().status).toBeNull()
    expect(useLinearAuthStore.getState().hasChecked).toBe(false)
  })

  test("a failed check is not an authoritative disconnect", async () => {
    await useLinearAuthStore.getState().refreshStatus(
      linearApi(async () => ({ connected: true })),
      { force: true },
    )
    await useLinearAuthStore.getState().refreshStatus(
      linearApi(async () => { throw new Error("offline") }),
      { force: true },
    )

    expect(useLinearAuthStore.getState().status?.connected).toBe(true)
    expect(useLinearAuthStore.getState().status?.error).toBe("offline")
  })
})
