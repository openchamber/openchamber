import { describe, expect, test } from "bun:test"

import {
  patchInputFiles,
  isQuestionTool,
  carriesFileDiffs,
  executeOutputTruncation,
  executeScript,
  executeToolCalls,
  executeHasBackgroundableWork,
  isExplorationTool,
  isFileChangeTool,
  isShellTool,
  isSubagentTool,
  isWebTool,
  normalizeToolName,
  openChamberToolCall,
  renderedPage,
  requestedSecret,
  subagentSessionId,
  toolDescription,
  toolFileDiffs,
  toolInputPath, isShownInPlace, proposedWorkflowRunId, generatedImagePaths } from "./tools"
import type { Metadata, ToolInput, ToolState } from "./model"

describe("tool identity", () => {
  test("recognizes the v2 names, not the v1 ones", () => {
    expect(isShellTool("shell")).toBe(true)
    expect(isShellTool("bash")).toBe(false)
    expect(isSubagentTool("subagent")).toBe(true)
    expect(isSubagentTool("task")).toBe(false)
    expect(isFileChangeTool("patch")).toBe(true)
    expect(isFileChangeTool("apply_patch")).toBe(false)
    expect(isExplorationTool("list")).toBe(false)
    expect(isExplorationTool("grep")).toBe(true)
    expect(isWebTool("webfetch")).toBe(true)
    expect(isQuestionTool("question")).toBe(true)
  })

  test("normalizes namespaced and deduplicated names", () => {
    expect(normalizeToolName("opencode.session_rename")).toBe("session_rename")
    expect(normalizeToolName(" Shell:2 ")).toBe("shell")
    expect(isShellTool("runtime.shell:3")).toBe(true)
    expect(normalizeToolName(undefined)).toBe("")
  })

  test("only edit and patch results carry per-file diffs", () => {
    expect(carriesFileDiffs("edit")).toBe(true)
    expect(carriesFileDiffs("patch")).toBe(true)
    expect(carriesFileDiffs("write")).toBe(false)
  })
})

describe("tool input and metadata", () => {
  test("reads the v2 path key and the legacy ones MCP tools use", () => {
    expect(toolInputPath({ path: "src/a.ts" })).toBe("src/a.ts")
    expect(toolInputPath({ filePath: "src/b.ts" })).toBe("src/b.ts")
    expect(toolInputPath({ file_path: "src/c.ts" })).toBe("src/c.ts")
    expect(toolInputPath({})).toBe(undefined)
  })

  test("parses FileDiff.Info entries and drops malformed ones", () => {
    const files = toolFileDiffs({
      files: [
        { file: "a.ts", patch: "@@", additions: 2, deletions: 1, status: "modified" },
        { patch: "@@" },
        null,
      ],
    })

    expect(files).toEqual([{ file: "a.ts", patch: "@@", additions: 2, deletions: 1, status: "modified" }])
  })

  test("reads the subagent child session from metadata", () => {
    expect(subagentSessionId({ sessionID: "ses_child", status: "running" })).toBe("ses_child")
    expect(subagentSessionId({})).toBe(undefined)
  })
})

