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
})
