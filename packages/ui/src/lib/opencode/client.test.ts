import { beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"
import { isAmbiguousSendFailure } from '@/sync/send-failure-classification'

// The generated `@opencode/client` runs for real here; only the runtime
// transport (`runtimeFetch`) and runtime identity are replaced. That keeps
// request fidelity (paths, query, headers, bodies) under test rather than
// whatever a hand-written SDK stub would accept.

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type CapturedRequest = {
  url: URL
  method: string
  headers: Headers
  body: unknown
}

const requests: CapturedRequest[] = []
const responses: Array<Response | Error | ((request: CapturedRequest) => Response | Error)> = []
let runtimeKey = "test-runtime"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const noContent = () => new Response(null, { status: 204 })

const runtimeFetchMock = mock<RuntimeFetch>(async (input, init) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url, "http://runtime.test")
  const request: CapturedRequest = {
    url,
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }
  requests.push(request)
  const next = responses.shift()
  const resolved = typeof next === "function" ? next(request) : next
  if (resolved instanceof Error) throw resolved
  if (resolved === HANG) return hangUntilAborted(init?.signal ?? undefined)
  return resolved ?? json({})
})

/** Sentinel response: the transport never answers, only an abort ends the wait. */
const HANG = new Response(null, { status: 599 })
const hangUntilAborted = (signal: AbortSignal | undefined) =>
  new Promise<Response>((_, reject) => {
    if (!signal) return
    // A real pending request keeps the event loop alive. AbortSignal.timeout does
    // not, and Bun on Windows then never fires it, so hold the loop until abort.
    const pending = setInterval(() => undefined, 1_000)
    const abort = () => {
      clearInterval(pending)
      reject(new DOMException("Aborted", "AbortError"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })

;(mock as unknown as { restore?: () => void }).restore?.()

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}))

mock.module("@/lib/runtime-url", () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: () => "http://runtime.test/api",
  })),
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: mock(() => ""),
  getRuntimeKey: mock(() => runtimeKey),
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: runtimeFetchMock,
}))

mock.module("@/lib/startupTrace", () => ({
  markStartupTrace: mock(() => undefined),
}))

const { OpencodeApiError, createRuntimeOpencodeClient, opencodeClient } = await import(`./client?client-test=${Date.now()}`)
const { readProjectConfigError } = await import("./configError")

const sessionInfo = {
  id: "ses_1",
  projectID: "proj_1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "First",
  location: { directory: "/repo/app" },
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  runtimeKey = "test-runtime"
  opencodeClient.setDirectory(undefined)
  opencodeClient.clearConfigCache()
})

describe('runtime routing responses', () => {
  const routingFailureSchema = z.object({ message: z.string(), status: z.number() })
  const html = () => new Response('<!doctype html><title>OpenChamber</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const rejectedMessage = async (params: Parameters<typeof opencodeClient.sendMessage>[0]) => {
    try {
      await opencodeClient.sendMessage(params)
    } catch (error) {
      return { error, data: routingFailureSchema.parse(error) }
    }
    throw new Error('Expected the prompt to be rejected')
  }

  test('rejects an HTML prompt acknowledgement as a definite failure', async () => {
    responses.push(html())
    const error = await rejectedMessage({ id: 'ses_1', providerID: 'routing-html', text: 'hello' })
    expect(error.error).toBeInstanceOf(OpencodeApiError)
    expect(error.data.message).toContain('returned a web page instead of an API response')
    expect(error.data.status).toBe(200)
    expect(isAmbiguousSendFailure(error.error)).toBe(false)
  })

  test('rejects an HTML slash-command acknowledgement', async () => {
    responses.push(html())
    await expect(opencodeClient.sendCommand({ id: 'ses_1', command: 'review' })).rejects.toThrow('returned a web page instead of an API response')
  })

  test('does not cache an HTML configuration response', async () => {
    responses.push(html())
    await expect(opencodeClient.getConfig('/repo/html')).rejects.toThrow('returned a web page instead of an API response')
    responses.push(json([]))
    expect(await opencodeClient.getConfig('/repo/html')).toEqual({})
    expect(requests).toHaveLength(2)
  })

  test('a packaged routing 503 is definite and never trips the provider circuit', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(new Response('{"error":{"code":"runtime_unavailable"}}', {
        status: 503, headers: { 'content-type': 'application/json', 'x-openchamber-error': 'runtime-unavailable' },
      }))
      const error = await rejectedMessage({ id: 'ses_1', providerID: 'routing-unavailable', text: 'hello' })
      expect(error.data.message).toContain('runtime_unavailable')
      expect(error.data.status).toBe(503)
      expect(isAmbiguousSendFailure(error.error)).toBe(false)
    }
    responses.push(json({ data: { id: 'msg_accepted' } }))
    expect(await opencodeClient.sendMessage({ id: 'ses_1', providerID: 'routing-unavailable', text: 'hello', messageId: 'msg_accepted' })).toBe('msg_accepted')
    expect(requests).toHaveLength(7)
  })
})