describe("tool row description", () => {
  test("OpenChamber tools show their action and the detail that tells calls apart", () => {
    expect(toolDescription("openchamber", {
      action: "session.link",
      parameters: { sessionId: "ses_1", link: { identifier: "#3998", title: "Keep PR badges after rebases", url: "https://x", kind: "change" } },
    }, undefined)).toEqual({ kind: "text", value: "session.link · #3998 Keep PR badges after rebases" })
    expect(toolDescription("openchamber", {
      action: "session.send",
      parameters: { sessionId: "ses_1", prompt: "Addition from the maintainer\nmore" },
    }, undefined)).toEqual({ kind: "text", value: "session.send · Addition from the maintainer" })
    expect(toolDescription("openchamber_memory", { action: "memory.save", parameters: { title: "Drafts rule" } }, undefined))
      .toEqual({ kind: "text", value: "memory.save · Drafts rule" })
    expect(toolDescription("openchamber_web", { action: "browser.snapshot", parameters: {} }, undefined))
      .toEqual({ kind: "text", value: "browser.snapshot" })
    expect(toolDescription("openchamber_notify", { title: "Review ready" }, undefined))
      .toEqual({ kind: "text", value: "Review ready" })
  })

  test("shell shows the first line of the command", () => {
    expect(toolDescription("shell", { command: "git status\ngit log" }, undefined)).toEqual({
      kind: "text",
      value: "git status",
    })
  })

  test("subagent shows the 3-5 word label the model wrote", () => {
    expect(toolDescription("subagent", { agent: "Explore", description: "Find the tool renderers" }, undefined))
      .toEqual({ kind: "text", value: "Find the tool renderers" })
  })

  test("file tools show their path, patch shows its files", () => {
    expect(toolDescription("edit", { path: "src/a.ts" }, undefined)).toEqual({ kind: "path", value: "src/a.ts" })
    expect(toolDescription("read", { path: "src/a.ts" }, undefined)).toEqual({ kind: "path", value: "src/a.ts" })
    expect(toolDescription("patch", { patchText: "*** Begin" }, { files: [{ file: "src/a.ts" }] }))
      .toEqual({ kind: "path", value: "src/a.ts" })
    expect(toolDescription("patch", {}, { files: [{ file: "a.ts" }, { file: "b.ts" }] }))
      .toEqual({ kind: "files", count: 2, files: ["a.ts", "b.ts"] })
  })

  test("a patch describes itself from its own text until the tool reports its diffs", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+hello",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n")
    expect(patchInputFiles({ patchText })).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
    expect(toolDescription("patch", { patchText }, undefined))
      .toEqual({ kind: "files", count: 3, files: ["src/a.ts", "src/b.ts", "src/c.ts"] })
    expect(toolDescription("patch", { patchText: "*** Begin Patch\n*** Update File: only.ts\n*** End Patch" }, {}))
      .toEqual({ kind: "path", value: "only.ts" })
    // Reported diffs win over the text once the tool ran.
    expect(toolDescription("patch", { patchText }, { files: [{ file: "src/a.ts" }] }))
      .toEqual({ kind: "path", value: "src/a.ts" })
  })

  test("the opencode namespace tools and skill describe their own input", () => {
    expect(toolDescription("skill", { id: "writing-for-agents" }, undefined))
      .toEqual({ kind: "text", value: "writing-for-agents" })
    expect(toolDescription("opencode.session_rename", { title: "Fix the dock" }, undefined))
      .toEqual({ kind: "text", value: "Fix the dock" })
    expect(toolDescription("opencode.session_move", { directory: "~/projects/app" }, undefined))
      .toEqual({ kind: "path", value: "~/projects/app" })
    expect(toolDescription("opencode.models", { search: "haiku" }, undefined))
      .toEqual({ kind: "text", value: "haiku" })
    expect(toolDescription("opencode.models", { provider: "anthropic" }, undefined))
      .toEqual({ kind: "text", value: "anthropic" })
  })

  test("search and web tools show what they looked for", () => {
    expect(toolDescription("grep", { pattern: "getRuntime", path: "packages/ui" }, { matches: 100 }))
      .toEqual({ kind: "text", value: "getRuntime" })
    expect(toolDescription("glob", { pattern: "*" }, undefined)).toEqual({ kind: "text", value: "*" })
    expect(toolDescription("webfetch", { url: "https://example.com" }, undefined))
      .toEqual({ kind: "text", value: "https://example.com" })
    expect(toolDescription("websearch", { query: "effect schema" }, undefined))
      .toEqual({ kind: "text", value: "effect schema" })
  })

  test("question counts what it asked", () => {
    expect(toolDescription("question", { questions: [{ question: "a" }, { question: "b" }] }, undefined))
      .toEqual({ kind: "questions", count: 2 })
    expect(toolDescription("question", { questions: [{ question: "a" }] }, undefined))
      .toEqual({ kind: "questions", count: 1 })
  })

  test("execute names the tools the script called, deduplicated and counted", () => {
    expect(toolDescription("execute", { code: "await linear.list_issues()" }, {
      toolCalls: [
        { tool: "linear.list_issues", status: "completed", input: { teamId: "OPE" } },
        { tool: "linear.list_issues", status: "error", input: {} },
        { tool: "linear.list_issues", status: "completed", input: {} },
        { tool: "linear.get_workspace", status: "completed" },
      ],
    })).toEqual({
      kind: "tools",
      calls: [{ name: "linear.list_issues", count: 3 }, { name: "linear.get_workspace", count: 1 }],
      overflow: 0,
    })
  })

  test("execute caps the named tools and counts the rest", () => {
    const toolCalls = ["a", "b", "c", "d", "e", "f"].map((tool) => ({ tool, status: "completed" }))
    expect(toolDescription("execute", {}, { toolCalls })).toEqual({
      kind: "tools",
      calls: [
        { name: "a", count: 1 },
        { name: "b", count: 1 },
        { name: "c", count: 1 },
        { name: "d", count: 1 },
      ],
      overflow: 2,
    })
  })

  test("execute falls back to the first line of the script while it has called nothing", () => {
    expect(toolDescription("execute", { code: "const issues = await linear.list_issues()\nreturn issues" }, {}))
      .toEqual({ kind: "text", value: "const issues = await linear.list_issues()" })
    expect(toolDescription("execute", { code: "x".repeat(140) }, undefined))
      .toEqual({ kind: "text", value: "x".repeat(100) })
    expect(toolDescription("execute", {}, undefined)).toBe(null)
  })

  test("MCP tools fall back to their own description, then a path", () => {
    expect(toolDescription("linear_get_issue", { description: "Fetch OPE-199" }, undefined))
      .toEqual({ kind: "text", value: "Fetch OPE-199" })
    expect(toolDescription("custom_tool", { path: "notes.md" }, undefined))
      .toEqual({ kind: "path", value: "notes.md" })
    expect(toolDescription("custom_tool", {}, undefined)).toBe(null)
  })
})

