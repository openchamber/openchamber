import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient, type Message, type Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader, type SessionMessageTarget } from "./session-message-loader"
import { SessionCacheRetention } from "./session-cache-retention"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
const IDLE_TTL_MS = 40
// Tests of the count limit and warm switches must not race the idle grace: a
// slow CI runner can take longer than IDLE_TTL_MS to select a handful of
// sessions, and idle expiry then evicts the oldest ones legitimately. Only
// tests that exercise the idle grace opt into the short one.
const COUNT_ONLY_TTL_MS = 60 * 60 * 1000
const waitIdle = async () => { await new Promise((resolve) => setTimeout(resolve, IDLE_TTL_MS * 2)); await flush() }

function transcript(sessionID: string, turns = 8, steps = 12) {
  const records: Array<{ info: Message; parts: Part[] }> = []
  for (let turn = 0; turn < turns; turn += 1) {
    const parentID = `msg_${sessionID}_${turn}_user`
    for (let step = 0; step <= steps; step += 1) {
      const created = turn * (steps + 1) + step
      const id = step === 0 ? parentID : `msg_${sessionID}_${turn}_${step}`
      const info: Message = step === 0
        ? { id, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "test", modelID: "test" } }
        : {
          id, sessionID, role: "assistant", time: { created, completed: created + 0.5 }, parentID,
          modelID: "test", providerID: "test", mode: "build", agent: "build", path: { cwd: "/repo", root: "/repo" },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
      const part: Part = step > 0 && step < steps
        ? {
          id: `prt_${id}`, messageID: id, sessionID, type: "tool", tool: "read", callID: `call_${id}`,
          state: { status: "completed", input: {}, output: "x".repeat(1024), title: "read", metadata: {}, time: { start: created, end: created + 0.5 } },
        }
        : { id: `prt_${id}`, messageID: id, sessionID, type: "text", text: "x".repeat(1024) }
      records.push({ info, parts: [part] })
    }
  }
  return records
}

function setup(surface: "desktop" | "mobile" | "vscode" = "desktop", recordsFor = transcript, idleTtlMs = COUNT_ONLY_TTL_MS) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __OPENCHAMBER_SURFACE__: surface === "mobile" ? "mobile" : "desktop",
    __VSCODE_CONFIG__: surface === "vscode" ? {} : undefined,
  } })
  cleanups.push(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  })
  const requests: URL[] = []
  let requestsUntilFailure = 0
  let hold: Promise<void> | undefined
  const childStores = new ChildStoreManager()
  // Directory metadata persistence outlives managers; each fixture starts with
  // its own empty session list, including no revert marker from another test.
  childStores.ensureChild("/repo", { bootstrap: false }).setState({ session: [] })
  const sdk = createOpencodeClient({ baseUrl: "http://cache.test", fetch: async (request) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    requests.push(url)
    if (hold) await hold
    if (requestsUntilFailure > 0 && --requestsUntilFailure === 0) {
      return Response.json({ message: "rejected" }, { status: 400 })
    }
    const sessionID = url.pathname.split("/").at(-2) ?? ""
    const all = recordsFor(sessionID)
    const before = url.searchParams.get("before")
    // The fixture uses the upstream cursor's time boundary; IDs intentionally
    // do not sort chronologically across assistant steps.
    const boundary: { id: string; time: number } | null = before
      ? JSON.parse(Buffer.from(before, "base64url").toString()) : null
    const eligible = boundary ? all.filter(({ info }) => info.time.created < boundary.time
      || (info.time.created === boundary.time && info.id < boundary.id)) : all
    const limit = Number(url.searchParams.get("limit"))
    const page = eligible.slice(-limit)
    const oldest = page[0]?.info
    const cursor = eligible.length > page.length && oldest
      ? Buffer.from(JSON.stringify({ id: oldest.id, time: oldest.time.created })).toString("base64url") : undefined
    return Response.json(page, { headers: cursor ? { "x-next-cursor": cursor } : {} })
  } })
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "cache-test" })
  let viewed = { directory: "/repo", sessionID: "a" }
  let current = true
  const releases: SessionMessageTarget[] = []
  const active = new Set<string>()
  loader.startCacheRetention({
    idleTtlMs,
    isCurrent: () => current,
    isViewed: (target) => target.directory === viewed.directory && target.sessionID === viewed.sessionID,
    isActive: (target) => target.directory === "/repo" && active.has(target.sessionID),
    releaseDerivedCache: (target) => releases.push(target),
  })
  cleanups.push(() => { loader.dispose(); childStores.disposeAll() })
  const target = (sessionID: string, directory = "/repo") => ({ sessionID, directory })
  const select = async (sessionID: string, directory = "/repo") => {
    const previous = viewed
    viewed = target(sessionID, directory)
    loader.scheduleCacheRetention(previous.directory)
    await loader.ensure(viewed)
    await flush()
  }
  const messages = (sessionID: string, directory = "/repo") => childStores.getChild(directory)?.getState().message[sessionID]
  return {
    loader, childStores, requests, releases, select, target, messages,
    leave: () => { viewed = target(""); loader.scheduleCacheRetention("/repo") },
    changeRuntime: () => { current = false },
    failNext: () => { requestsUntilFailure = 1 },
    failBoundaryRead: () => { requestsUntilFailure = 2 },
    holdRequests: (pending: Promise<void>) => { hold = pending },
    setActive: (sessionID: string, value: boolean) => {
      if (value) active.add(sessionID)
      else active.delete(sessionID)
      loader.scheduleCacheRetention("/repo")
    },
  }
}

