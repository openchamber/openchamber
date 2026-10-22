import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { TrackerAPI, TrackerAuthStatus } from "@/lib/api/types"

mock.module("@/lib/runtime-fetch", () => ({ runtimeFetch: async () => new Response("{}") }))

const { useTrackerAuthStore } = await import("./useTrackerAuthStore")

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

// Only `authStatus` is exercised here; the rest of the surface is present so
// the stub is a real `TrackerAPI` rather than an assertion over a fragment.
const unreachable = () => Promise.reject(new Error("not used in this test"))
const trackersApi = (authStatus: TrackerAPI["authStatus"]): TrackerAPI => ({
  providers: unreachable,
  authStatus,
  authStart: unreachable,
  authDisconnect: unreachable,
  authActivate: unreachable,
  list: unreachable,
  refreshListReads: unreachable,
  get: unreachable,
  states: unreachable,
  updateState: unreachable,
  mappingGet: unreachable,
  mappingSet: unreachable,
  sessionStatusPost: unreachable,
  preferencesGet: unreachable,
  preferencesSet: unreachable,
})

const entry = (provider: string) => useTrackerAuthStore.getState().entries[provider]

describe("tracker auth is scoped to the connected instance", () => {
  beforeEach(() => {
    useTrackerAuthStore.getState().resetForRuntimeSwitch()
  })

  test("a switch drops the previous instance's logins", async () => {
    await useTrackerAuthStore.getState().refreshStatus(
      trackersApi(async () => ({ connected: true })),
      "linear",
      { force: true },
    )
    expect(entry("linear")?.status?.connected).toBe(true)

    useTrackerAuthStore.getState().resetForRuntimeSwitch()

    expect(entry("linear")).toBeUndefined()
  })

  test("a status still in flight for the previous instance cannot land in the new one", async () => {
    const pending = deferred<TrackerAuthStatus>()
    const refresh = useTrackerAuthStore.getState().refreshStatus(
      trackersApi(() => pending.promise),
      "linear",
      { force: true },
    )

    useTrackerAuthStore.getState().resetForRuntimeSwitch()
    pending.resolve({ connected: true })
    await refresh

    expect(entry("linear")).toBeUndefined()
  })

  test("a failed check is not an authoritative disconnect", async () => {
    await useTrackerAuthStore.getState().refreshStatus(
      trackersApi(async () => ({ connected: true })),
      "linear",
      { force: true },
    )
    await useTrackerAuthStore.getState().refreshStatus(
      trackersApi(async () => { throw new Error("offline") }),
      "linear",
      { force: true },
    )

    expect(entry("linear")?.status?.connected).toBe(true)
    expect(entry("linear")?.status?.error).toBe("offline")
  })

  test("each tracker keeps its own status, asked with its own id", async () => {
    const asked: string[] = []
    await useTrackerAuthStore.getState().refreshAll(
      trackersApi(async (provider) => {
        asked.push(provider)
        return provider === "linear" ? { connected: true } : { connected: false }
      }),
      ["linear", "acme-tickets"],
      { force: true },
    )
    expect(asked.sort()).toEqual(["acme-tickets", "linear"])
    expect(entry("linear")?.status?.connected).toBe(true)
    expect(entry("acme-tickets")?.status?.connected).toBe(false)
  })
})
