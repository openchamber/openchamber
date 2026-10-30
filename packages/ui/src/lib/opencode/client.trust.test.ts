import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createRuntimeOpencodeClient } from "./client"
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../runtime-url"
import { getOpenCodeTrustSnapshot, settleOpenCodeTrust, subscribeOpenCodeTrust } from "../opencodeTrust"

const previous = getRuntimeUrlResolver()
beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: "https://trust.test" })
})
afterEach(() => {
  setRuntimeUrlResolver(previous)
})

const refusal = (directory: string) => Response.json(
  { error: "paused", code: "opencode_trust_required", directory },
  { status: 403 },
)

const assessment = (directory: string, trusted: boolean) => Response.json({
  directory,
  trusted,
  fingerprint: "fp-1",
  items: [{ kind: "plugin", source: ".opencode/plugins/probe.js", name: "", detail: "" }],
})

const nextPrompt = () => new Promise<NonNullable<ReturnType<typeof getOpenCodeTrustSnapshot>>>((resolve) => {
  const current = getOpenCodeTrustSnapshot()
  if (current) return resolve(current)
  const unsubscribe = subscribeOpenCodeTrust(() => {
    const request = getOpenCodeTrustSnapshot()
    if (!request) return
    unsubscribe()
    resolve(request)
  })
})

describe("OpenCode folder trust in the client", () => {
  test("asks once for a refused folder, saves the answer and sends the request again", async () => {
    const directory = "/repo/trusted"
    let trusted = false
    const calls: string[] = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init)
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/opencode/trust") {
        if (request.method === "POST") {
          expect(await request.json()).toEqual({ directory, fingerprint: "fp-1" })
          trusted = true
          return assessment(directory, true)
        }
        return assessment(directory, trusted)
      }
      return trusted ? Response.json({ data: [{ id: "build" }] }) : refusal(directory)
    })
    try {
      const client = createRuntimeOpencodeClient({ baseUrl: "https://trust.test/api", directory })
      const pending = client.agent.list()
      const prompt = await nextPrompt()
      expect(prompt.directory).toBe(directory)
      expect(prompt.items.map((item) => item.source)).toEqual([".opencode/plugins/probe.js"])

      expect(await settleOpenCodeTrust("trust")).toBe("saved")
      expect(getOpenCodeTrustSnapshot()).toBeNull()
      await pending
      expect(calls).toEqual([
        "GET /api/agent",
        "GET /api/opencode/trust",
        "GET /api/opencode/trust",
        "POST /api/opencode/trust",
        "GET /api/agent",
      ])
    } finally {
      fetch.mockRestore()
    }
  })

  test("a declined folder stays closed for background reads and asks again for a new session", async () => {
    const directory = "/repo/declined"
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === "/api/opencode/trust") return assessment(directory, false)
      return refusal(directory)
    })
    try {
      const client = createRuntimeOpencodeClient({ baseUrl: "https://trust.test/api", directory })
      const first = client.agent.list().catch(() => "refused")
      await nextPrompt()
      expect(await settleOpenCodeTrust("skip")).toBe("skipped")
      expect(await first).toBe("refused")

      // A background read after "Not this time" does not bring the prompt back.
      expect(await client.agent.list().catch(() => "refused")).toBe("refused")
      expect(getOpenCodeTrustSnapshot()).toBeNull()

      // Creating a session is the user asking for the folder: ask again.
      const create = client.session.create({ location: { directory } }).catch(() => "refused")
      await nextPrompt()
      await settleOpenCodeTrust("skip")
      expect(await create).toBe("refused")
    } finally {
      fetch.mockRestore()
    }
  })

  test("asks once when identical worktrees wait for the same repository trust", async () => {
    const directories = Array.from({ length: 6 }, (_, index) => `/repo/worktree-${index + 1}`)
    const assessed = new Set<string>()
    const prompts: string[] = []
    let trusted = false
    let savedAnswers = 0
    let answerFollowingPrompts = false
    let markAssessed: () => void
    const allAssessed = new Promise<void>((resolve) => { markAssessed = resolve })
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init)
      const url = new URL(request.url)
      const directory = decodeURIComponent(request.headers.get("x-opencode-directory") ?? "")
      if (url.pathname === "/api/opencode/trust") {
        if (request.method === "POST") {
          savedAnswers += 1
          trusted = true
          return assessment((await request.json()).directory, true)
        }
        const assessedDirectory = url.searchParams.get("directory") ?? ""
        assessed.add(assessedDirectory)
        if (assessed.size === directories.length) markAssessed()
        return assessment(assessedDirectory, trusted)
      }
      return trusted ? Response.json({ data: [{ id: "build" }] }) : refusal(directory)
    })
    const unsubscribe = subscribeOpenCodeTrust(() => {
      const prompt = getOpenCodeTrustSnapshot()
      if (!prompt) return
      prompts.push(prompt.directory)
      if (answerFollowingPrompts) void settleOpenCodeTrust("trust")
    })
    try {
      const pending = directories.map((directory) => createRuntimeOpencodeClient({
        baseUrl: "https://trust.test/api", directory,
      }).agent.list())
      await allAssessed
      await nextPrompt()
      // Finish every unexpected duplicate too, so the regression fails on the
      // observed prompt count instead of leaving requests waiting for a timer.
      answerFollowingPrompts = true
      expect(await settleOpenCodeTrust("trust")).toBe("saved")
      expect(await Promise.all(pending)).toHaveLength(directories.length)
      expect(prompts).toHaveLength(1)
      expect(savedAnswers).toBe(1)
    } finally {
      unsubscribe()
      fetch.mockRestore()
    }
  })
})
