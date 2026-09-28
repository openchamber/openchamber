import { describe, expect, test } from "bun:test"

import {
  patchInputFiles,
  blocksOnForm,
  carriesFileDiffs,
  executeOutputTruncation,
  executeScript,
  executeToolCalls,
  isExplorationTool,
  isFileChangeTool,
  isShellTool,
  isSubagentTool,
  isWebTool,
  normalizeToolName,
  subagentSessionId,
  toolDescription,
  toolFileDiffs,
  toolInputPath,
} from "./tools"

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
    expect(blocksOnForm("question")).toBe(true)
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