describe("request fidelity", () => {
  test("project creation uses the OpenChamber directory route", async () => {
    responses.push(json({ success: true, restarted: false, path: "/repo/new" }))
    expect(await opencodeClient.createDirectory("/repo/new", { asProject: true }))
      .toEqual({ success: true, path: "/repo/new" })
    expect(requests[0].url.pathname).toBe("/api/openchamber/directory")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ path: "/repo/new", create: true })
  })

  test("project activation uses the OpenChamber directory route without creation", async () => {
    const result = { success: true, restarted: false, path: "/repo/existing" }
    responses.push(json(result))
    expect(await opencodeClient.setOpenCodeWorkingDirectory("/repo/existing")).toEqual(result)
    expect(requests[0].url.pathname).toBe("/api/openchamber/directory")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ path: "/repo/existing" })
  })

  test("a directory-scoped call carries the encoded directory header and lists that directory", async () => {
    responses.push(json({ data: [sessionInfo], cursor: { next: "c2" } }))
    const page = await opencodeClient.listSessionsPage({ directory: "/repo/app dir" })
    const request = requests[0]
    expect(request.url.origin + request.url.pathname).toBe("http://runtime.test/api/session")
    expect(request.url.searchParams.get("directory")).toBe("/repo/app dir")
    expect(request.url.searchParams.get("limit")).toBe("100")
    expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo/app dir"))
    expect(page.sessions[0]).toMatchObject({ id: "ses_1", directory: "/repo/app", title: "First" })
    expect(page.cursor).toEqual({ next: "c2" })
  })

  test("releasing a location names its directory, never OpenCode's own", async () => {
    opencodeClient.setDirectory("/repo/current")
    responses.push(noContent())
    await opencodeClient.releaseLocation("/chats/2026-10-03/session-a b")
    expect(requests[0].url.pathname).toBe("/api/debug/location")
    expect(requests[0].method).toBe("DELETE")
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/chats/2026-10-03/session-a b"))

    await expect(opencodeClient.releaseLocation("")).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  test("a global list sends no directory scope at all", async () => {
    opencodeClient.setDirectory("/repo/app")
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.listSessionsPage({ global: true })
    expect(requests[0].url.searchParams.has("directory")).toBe(false)
    expect(requests[0].headers.has("x-opencode-directory")).toBe(false)
  })

  test("the active-session snapshot is the host's, except for a directory inside an isolated space", async () => {
    responses.push(json({ data: { ses_host: { type: "running" } } }))
    await opencodeClient.getActiveSessionStatuses("/repo/app")
    expect(requests[0].url.pathname).toBe("/api/session/active")
    expect(requests[0].headers.has("x-opencode-directory")).toBe(false)
    responses.push(json({ data: { ses_space: { type: "running" } } }))
    const statuses = await opencodeClient.getActiveSessionStatuses("/spaces/a1b2c3d4e5f6/app")
    // The space's directory travels on the request; `runtimeFetch` turns it into the space's prefix.
    expect(requests[1].url.pathname).toBe("/api/session/active")
    expect(requests[1].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/spaces/a1b2c3d4e5f6/app"))
    expect(statuses).toEqual({ ses_space: { type: "busy" } })
  })

  test("a global page carries the isolated-space marks the host merged in, a directory page never does", async () => {
    const spaces = [{ id: "a1b2c3d4e5f6", name: "One", state: "stale", sessions: 1, projectDirectory: "/repo/app", directory: "/spaces/a1b2c3d4e5f6/app" }]
    responses.push(json({ data: [], cursor: {}, spaces }))
    const page = await opencodeClient.listSessionsPage({ global: true })
    expect(page.spaces).toEqual([{ id: "a1b2c3d4e5f6", name: "One", state: "stale", projectDirectory: "/repo/app", directory: "/spaces/a1b2c3d4e5f6/app" }])
    responses.push(json({ data: [], cursor: {}, spaces }))
    expect((await opencodeClient.listSessionsPage({ directory: "/repo/app" })).spaces).toBeUndefined()
    // A mark the client cannot read is no mark, not a broken list.
    responses.push(json({ data: [], cursor: {}, spaces: [{ id: "bad" }] }))
    expect((await opencodeClient.listSessionsPage({ global: true })).spaces).toBeUndefined()
  })
test('Windows drive roots remain absolute in directory selection and SDK client identity', () => {
  const previous = opencodeClient.getDirectory();
  try {
    opencodeClient.setDirectory('c:\\');
    expect(opencodeClient.getDirectory()).toBe('C:/');
    expect(opencodeClient.getScopedSdkClient('c:\\')).toBe(opencodeClient.getScopedSdkClient('C:/'));
    expect(opencodeClient.getScopedSdkClient('C:/')).not.toBe(opencodeClient.getScopedSdkClient('C:'));
  } finally {
    opencodeClient.setDirectory(previous);
  }
});

test('Windows separators and UNC representations share SDK clients without lowercasing directory names', () => {
  expect(opencodeClient.getScopedSdkClient('c:\\Users\\Developer\\Project\\'))
    .toBe(opencodeClient.getScopedSdkClient('C:/Users/Developer/Project'));
  expect(opencodeClient.getScopedSdkClient('\\\\Server\\Share\\Project\\'))
    .toBe(opencodeClient.getScopedSdkClient('//Server/Share/Project'));
  expect(opencodeClient.getScopedSdkClient('/repo/Project'))
    .not.toBe(opencodeClient.getScopedSdkClient('/repo/project'));
});

test('a drive-root system-info fallback stays absolute', async () => {
  responses.push(json({ directory: 'C:/', project: { id: 'project', directory: 'C:/', canonical: 'C:/' } }));
  expect((await opencodeClient.getSystemInfo()).homeDirectory).toBe('C:/');
});

  test("the current directory scopes calls that pass none", async () => {
    opencodeClient.setDirectory("/repo/current")
    responses.push(json({ location: {}, data: [] }))
    await opencodeClient.listAgents()
    expect(requests[0].url.pathname).toBe("/api/agent")
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo/current"))
  })
})

describe("error normalisation", () => {
  test("an invalid project config keeps its path and message reachable", async () => {
    const body = {
      name: "ConfigInvalidError",
      data: { path: "/repo/bad/opencode.json", message: "bad file reference: {file:./.secrets/token} does not exist" },
    }
    responses.push(json(body, 400))
    const error = await opencodeClient.listAgents("/repo/bad").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(readProjectConfigError(error)).toEqual({
      name: "ConfigInvalidError",
      path: "/repo/bad/opencode.json",
      message: "bad file reference: {file:./.secrets/token} does not exist",
    })
  })

  test("a tagged error body gets its HTTP status restored", async () => {
    responses.push(json({ _tag: "SessionNotFoundError", sessionID: "ses_x", message: "no such session" }, 404))
    const error = await opencodeClient.getSession("ses_x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({ status: 404, tag: "SessionNotFoundError", operation: "session.get" })
  })

  // Only routes that declare a 500 body deliver it: the generated client
  // cancels an undeclared status' body and reports the status alone.
  test("a declared 500 body keeps the log ref OpenCode printed next to its stack", async () => {
    responses.push(json({ _tag: "UnknownError", message: "Unexpected server error. Check server logs for details.", ref: "err_07817ddc" }, 500))
    const error = await opencodeClient.getSessionMessages("ses_x", { limit: 10 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({
      status: 500,
      tag: "UnknownError",
      ref: "err_07817ddc",
      detail: "Unexpected server error. Check server logs for details.",
    })
  })

  test("an undeclared 500 arrives without its body, so no ref can be quoted", async () => {
    responses.push(json({ _tag: "UnknownError", message: "boom", ref: "err_07817ddc" }, 500))
    const error = await opencodeClient.renameSession("ses_x", "Title").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({ status: 500, operation: "session.update", ref: undefined })
  })

  test("an undeclared status is reported with that status", async () => {
    responses.push(new Response("boom", { status: 500 }))
    const error = await opencodeClient.getSession("ses_x").catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 500, operation: "session.get" })
  })

  test("a transport failure has no status", async () => {
    responses.push(new TypeError("Failed to fetch"))
    const error = await opencodeClient.getSession("ses_x").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect((error as { status?: number }).status).toBeUndefined()
  })

  test("fetchPermission maps 404 to resolved and everything else to unknown", async () => {
    responses.push(json({ _tag: "PermissionNotFoundError", message: "gone" }, 404))
    expect(await opencodeClient.fetchPermission("ses_1", "per_1")).toEqual({ state: "resolved" })
    responses.push(new Response("", { status: 502 }))
    expect(await opencodeClient.fetchPermission("ses_1", "per_1")).toEqual({ state: "unknown" })
    responses.push(json({ data: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] } }))
    expect(await opencodeClient.fetchPermission("ses_1", "per_1")).toMatchObject({
      state: "ok",
      permission: { id: "per_1", action: "bash" },
    })
    expect(requests[0].url.pathname).toBe("/api/session/ses_1/permission/per_1")
  })
})