describe("execute call details", () => {
  test("recognizes blocking child progress and ignores invalid job markers", () => {
    expect(executeHasBackgroundableWork({ shellID: "sh_1" })).toBe(true)
    expect(executeHasBackgroundableWork({ sessionID: "ses_child", status: "running" })).toBe(true)
    expect(executeHasBackgroundableWork({ sessionID: "ses_child", status: "completed" })).toBe(false)
    expect(executeHasBackgroundableWork({ shellID: 1, sessionID: false, status: "running" })).toBe(false)
    expect(executeHasBackgroundableWork({ shellID: "  ", toolCalls: [null, { tool: "runtime.shell:3", status: "running" }] })).toBe(true)
    expect(executeHasBackgroundableWork(undefined)).toBe(false)
  })
  test("keeps order and status, serializes the input on one line, drops nameless calls", () => {
    expect(executeToolCalls({
      toolCalls: [
        { tool: "search", status: "completed", input: { query: "a\nb" } },
        { status: "error", input: {} },
        { tool: "openchamber_memory", status: "error" },
        { tool: "noop", status: "completed", input: {} },
      ],
    })).toEqual([
      { tool: "search", status: "completed", input: '{"query":"a\\nb"}' },
      { tool: "openchamber_memory", status: "error" },
      { tool: "noop", status: "completed" },
    ])
    expect(executeToolCalls({})).toEqual([])
  })

  test("reports truncation only when the tool said so", () => {
    expect(executeOutputTruncation({ truncated: true, outputPath: "/tmp/out.json" }))
      .toEqual({ outputPath: "/tmp/out.json" })
    expect(executeOutputTruncation({ truncated: true })).toEqual({})
    expect(executeOutputTruncation({ outputPath: "/tmp/out.json" })).toBe(null)
    expect(executeOutputTruncation(undefined)).toBe(null)
  })

  test("reads the script off the input", () => {
    expect(executeScript({ code: "return 1" })).toBe("return 1")
    expect(executeScript({})).toBe(undefined)
  })
})