describe("session cache retention", () => {
  for (const surface of ["desktop", "mobile", "vscode"] as const) {
    test(`${surface}: keeps a left session whole and returns to it without a request`, async () => {
      const env = setup(surface)
      await env.select("a")
      await env.loader.loadComplete(env.target("a"))
      const original = env.messages("a") ?? []
      expect(original).toHaveLength(104)
      await env.select("b")
      expect(env.messages("a")).toBe(original)
      const calls = env.requests.length
      await env.select("a")
      expect(env.requests).toHaveLength(calls)
      expect(env.messages("a")).toBe(original)
    })

    test(`${surface}: evicts a left session after the idle grace and reloads it on return`, async () => {
      const env = setup(surface, transcript, IDLE_TTL_MS)
      await env.select("a")
      await env.loader.loadComplete(env.target("a"))
      const original = env.messages("a") ?? []
      expect(original).toHaveLength(104)
      await env.select("b")
      const calls = env.requests.length
      await waitIdle()
      expect(env.messages("a")).toBeUndefined()
      expect(env.childStores.getChild("/repo")?.getState().part[original[0].id]).toBeUndefined()
      expect(env.releases.some((target) => target.sessionID === "a")).toBe(true)
      expect(env.loader.getSnapshot(env.target("a")).resolved).toBe(false)
      await env.select("a")
      expect(env.requests.length).toBeGreaterThan(calls)
      expect(env.messages("a")?.length).toBeGreaterThan(0)
    })

    test(`${surface}: count limit evicts the least recently visited session first`, async () => {
      const env = setup(surface)
      const limit = surface === "desktop" ? 20 : 6
      for (let index = 0; index < limit; index += 1) await env.select(`s${index}`)
      expect(Object.keys(env.childStores.getChild("/repo")!.getState().message)).toHaveLength(limit)
      const calls = env.requests.length
      await env.select("s0")
      expect(env.requests).toHaveLength(calls)
      await env.select("overflow")
      expect(env.messages("s0")).toBeDefined()
      expect(env.messages("s1")).toBeUndefined()
      expect(env.loader.getSnapshot(env.target("s1")).resolved).toBe(false)
    })
  }

  test("busy and blocking background sessions outlive the idle grace until they settle", async () => {
    const env = setup("desktop", transcript, IDLE_TTL_MS)
    await env.select("a")
    const store = env.childStores.getChild("/repo")!
    store.setState({ session_status: { a: { type: "busy" } } })
    await env.select("b")
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    store.setState({ question: { a: [{ id: "q", sessionID: "a", questions: [] }] } })
    store.setState({ session_status: { a: { type: "idle" } } })
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    store.setState({ question: {} })
    await flush()
    expect(env.messages("a")).toHaveLength(104)
    await waitIdle()
    expect(env.messages("a")).toBeUndefined()
  })

  test("a session that is live in the global status store is protected while it runs", async () => {
    const env = setup("desktop", transcript, IDLE_TTL_MS)
    await env.select("a")
    env.setActive("a", true)
    await env.select("b")
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    env.setActive("a", false)
    await flush()
    expect(env.messages("a")).toHaveLength(104)
    await waitIdle()
    expect(env.messages("a")).toBeUndefined()
  })

  test("the open session is never evicted, and leaving to a draft starts the grace", async () => {
    const env = setup("desktop", transcript, IDLE_TTL_MS)
    await env.select("a")
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    env.leave()
    await flush()
    expect(env.messages("a")).toHaveLength(104)
    await waitIdle()
    expect(env.messages("a")).toBeUndefined()
  })

  test("a background history reader holds the transcript until its snapshot is consumed", async () => {
    const env = setup("desktop", transcript, IDLE_TTL_MS)
    await env.select("b")
    const release = env.loader.retainSessionHistory(env.target("a"))
    await env.loader.loadComplete(env.target("a"))
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    release()
    await waitIdle()
    expect(env.messages("a")).toBeUndefined()
  })

  test("a rendered transcript stays through a deferred switch until it leaves the screen", async () => {
    const env = setup("desktop", transcript, IDLE_TTL_MS)
    const release = env.loader.retainSessionHistory(env.target("a"), "rendered")
    await env.select("a")
    await env.select("b")
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    release()
    await waitIdle()
    expect(env.messages("a")).toBeUndefined()
  })

  test("runtime changes cancel scheduled cleanup and directories isolate equal session IDs", async () => {
    const env = setup("desktop", transcript, IDLE_TTL_MS)
    await env.select("a")
    env.leave()
    env.changeRuntime()
    await waitIdle()
    expect(env.messages("a")).toHaveLength(104)
    await env.select("a", "/other")
    expect(env.messages("a", "/other")).not.toBe(env.messages("a"))
    expect(env.messages("a")).toHaveLength(104)
  })

  test("protected sessions may overflow the limit and settle without another navigation", async () => {
    const env = setup("mobile")
    for (let index = 0; index < 8; index += 1) {
      await env.select(`s${index}`)
      const store = env.childStores.getChild("/repo")!
      store.setState({ session_status: { ...store.getState().session_status, [`s${index}`]: { type: "busy" } } })
    }
    const store = env.childStores.getChild("/repo")!
    expect(Object.keys(store.getState().message)).toHaveLength(8)
    store.setState({ session_status: { ...store.getState().session_status, s0: { type: "idle" }, s1: { type: "idle" } } })
    await flush()
    expect(Object.keys(store.getState().message)).toHaveLength(6)
    expect(env.messages("s0")).toBeUndefined()
    expect(env.messages("s7")).toBeDefined()
  })

  test("part-only streaming performs no retention passes and structural publications coalesce", async () => {
    const stores = new ChildStoreManager()
    const store = stores.ensureChild("/repo", { bootstrap: false })
    store.setState({ message: { a: transcript("a", 1).map(({ info }) => info) } })
    let evictions = 0
    const retention = new SessionCacheRetention(stores, {
      limit: 0, isCurrent: () => true, isViewed: () => false, isProtected: () => false,
      evict: () => { evictions += 1 },
    })
    cleanups.push(() => { retention.dispose(); stores.disposeAll() })
    await flush()
    expect(evictions).toBe(1)
    for (let index = 0; index < 1000; index += 1) store.setState({ part: {} })
    await flush()
    expect(evictions).toBe(1)
    for (let index = 0; index < 1000; index += 1) store.setState({ message: { ...store.getState().message } })
    await flush()
    expect(evictions).toBe(2)
  })

  test("many warm switches keep whole transcripts without repeating HTTP", async () => {
    const env = setup()
    for (let index = 0; index < 7; index += 1) {
      await env.select(`s${index}`)
      await env.loader.loadComplete(env.target(`s${index}`))
    }
    const calls = env.requests.length
    for (let index = 0; index < 70; index += 1) await env.select(`s${index % 7}`)
    expect(env.requests).toHaveLength(calls)
    for (let index = 0; index < 7; index += 1) expect(env.messages(`s${index}`)).toHaveLength(104)
  })

  test("sidebar neighbor prefetch cannot displace visited sessions or promote recency", async () => {
    const env = setup("mobile")
    for (let index = 0; index < 6; index += 1) {
      await env.select(`s${index}`)
      await Promise.all([1].map((offset) => env.loader.prefetch(env.target(`s${index + offset}`))))
      await flush()
    }
    const calls = env.requests.length
    for (let index = 0; index < 18; index += 1) {
      const selected = index % 6
      await env.select(`s${selected}`)
      await Promise.all([1].map((offset) => env.loader.prefetch(env.target(`s${selected + offset}`))))
      await flush()
    }
    expect(env.requests).toHaveLength(calls)
    for (let index = 0; index < 6; index += 1) expect(env.messages(`s${index}`)).toBeDefined()
    await env.loader.prefetch(env.target("s0"))
    await env.select("new")
    expect(env.messages("s0")).toBeUndefined()
    expect(env.messages("s5")).toBeDefined()
  })

  test("concurrent speculative loads reserve their capacity before responses arrive", async () => {
    const env = setup("mobile")
    for (let index = 0; index < 5; index += 1) await env.select(`s${index}`)
    let finish!: () => void
    env.holdRequests(new Promise<void>((resolve) => { finish = resolve }))
    const calls = env.requests.length
    const first = env.loader.prefetch(env.target("prefetched"))
    await flush()
    await env.loader.prefetch(env.target("overflow"))
    expect(env.requests).toHaveLength(calls + 1)
    finish()
    await first
    await flush()
    await env.select("next")
    expect(env.messages("prefetched")).toBeUndefined()
    expect(env.messages("s0")).toBeDefined()
  })

  for (const [surface, expected] of [["desktop", 200], ["mobile", 150]] as const) {
    test(`${surface}: cold navigation expands toward ten turns and publishes once`, async () => {
      const env = setup(surface, (id) => transcript(id, 20, 12))
      const store = env.childStores.ensureChild("/repo", { bootstrap: false })
      const publications: number[] = []
      cleanups.push(store.subscribe((state, previous) => {
        if (state.message.a !== previous.message.a) publications.push(state.message.a?.length ?? 0)
      }))
      await env.select("a")
      expect(publications).toEqual([expected])
      expect(env.loader.getSnapshot(env.target("a")).complete).toBe(false)
    })
  }

  test("a short session loads completely without expansion past its end", async () => {
    const env = setup("desktop", (id) => transcript(id, 2, 30))
    await env.select("a")
    expect(env.messages("a")).toHaveLength(62)
    expect(env.loader.getSnapshot(env.target("a")).complete).toBe(true)
  })

  test("overlapping history demands share one history batch", async () => {
    const env = setup("desktop", (id) => transcript(id, 30, 9))
    await env.select("a")
    const calls = env.requests.length
    let finish!: () => void
    env.holdRequests(new Promise<void>((resolve) => { finish = resolve }))
    const first = env.loader.loadOlder(env.target("a"))
    const second = env.loader.loadOlder(env.target("a"))
    const third = env.loader.loadOlder(env.target("a"))
    finish()
    await Promise.all([first, second, third])
    expect(env.requests).toHaveLength(calls + 1)
    expect(env.messages("a")).toHaveLength(200)
  })

  test("history reads whole pages until the batch starts on a user prompt, keeping every record", async () => {
    const full = transcript("a", 30, 12).map(({ info }) => info.id)
    const env = setup("desktop", (id) => transcript(id, 30, 12))
    await env.select("a")
    const before = env.requests.length
    await env.loader.loadOlder(env.target("a"))
    const limits = env.requests.slice(before).map((url) => url.searchParams.get("limit"))
    expect(limits.length).toBeGreaterThanOrEqual(2)
    expect(limits.every((limit) => limit === "100")).toBe(true)
    const ids = env.messages("a")?.map((message) => message.id) ?? []
    expect(env.messages("a")?.[0].role).toBe("user")
    expect(ids).toEqual(full.slice(full.length - ids.length))
    while (!env.loader.getSnapshot(env.target("a")).complete) await env.loader.loadOlder(env.target("a"))
    expect(env.messages("a")?.map((message) => message.id)).toEqual(full)
  })

  test("an already aligned page needs no extra request", async () => {
    const env = setup("desktop", (id) => transcript(id, 30, 9))
    await env.select("a")
    const before = env.requests.length
    await env.loader.loadOlder(env.target("a"))
    expect(env.requests).toHaveLength(before + 1)
    expect(env.messages("a")).toHaveLength(200)
    expect(env.messages("a")?.[0].role).toBe("user")
  })

  test("alignment reads are bounded for a very long turn", async () => {
    const env = setup("desktop", (id) => transcript(id, 10, 149))
    await env.select("a")
    const initial = env.messages("a")?.length ?? 0
    const before = env.requests.length
    await env.loader.loadOlder(env.target("a"))
    expect(env.requests).toHaveLength(before + 3)
    expect(env.messages("a")).toHaveLength(initial + 300)
    expect(env.loader.getSnapshot(env.target("a")).complete).toBe(false)
  })

  test("a failed page preserves the previous history and its retry cursor", async () => {
    const env = setup("desktop", (id) => transcript(id, 30, 12))
    await env.select("a")
    const previous = env.messages("a")
    const cursor = env.loader.getSnapshot(env.target("a")).cursor
    env.failNext()
    await env.loader.loadOlder(env.target("a"))
    expect(env.messages("a")).toBe(previous)
    expect(env.loader.getSnapshot(env.target("a"))).toMatchObject({ status: "error", cursor })
    env.failBoundaryRead()
    await env.loader.loadOlder(env.target("a"))
    expect(env.messages("a")).toBe(previous)
    expect(env.loader.getSnapshot(env.target("a"))).toMatchObject({ status: "error", cursor })
    await env.loader.loadOlder(env.target("a"))
    expect(env.messages("a")?.length).toBeGreaterThan(previous?.length ?? 0)
  })
})