describe("sendMessage", () => {
  test("switches model and agent, admits context as synthetic messages, then prompts", async () => {
    responses.push(noContent(), noContent(), json({ id: "syn_1" }), json({ id: "msg_1" }))
    const id = await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      model: { id: "gpt-5.6-luna", providerID: "openai" },
      agent: "build",
      text: "hello",
      messageId: "msg_1",
      context: [{ text: "selected code", metadata: { openchamberContext: { kind: "file-quote" } } as never }],
      agentMentions: [{ name: "explore", source: { value: "@explore", start: 0, end: 8 } }],
      directory: "/repo/app",
    })
    expect(id).toBe("msg_1")
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/session/ses_1/model",
      "POST /api/session/ses_1/agent",
      "POST /api/session/ses_1/synthetic",
      "POST /api/session/ses_1/prompt",
    ])
    expect(requests[0].body).toEqual({ model: { id: "gpt-5.6-luna", providerID: "openai" } })
    expect(requests[2].body).toMatchObject({ text: "selected code", resume: false, metadata: { openchamberContext: { kind: "file-quote" } } })
    expect(requests[3].body).toEqual({
      id: "msg_1",
      text: "hello",
      agents: [{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }],
    })
    expect(requests.every((r) => r.headers.get("x-opencode-directory") === encodeURIComponent("/repo/app"))).toBe(true)
  })

  test("context ids travel with the synthetic messages and sort below the prompt id", async () => {
    responses.push(json({ id: "a" }), json({ id: "b" }), json({ id: "c" }))
    const id = await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "",
      context: [{ id: "msg_given", text: "first" }, { text: "second" }],
    })
    const [first, second] = requests.slice(0, 2).map((request) => request.body)
    expect(first).toMatchObject({ id: "msg_given", text: "first" })
    expect(second).toMatchObject({ text: "second" })
    const mintedID = z.object({ id: z.string().startsWith("msg_") }).parse(second).id
    expect(mintedID < id).toBe(true)
  })

  test("without a selection change only the prompt is sent, with files as URIs", async () => {
    responses.push(json({ id: "msg_2" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "look",
      messageId: "msg_2",
      files: [{ type: "file", mime: "text/markdown", filename: "notes.md", url: "data:text/markdown;base64,QQ==" }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({
      id: "msg_2",
      text: "look",
      files: [{ uri: "data:text/plain;base64,QQ==", name: "notes.md" }],
    })
  })

  test("refuses to send when the runtime changed underneath the caller", async () => {
    await expect(
      opencodeClient.sendMessage({ runtimeKey: "other", id: "ses_1", providerID: "openai", text: "x" }),
    ).rejects.toThrow("runtime changed")
    expect(requests).toHaveLength(0)
  })

  // A runtime switch while the model switch is in flight: the agent switch,
  // context and prompt must not go to the new server.
  test("stops between the model and agent switch when the runtime changes mid-send", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendMessage({
        runtimeKey: "test-runtime",
        id: "ses_1",
        providerID: "openai",
        model: { id: "m", providerID: "openai" },
        agent: "build",
        text: "hello",
        context: [{ text: "ctx" }],
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/model"])
  })

  test("stops before the prompt when the runtime changes after the agent switch", async () => {
    responses.push(noContent(), () => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendMessage({
        runtimeKey: "test-runtime",
        id: "ses_1",
        providerID: "openai",
        model: { id: "m", providerID: "openai" },
        agent: "build",
        text: "hello",
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/model", "/api/session/ses_1/agent"])
  })

  test("stops between context messages when the runtime changes", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return json({ id: "syn_1" })
    })
    await expect(
      opencodeClient.sendMessage({
        runtimeKey: "test-runtime",
        id: "ses_1",
        providerID: "openai",
        text: "hello",
        context: [{ text: "one" }, { text: "two" }],
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/synthetic"])
  })
})

describe("sendMessage with inline skills", () => {
  const skillInfo = (id: string, name = id) => ({ id, name, path: `/skills/${id}/SKILL.md`, content: "body" })
  const instructionFor = (names: readonly string[]) => (names.length ? `use: ${names.join(",")}` : null)

  test("attaches known skills to the prompt by id, without an instruction", async () => {
    responses.push(json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy"), skillInfo("code-audit", "audit")] }), json({ id: "msg_1" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "/audit then /deploy",
      messageId: "msg_1",
      delivery: "steer",
      directory: "/repo/app",
      skills: { names: ["audit", "deploy"], instructionFor },
    })
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["GET /api/skill", "POST /api/session/ses_1/prompt"])
    expect(requests[1].body).toEqual({
      id: "msg_1",
      text: "/audit then /deploy",
      skills: [{ id: "code-audit" }, { id: "deploy" }],
      delivery: "steer",
    })
  })

  test("names OpenCode does not list fall back to an instruction admitted before the prompt", async () => {
    responses.push(json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy")] }), json({ id: "syn_1" }), json({ id: "msg_1" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "x",
      messageId: "msg_1",
      skills: { names: ["deploy", "ghost"], instructionFor },
    })
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/skill", "/api/session/ses_1/synthetic", "/api/session/ses_1/prompt"])
    expect(requests[1].body).toMatchObject({ text: "use: ghost", resume: false })
    expect(requests[2].body).toMatchObject({ skills: [{ id: "deploy" }] })
  })

  test("a failed skill list still sends, naming every skill in the instruction", async () => {
    responses.push(json({ _tag: "UnknownError", message: "boom" }, 500), json({ id: "syn_1" }), json({ id: "msg_1" }))
    await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "x",
      messageId: "msg_1",
      skills: { names: ["deploy"], instructionFor },
    })
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/skill", "/api/session/ses_1/synthetic", "/api/session/ses_1/prompt"])
    expect(requests[1].body).toMatchObject({ text: "use: deploy" })
    const promptBody = requests[2].body
    expect(typeof promptBody === "object" && promptBody !== null && "skills" in promptBody).toBe(false)
  })

  test("a skill removed before the prompt resends the same message with the instruction", async () => {
    responses.push(
      json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy")] }),
      json({ _tag: "InvalidRequestError", message: "Skill not found: deploy", field: "skills" }, 400),
      json({ id: "syn_1" }),
      json({ id: "msg_1" }),
    )
    const id = await opencodeClient.sendMessage({
      id: "ses_1",
      providerID: "openai",
      text: "x",
      messageId: "msg_1",
      skills: { names: ["deploy"], instructionFor },
    })
    expect(id).toBe("msg_1")
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/api/skill",
      "/api/session/ses_1/prompt",
      "/api/session/ses_1/synthetic",
      "/api/session/ses_1/prompt",
    ])
    expect(requests[1].body).toMatchObject({ id: "msg_1", skills: [{ id: "deploy" }] })
    expect(requests[2].body).toMatchObject({ text: "use: deploy" })
    expect(requests[3].body).toEqual({ id: "msg_1", text: "x" })
  })

  test("other prompt rejections are not retried", async () => {
    responses.push(json({ location: { directory: "/repo/app" }, data: [skillInfo("deploy")] }), json({ _tag: "InvalidRequestError", message: "Attachment too big", field: "files" }, 400))
    await expect(
      opencodeClient.sendMessage({ id: "ses_1", providerID: "openai", text: "x", skills: { names: ["deploy"], instructionFor } }),
    ).rejects.toThrow()
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/skill", "/api/session/ses_1/prompt"])
  })
})