describe("renderedPage", () => {
  const accepted = { openchamber: { ok: true } }
  const completed = (input: ToolInput, metadata?: Metadata): ToolState => ({ status: "completed", input, output: "", metadata, time: { start: 1, end: 2 } })
  const running = (input: ToolInput): ToolState => ({ status: "running", input, time: { start: 1 } })

  test("reads the page from parameters, or beside the action, once OpenChamber accepted it", () => {
    expect(renderedPage("openchamber_render", completed({ action: "render.page", parameters: { html: "<p>a</p>", title: "Chart" } }, accepted)))
      .toEqual({ html: "<p>a</p>", title: "Chart", ask: { kind: "show" } })
    expect(renderedPage("openchamber_render", completed({ action: "render.page", html: "<p>b</p>", title: "Flat" }, accepted)))
      .toEqual({ html: "<p>b</p>", title: "Flat", ask: { kind: "show" } })
    // An explicit parameters object wins, as it does in the plugin.
    expect(renderedPage("openchamber_render", completed({ html: "<p>flat</p>", parameters: { html: "<p>nested</p>", title: "T" } }, accepted)))
      .toEqual({ html: "<p>nested</p>", title: "T", ask: { kind: "show" } })
  })

  test("shows a page that waits while its call runs, and its answer once it completes", () => {
    const input = { action: "render.page", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: true } }
    expect(renderedPage("openchamber_render", running(input))?.ask).toEqual({ kind: "waiting" })
    expect(renderedPage("openchamber_render", completed(input, { openchamber: { ok: true, answer: { answered: true, summary: "Layout B", data: { layout: "b" } } } }))?.ask)
      .toEqual({ kind: "answered", summary: "Layout B", data: { layout: "b" } })
    expect(renderedPage("openchamber_render", completed(input, { openchamber: { ok: true, answer: { answered: false, reason: "chat" } } }))?.ask)
      .toEqual({ kind: "answered-in-chat" })
    expect(renderedPage("openchamber_render", completed(input, { openchamber: { ok: true, answer: { answered: false, reason: "chat-sent-earlier" } } }))?.ask)
      .toEqual({ kind: "chat-sent-earlier" })
    const stopped: ToolState = { status: "error", input, error: "aborted", time: { start: 1, end: 2 } }
    expect(renderedPage("openchamber_render", stopped)?.ask).toEqual({ kind: "unanswered" })
  })

  test("waits on an awaitAnswer a harness stringified, as the plugin normalizes it", () => {
    // The plugin sends the server "true"/"false" normalized to a real boolean
    // and waits there; OpenCode stores the input as it arrived. A string read
    // as false sent the chat's page away while the call waited on an answer
    // only that page could give (2026-10-25).
    const nested = { action: "render.page", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: "true" } }
    expect(renderedPage("openchamber_render", running(nested))?.ask).toEqual({ kind: "waiting" })
    const flat = { action: "render.page", html: "<p>a</p>", title: "Pick", awaitAnswer: "true" }
    expect(renderedPage("openchamber_render", running(flat))?.ask).toEqual({ kind: "waiting" })
    expect(renderedPage("openchamber_render", { status: "error", input: nested, error: "aborted", time: { start: 1, end: 2 } })?.ask)
      .toEqual({ kind: "unanswered" })
    // "false" is false: the page shows and asks nothing.
    const shown = { action: "render.page", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: "false" } }
    expect(renderedPage("openchamber_render", running(shown))).toBeNull()
    expect(renderedPage("openchamber_render", completed(shown, accepted))?.ask).toEqual({ kind: "show" })
    // Any other value reads as absent, as the server's strict check judges it.
    const odd = { action: "render.page", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: "yes" } }
    expect(renderedPage("openchamber_render", running(odd))).toBeNull()
    // An explicit parameters object wins on a conflict, as it does in the plugin.
    const conflict = { action: "render.page", awaitAnswer: "true", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: "false" } }
    expect(renderedPage("openchamber_render", running(conflict))).toBeNull()
  })

  test("leaves a refused, unfinished, empty or foreign call to its tool row", () => {
    const input = { action: "render.page", parameters: { html: "<p>a</p>", title: "Chart" } }
    expect(renderedPage("openchamber_render", completed(input, { openchamber: { ok: false } }))).toBeNull()
    expect(renderedPage("openchamber_render", completed(input))).toBeNull()
    expect(renderedPage("openchamber_render", running(input))).toBeNull()
    expect(renderedPage("openchamber_render", { status: "error", input, error: "refused", time: { start: 1, end: 2 } })).toBeNull()
    expect(renderedPage("openchamber_render", completed({ parameters: { html: "  ", title: "Chart" } }, accepted))).toBeNull()
    expect(renderedPage("openchamber", completed(input, accepted))).toBeNull()
  })

  test("names a page sent without a title after its own title or first heading, as the server does", () => {
    const titled = (html: string) => renderedPage("openchamber_render", completed({ parameters: { html } }, accepted))?.title
    expect(titled("<title> Q3 &amp; Q4 </title><h1>Other</h1>")).toBe("Q3 & Q4")
    expect(titled("<title></title><h2>Release <b>2.4</b></h2>")).toBe("Release 2.4")
    expect(titled(`<h1>${"x".repeat(200)}</h1>`)).toBe("x".repeat(120))
    // Nothing names it: the chat shows its own word.
    expect(titled("<p>a</p>")).toBe("")
  })
})

