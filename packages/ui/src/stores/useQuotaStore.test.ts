import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { ProviderResult } from "@/types"

let runtimeKey = "url:https://instance-a"
let isInitialized = true
const fetched: string[] = []

type StubPayload = { usageDropdownProviders: string[] } | ProviderResult
let quotaRequestsFail = false
let quotaFails = false;
const json = (body: StubPayload) => new Response(
  JSON.stringify(body),
  { status: 200, headers: { "content-type": "application/json" } },
)

// Spread the real modules so the overrides stay a patch: `mock.module` is
// process-global, and a partial replacement would break every other module
// that imports something else from these files.
const runtimeSwitch = await import("@/lib/runtime-switch")
mock.module("@/lib/runtime-switch", () => ({ ...runtimeSwitch, getRuntimeKey: () => runtimeKey }))

const runtimeFetchModule = await import("@/lib/runtime-fetch")
mock.module("@/lib/runtime-fetch", () => ({
  ...runtimeFetchModule,
  runtimeFetch: async (path: string) => {
    fetched.push(path)
    if (quotaRequestsFail) throw new Error("network down")
    if (path.startsWith("/api/config/settings")) return json({ usageDropdownProviders: ["claude"] })
    // A reachable instance reporting a provider failure, which is different
    // from the transport failure `quotaRequestsFail` models.
    if (quotaFails) return json({ providerId: "claude", providerName: "Claude", ok: false, configured: true, error: "authentication failed", usage: null, fetchedAt: 2 })
    return json({ providerId: "claude", providerName: "Claude", ok: true, configured: true, usage: null, fetchedAt: 1 })
  },
}))

const configStoreModule = await import("@/stores/useConfigStore")
mock.module("@/stores/useConfigStore", () => ({
  ...configStoreModule,
  useConfigStore: { ...configStoreModule.useConfigStore, getState: () => ({ isInitialized }) },
}))

const { useQuotaStore } = await import("./useQuotaStore")

describe("Usage quotas are loaded once per ready instance", () => {
  beforeEach(() => {
    runtimeKey = "url:https://instance-a"
    isInitialized = true
    fetched.length = 0
    quotaRequestsFail = false
    useQuotaStore.getState().resetForRuntimeSwitch()
  })

  test("nothing is fetched while the instance has not reported itself initialised", async () => {
    isInitialized = false
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched).toHaveLength(0)
    expect(useQuotaStore.getState().loadedRuntimeKey).toBeNull()

    // The instance finishes starting up: the same call now performs the load
    // that a mount-time fetch would have answered "nothing configured".
    isInitialized = true
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBeGreaterThan(0)
    expect(useQuotaStore.getState().results.length).toBeGreaterThan(0)
  })

  test("a second ask for the same instance does not refetch", async () => {
    await useQuotaStore.getState().ensureLoadedForRuntime()
    const afterFirst = fetched.length
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBe(afterFirst)
  })

  test("a switch drops the previous instance's quotas and reloads for the new one", async () => {
    await useQuotaStore.getState().ensureLoadedForRuntime()
    expect(useQuotaStore.getState().results.length).toBeGreaterThan(0)

    useQuotaStore.getState().resetForRuntimeSwitch()
    expect(useQuotaStore.getState().results).toEqual([])
    expect(useQuotaStore.getState().lastUpdated).toBeNull()

    runtimeKey = "url:https://instance-b"
    fetched.length = 0
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBeGreaterThan(0)
    expect(useQuotaStore.getState().loadedRuntimeKey).toBe("url:https://instance-b")
  })

  test("a quota still in flight for the previous instance cannot land in the new one", async () => {
    const pending = useQuotaStore.getState().fetchProviderQuota("claude")
    useQuotaStore.getState().resetForRuntimeSwitch()
    await pending

    expect(useQuotaStore.getState().results).toEqual([])
  })

  test("a transient runtime key loads nothing", async () => {
    runtimeKey = "mobile-disconnected"
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched).toHaveLength(0)
  })

  test("a failed load is not recorded as loaded, so the next ask retries it", async () => {
    quotaRequestsFail = true
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(useQuotaStore.getState().loadedRuntimeKey).toBeNull()

    quotaRequestsFail = false
    fetched.length = 0
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBeGreaterThan(0)
    expect(useQuotaStore.getState().loadedRuntimeKey).toBe("url:https://instance-a")
  })

  test("concurrent asks share one load", async () => {
    await Promise.all([
      useQuotaStore.getState().ensureLoadedForRuntime(),
      useQuotaStore.getState().ensureLoadedForRuntime(),
    ])

    expect(fetched.filter((path) => path.startsWith("/api/quota/"))).toHaveLength(1)
  })

  test("a switch drops the previous instance's display settings", async () => {
    await useQuotaStore.getState().ensureLoadedForRuntime()
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(["claude"])
    useQuotaStore.getState().setDisplayMode("remaining")

    useQuotaStore.getState().resetForRuntimeSwitch()

    // `dropdownProviderIds` decides which providers get queried, so carrying it
    // over would ask the new instance through the old one's selection.
    expect(useQuotaStore.getState().dropdownProviderIds.length).toBeGreaterThan(1)
    expect(useQuotaStore.getState().displayMode).toBe("usage")
  })
})