describe("sendCommand", () => {
  test("switches model and agent, then runs the command", async () => {
    responses.push(noContent(), noContent(), noContent())
    await opencodeClient.sendCommand({
      runtimeKey: "test-runtime",
      id: "ses_1",
      model: { id: "m", providerID: "openai" },
      agent: "build",
      command: "review",
      arguments: "src",
    })
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/api/session/ses_1/model",
      "/api/session/ses_1/agent",
      "/api/session/ses_1/command",
    ])
    expect(requests[2].body).toMatchObject({ name: "review", text: "src" })
  })

  test("stops after the model switch when the runtime changes mid-command", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendCommand({
        runtimeKey: "test-runtime",
        id: "ses_1",
        model: { id: "m", providerID: "openai" },
        agent: "build",
        command: "review",
      }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/model"])
  })

  test("stops before the command when the runtime changes after the agent switch", async () => {
    responses.push(() => {
      runtimeKey = "other"
      return noContent()
    })
    await expect(
      opencodeClient.sendCommand({ runtimeKey: "test-runtime", id: "ses_1", agent: "build", command: "review" }),
    ).rejects.toThrow("runtime changed")
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/session/ses_1/agent"])
  })
})

describe("messages and config", () => {
  test("getSessionMessages projects a page into domain messages and parts", async () => {
    responses.push(
      json({
        data: [
          { id: "msg_u", type: "user", time: { created: 1 }, text: "hi" },
          {
            id: "msg_a",
            type: "assistant",
            time: { created: 2, completed: 3 },
            agent: "build",
            model: { id: "m", providerID: "p" },
            content: [{ type: "text", text: "hello" }],
          },
        ],
        cursor: { previous: "p1" },
      }),
    )
    const page = await opencodeClient.getSessionMessages("ses_1", { limit: 20, order: "asc" })
    expect(requests[0].url.pathname).toBe("/api/session/ses_1/message")
    expect(requests[0].url.searchParams.get("limit")).toBe("20")
    expect(requests[0].url.searchParams.get("order")).toBe("asc")
    expect(page.items.map((item: { info: { role: string } }) => item.info.role)).toEqual(["user", "assistant"])
    expect(page.items[0].parts[0]).toMatchObject({ type: "text", text: "hi", id: "msg_u:text:0" })
    expect(page.items[1].parts[0]).toMatchObject({ type: "text", text: "hello", id: "msg_a:text:0" })
    expect(page.cursor).toEqual({ previous: "p1" })
  })

  test("a page shorter than the limit drops the next cursor the server still attaches", async () => {
    responses.push(json({
      data: [{ id: "msg_only", type: "user", time: { created: 1 }, text: "hi" }],
      cursor: { previous: "p1", next: "n1" },
    }))
    const short = await opencodeClient.getSessionMessages("ses_1", { limit: 20 })
    expect(short.cursor).toEqual({ previous: "p1" })

    responses.push(json({
      data: [{ id: "msg_only", type: "user", time: { created: 1 }, text: "hi" }],
      cursor: { previous: "p1", next: "n1" },
    }))
    const full = await opencodeClient.getSessionMessages("ses_1", { limit: 1 })
    expect(full.cursor).toEqual({ previous: "p1", next: "n1" })
  })

  test("a cursor is never combined with an order", async () => {
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.getSessionMessages("ses_1", { cursor: "abc", order: "asc" })
    expect(requests[0].url.searchParams.get("cursor")).toBe("abc")
    expect(requests[0].url.searchParams.has("order")).toBe(false)
  })

  test("getConfig folds documents and serves the fold from cache", async () => {
    responses.push(
      json([
        { type: "document", path: "/g.json", info: { model: "a", agents: { build: {} } } },
        { type: "document", path: "/p.json", info: { model: "b" } },
      ]),
    )
    const first = await opencodeClient.getConfig("/repo/app")
    const second = await opencodeClient.getConfig("/repo/app")
    expect(first).toEqual({ model: "b", agents: { build: {} } })
    expect(second).toBe(first)
    expect(requests).toHaveLength(1)
  })

  test("getProvidersForConfig gathers providers, models, and the default", async () => {
    responses.push(
      (request) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
            : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } }),
      (request) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
            : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } }),
      (request) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
            : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } }),
    )
    const catalog = await opencodeClient.getProvidersForConfig("/repo/app")
    expect(catalog.providers).toEqual([{ id: "openai", name: "OpenAI" }])
    expect(catalog.models).toHaveLength(1)
    expect(catalog.default).toEqual({ id: "x", providerID: "openai" })
  })

  for (const { label, variants } of [
    { label: "missing", variants: undefined },
    { label: "null", variants: null },
    { label: "keyed object", variants: { default: {} } },
  ]) {
    test(`a live model catalog with ${label} variants can be read by the chat renderer`, async () => {
      const model = { id: "opencode-go/glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "opencode-go", variants }
      const answer = (request: CapturedRequest) =>
        request.url.pathname === "/api/provider"
          ? json({ location: {}, data: [{ id: "opencode-go", name: "OpenCode Go" }] })
          : request.url.pathname === "/api/model"
            ? json({ location: {}, data: [model] })
            : json({ location: {}, data: model })
      responses.push(answer, answer, answer)

      const catalog = await opencodeClient.getProvidersForConfig("/repo/app")
      expect(catalog.models[0]?.variants.map((variant: { id: string }) => variant.id) ?? []).toEqual([])
      expect(catalog.models[0]).toEqual({ ...model, variants: [] })
    })
  }

  test("a live model catalog keeps variant ids and settings from valid arrays", async () => {
    const variants = [{ id: "high", settings: { reasoningEffort: "high" } }, { id: "low", settings: {} }]
    const model = { id: "opencode-go/glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "opencode-go", variants }
    responses.push(
      json({ location: {}, data: [] }),
      json({ location: {}, data: [model] }),
      json({ location: {}, data: model }),
    )

    const catalog = await opencodeClient.getProvidersForConfig("/repo/app")
    expect(catalog.models[0]?.variants.map((variant: { id: string }) => variant.id)).toEqual(["high", "low"])
    expect(catalog.models[0]).toEqual(model)
  })

  test("a fresh provider read waits out the one in flight and reads again", async () => {
    const answer = (request: CapturedRequest) =>
      request.url.pathname === "/api/provider"
        ? json({ location: {}, data: [{ id: "openai", name: "OpenAI" }] })
        : request.url.pathname === "/api/model"
          ? json({ location: {}, data: [{ id: "openai/x", modelID: "x", providerID: "openai" }] })
          : json({ location: {}, data: { id: "openai/x", modelID: "x", providerID: "openai" } })
    responses.push(answer, answer, answer, answer, answer, answer)
    const before = requests.length

    const first = opencodeClient.getProvidersForConfig("/repo/app")
    const joined = opencodeClient.getProvidersForConfig("/repo/app")
    const fresh = opencodeClient.getProvidersForConfig("/repo/app", { fresh: true })
    const [firstCatalog, joinedCatalog, freshCatalog] = await Promise.all([first, joined, fresh])

    // One catalog read is three requests: the joined call adds none, the fresh one three more.
    expect(requests.length - before).toBe(6)
    expect(joinedCatalog).toBe(firstCatalog)
    expect(freshCatalog).not.toBe(firstCatalog)
  })
})