describe("requestedSecret", () => {
  const completed = (input: ToolInput, metadata?: Metadata): ToolState => ({ status: "completed", input, output: "", metadata, time: { start: 1, end: 2 } })
  const running = (input: ToolInput): ToolState => ({ status: "running", input, time: { start: 1 } })
  const input = { action: "secret.request", parameters: { label: "Cloudflare API token", reason: "To deploy the worker.", placeholder: "cf-..." } }
  const request = { label: "Cloudflare API token", reason: "To deploy the worker.", placeholder: "cf-..." }

  test("asks while its call runs and folds to how it ended", () => {
    expect(requestedSecret("openchamber_secret", running(input))).toEqual({ ...request, state: "waiting" })
    expect(requestedSecret("openchamber_secret", completed(input, { openchamber: { ok: true, answer: { status: "saved", file: "/data/secrets/abc" } } }))?.state).toBe("saved")
    expect(requestedSecret("openchamber_secret", completed(input, { openchamber: { ok: true, answer: { status: "declined" } } }))?.state).toBe("declined")
    expect(requestedSecret("openchamber_secret", completed(input, { openchamber: { ok: true, answer: { answered: false, reason: "chat" } } }))?.state).toBe("not-given")
    expect(requestedSecret("openchamber_secret", { status: "error", input, error: "aborted", time: { start: 1, end: 2 } })?.state).toBe("not-given")
    // Beside the action, as the plugin also accepts it.
    expect(requestedSecret("openchamber_secret", running({ action: "secret.request", label: "Key", reason: "Why" })))
      .toEqual({ label: "Key", reason: "Why", placeholder: undefined, state: "waiting" })
  })

  test("leaves a refused, incomplete or foreign call to its tool row", () => {
    expect(requestedSecret("openchamber_secret", completed(input, { openchamber: { ok: false } }))).toBeNull()
    expect(requestedSecret("openchamber_secret", completed(input))).toBeNull()
    expect(requestedSecret("openchamber_secret", running({ action: "secret.request", parameters: { label: "Key" } }))).toBeNull()
    expect(requestedSecret("openchamber_render", running(input))).toBeNull()
  })

  test("is shown in place and always counts as waiting for the user", () => {
    expect(isShownInPlace("openchamber_secret", running(input))).toBe(true)
    expect(openChamberToolCall("openchamber_secret", input)?.awaitsAnswer).toBe(true)
  })
})