describe("A provider-account switch re-reads the trackers", () => {
  beforeEach(() => {
    runtimeKey = "url:https://instance-a"
    isInitialized = true
    fetched.length = 0
    quotaRequestsFail = false
    quotaFails = false
    useQuotaStore.getState().resetForRuntimeSwitch()
  })

  test("a switch to an account whose fetch fails does not keep showing the old account's usage", async () => {
    // The failure mode this guards: after a switch the numbers did not move, so
    // the credential looked unchanged. They did not move because the new
    // account's fetch failed and the old account's sample was preserved.
    await useQuotaStore.getState().ensureLoadedForRuntime()
    expect(useQuotaStore.getState().results.some((r) => r.providerId === "claude")).toBe(true)

    quotaFails = true
    await useQuotaStore.getState().fetchQuotas(["claude"], { invalidate: true })

    // The old account's sample is gone; what remains is this account's failure.
    const entry = useQuotaStore.getState().results.find((r) => r.providerId === "claude")
    expect(entry?.usage).toBeNull()
    expect(entry?.ok).toBe(false)
    expect(useQuotaStore.getState().refreshErrors.claude).toBeTruthy()
  })

  test("a periodic refresh still preserves the last sample when a fetch fails", async () => {
    // The other half of the rule: a blip must not blank a surface showing real
    // numbers for the same account.
    await useQuotaStore.getState().ensureLoadedForRuntime()
    const before = useQuotaStore.getState().results.find((r) => r.providerId === "claude")

    quotaFails = true
    await useQuotaStore.getState().fetchQuotas(["claude"])

    const after = useQuotaStore.getState().results.find((r) => r.providerId === "claude")
    expect(after?.fetchedAt).toBe(before?.fetchedAt)
    expect(useQuotaStore.getState().refreshErrors.claude).toBeTruthy()
  })

  test("a switch does not reuse a request in flight for the previous account", async () => {
    await useQuotaStore.getState().ensureLoadedForRuntime()
    fetched.length = 0

    // The stub resolves synchronously, so the in-flight request is stood in for
    // with one that has not answered yet. What matters is that the switch does
    // not hand back that request's promise.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const realFetch = runtimeFetchModule.runtimeFetch
    mock.module("@/lib/runtime-fetch", () => ({
      ...runtimeFetchModule,
      runtimeFetch: async (path: string) => {
        fetched.push(path)
        if (path === "/api/quota/claude") await gate
        return realFetch(path)
      },
    }))

    const superseded = useQuotaStore.getState().fetchProviderQuota("claude")
    const afterSwitch = useQuotaStore.getState().fetchProviderQuota("claude", true)

    release()
    expect(await superseded).toBe(false)
    expect(await afterSwitch).toBe(true)
    expect(useQuotaStore.getState().refreshErrors.claude).toBeUndefined()
    // Two requests: the switch asked again rather than waiting for the first.
    expect(fetched.filter((path) => path === "/api/quota/claude")).toHaveLength(2)
  })
})