describe("providers of an isolated space", () => {
  test("are the host's, asked with no directory, while models come from the space", async () => {
    const space = "/spaces/a1b2c3d4e5f6/app"
    const answer = (request: CapturedRequest) =>
      request.url.pathname.endsWith("/provider")
        ? json({ location: {}, data: [{ id: "anthropic", name: "Anthropic" }] })
        : request.url.pathname.endsWith("/model")
          ? json({ location: {}, data: [{ id: "anthropic/x", modelID: "x", providerID: "anthropic" }] })
          : json({ location: {}, data: { id: "anthropic/x", modelID: "x", providerID: "anthropic" } })
    responses.push(answer, answer, answer)
    const before = requests.length
    const catalog = await opencodeClient.getProvidersForConfig(space)
    expect(catalog.providers).toEqual([{ id: "anthropic", name: "Anthropic" }])
    const made = requests.slice(before)
    const provider = made.find((request) => request.url.pathname.endsWith("/provider"))
    const model = made.find((request) => request.url.pathname.endsWith("/model"))
    // The host refuses its provider routes across the boundary, and a space directory without the
    // prefix; the provider list names neither.
    expect(provider?.url.pathname).toBe("/api/provider")
    expect(provider?.headers.get("x-opencode-directory")).toBeNull()
    expect(provider?.url.searchParams.get("directory")).toBeNull()
    expect(model?.url.pathname.includes("/spaces/a1b2c3d4e5f6/") || model?.headers.get("x-opencode-directory") === encodeURIComponent(space)).toBe(true)
  })
})