describe("proposedWorkflowRunId", () => {
  const completed = (output: string, tool = "openchamber_workflow"): [string, ToolState] => [tool, { status: "completed", input: { action: "workflow.run" }, output, time: { start: 1, end: 2 } }]
  type Envelope = { ok: boolean; action: string; data?: { runId: string; state?: string }; error?: { message: string } }
  const envelope = (body: Envelope) => JSON.stringify({ schemaVersion: 1, ...body })

  test("reads the run a workflow.run call proposed, which the chat draws in place of the row", () => {
    const call = completed(envelope({ ok: true, action: "workflow.run", data: { runId: "wf_one", state: "awaiting-approval" } }))
    expect(proposedWorkflowRunId(...call)).toBe("wf_one")
    expect(isShownInPlace(...call)).toBe(true)
  })

  test("leaves other actions, refusals and other tools to their rows", () => {
    expect(proposedWorkflowRunId(...completed(envelope({ ok: true, action: "workflow.status", data: { runId: "wf_one" } })))).toBeNull()
    expect(proposedWorkflowRunId(...completed(envelope({ ok: false, action: "workflow.run", error: { message: "bad script" } })))).toBeNull()
    expect(proposedWorkflowRunId(...completed("not json"))).toBeNull()
    expect(proposedWorkflowRunId(...completed(envelope({ ok: true, action: "workflow.run", data: { runId: "wf_one" } }), "openchamber"))).toBeNull()
  })
})

describe("generatedImagePaths", () => {
  const completed = (output: string, tool = "openchamber_image"): [string, ToolState] => [tool, { status: "completed", input: { prompt: "a cat" }, output, time: { start: 1, end: 2 } }]
  const envelope = (ok: boolean, paths: string[]) => JSON.stringify({ schemaVersion: 1, ok, action: "image.generate", data: { images: paths.map((path) => ({ path, mime: "image/png" })) } })

  test("reads the files an image.generate call saved, which the chat draws in place of the row", () => {
    const call = completed(envelope(true, ["/tmp/opencode/generated-images/a.png", "/repo/b.png"]))
    expect(generatedImagePaths(...call)).toEqual(["/tmp/opencode/generated-images/a.png", "/repo/b.png"])
    expect(isShownInPlace(...call)).toBe(true)
  })

  test("leaves refusals, running calls and other tools to their rows", () => {
    expect(generatedImagePaths(...completed(envelope(false, ["/tmp/a.png"])))).toEqual([])
    expect(generatedImagePaths(...completed(envelope(true, [])))).toEqual([])
    expect(generatedImagePaths(...completed(envelope(true, ["/tmp/a.png"]), "openchamber_render"))).toEqual([])
    expect(generatedImagePaths("openchamber_image", { status: "running", input: {}, time: { start: 1 } })).toEqual([])
  })
})

describe("isShownInPlace", () => {
  const running = (input: ToolInput): ToolState => ({ status: "running", input, time: { start: 1 } })

  test("hoists a waiting page even when a harness stringified its awaitAnswer", () => {
    const waiting = { action: "render.page", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: "true" } }
    expect(isShownInPlace("openchamber_render", running(waiting))).toBe(true)
    expect(isShownInPlace("openchamber_render", { status: "error", input: waiting, error: "aborted", time: { start: 1, end: 2 } })).toBe(true)
    const notWaiting = { action: "render.page", parameters: { html: "<p>a</p>", title: "Pick", awaitAnswer: "false" } }
    expect(isShownInPlace("openchamber_render", running(notWaiting))).toBe(false)
    expect(isShownInPlace("openchamber_render", running({ ...notWaiting, parameters: { ...notWaiting.parameters, awaitAnswer: "yes" } }))).toBe(false)
  })
})

describe("openChamberToolCall", () => {
  test("reads a stringified awaitAnswer the way the plugin normalizes it", () => {
    expect(openChamberToolCall("openchamber_render", { action: "render.page", awaitAnswer: "true" })?.awaitsAnswer).toBe(true)
    expect(openChamberToolCall("openchamber_render", { action: "render.page", parameters: { awaitAnswer: "true" } })?.awaitsAnswer).toBe(true)
    expect(openChamberToolCall("openchamber_render", { action: "render.page", awaitAnswer: "false" })?.awaitsAnswer).toBe(false)
    expect(openChamberToolCall("openchamber_render", { action: "render.page", awaitAnswer: "yes" })?.awaitsAnswer).toBe(false)
    expect(openChamberToolCall("openchamber_render", { action: "render.page", awaitAnswer: "true" })?.action).toBe("render.page")
    // An explicit parameters object wins on a conflict, as it does in the plugin.
    expect(openChamberToolCall("openchamber_render", { action: "render.page", awaitAnswer: "true", parameters: { awaitAnswer: "false" } })?.awaitsAnswer).toBe(false)
  })
})