describe("evicted history after background events", () => {
  test("a background message on an evicted session reloads history on the next visit", async () => {
    const env = setup("mobile")
    for (const id of ["s0", "s1", "s2", "s3", "s4", "s5", "overflow"]) await env.select(id)
    expect(env.messages("s0")).toBeUndefined()
    // A background turn lands for the evicted session through the event
    // reducer: one message with its part, never the earlier history.
    const store = env.childStores.getChild("/repo")!
    const late: Message = {
      id: "msg_s0_late", sessionID: "s0", role: "user", time: { created: 10_000 },
      agent: "build", model: { providerID: "test", modelID: "test" },
    }
    store.setState({
      message: { ...store.getState().message, s0: [late] },
      part: { ...store.getState().part, [late.id]: [{ id: "prt_late", messageID: late.id, sessionID: "s0", type: "text", text: "late" }] },
    })
    await flush()
    const calls = env.requests.length
    await env.select("s0")
    expect(env.requests.length).toBeGreaterThan(calls)
    const ids = env.messages("s0")?.map((message) => message.id) ?? []
    expect(ids.at(-1)).toBe("msg_s0_late")
    expect(ids.length).toBeGreaterThan(1)
    expect(env.loader.getSnapshot(env.target("s0"))).toMatchObject({ status: "ready", resolved: true, complete: true })
  })
})