describe("read timeouts (#2470)", () => {
  test("a hanging read fails after the timeout while a POST is left alone", async () => {
    const client = createRuntimeOpencodeClient({ baseUrl: "http://runtime.test/api", requestTimeoutMs: 20 })
    responses.push(HANG)
    // The raw client reports transport failures as ClientError("Transport") with the cause attached.
    const failure = await client.server.info().catch((error: Error) => error)
    expect(failure).toMatchObject({ reason: "Transport", cause: { message: "OpenCode request timed out after 20ms" } })

    let settled = false
    responses.push(HANG)
    void client.session.interrupt({ sessionID: "ses_1" }).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(settled).toBe(false)
  })
})

describe("sendCommand context", () => {
  test("delivers attached context as non-resuming synthetic messages before the command", async () => {
    responses.push(new Response(null, { status: 204 })) // model switch
    responses.push(new Response(null, { status: 204 })) // agent switch
    responses.push(json({ data: { id: "msg_ctx" } })) // synthetic
    responses.push(new Response(null, { status: 204 })) // command
    await opencodeClient.sendCommand({
      id: "ses_1",
      model: { providerID: "p", modelID: "m" },
      agent: "build",
      command: "review",
      arguments: "src",
      context: [{ text: "quoted selection", description: "Selection" }],
    })
    const paths = requests.map((request) => request.url.pathname)
    expect(paths.at(-2)).toBe("/api/session/ses_1/synthetic")
    expect(paths.at(-1)).toBe("/api/session/ses_1/command")
    expect(requests.at(-2)?.body).toMatchObject({ text: "quoted selection", resume: false })
    expect(requests.at(-1)?.body).toMatchObject({ name: "review", text: "src" })
  })
})
