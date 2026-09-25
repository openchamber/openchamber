import { describe, expect, test } from "bun:test"
import type { ConfigEntry, SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

import { partIds } from "./model"
import {
  mergeConfigDocuments,
  projectAgent,
  projectAssistantContent,
  projectMessage,
  projectSession,
  projectToolPart,
  projectUserParts,
} from "./projection"

const sessionInfo: SessionInfo = {
  id: "ses_1",
  projectID: "proj_1",
  cost: 0.5,
  tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 100, updated: 200 },
  title: "Hello",
  location: { directory: "/repo/app" },
  metadata: { pinned: true },
}

describe("projectSession", () => {
  test("lifts location onto the session and keeps optional fields absent", () => {
    const session = projectSession(sessionInfo)
    expect(session.directory).toBe("/repo/app")
    expect(session.title).toBe("Hello")
    expect(session.metadata).toEqual({ pinned: true })
    expect("parentID" in session).toBe(false)
    expect("agent" in session).toBe(false)
  })

  test("an untitled session gets an empty title rather than undefined", () => {
    const session = projectSession({ ...sessionInfo, title: undefined })
    expect(session.title).toBe("")
  })
})

const assistant: SessionMessageAssistant = {
  id: "msg_a",
  type: "assistant",
  time: { created: 1000, completed: 1500 },
  agent: "build",
  model: { id: "gpt-5.6-luna", providerID: "openai" },
  finish: "stop",
  cost: 0.01,
  tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [
    { type: "reasoning", text: "thinking", time: { created: 1001, completed: 1002 } },
    { type: "text", text: "first" },
    {
      type: "tool",
      id: "call_1",
      name: "bash",
      executed: true,
      time: { created: 1003, ran: 1004, completed: 1005 },
      state: {
        status: "completed",
        input: { command: "ls" },
        content: [
          { type: "text", text: "a\nb" },
          { type: "file", uri: "file:///tmp/out.png", mime: "image/png", name: "out.png" },
        ],
        metadata: { exit: 0 },
      },
    },
    { type: "text", text: "second" },
  ],
}

describe("projectMessage (assistant)", () => {
  test("flattens the model ref and maps content to ordered parts with deterministic ids", () => {
    const { message, parts } = projectMessage(assistant, "ses_1")
    expect(message.role).toBe("assistant")
    if (message.role !== "assistant") throw new Error("expected assistant")
    expect(message.providerID).toBe("openai")
    expect(message.modelID).toBe("gpt-5.6-luna")
    expect(message.time.completed).toBe(1500)
    expect(parts.map((part) => part.id)).toEqual([
      partIds.reasoning("msg_a", 0),
      partIds.text("msg_a", 0),
      "call_1",
      partIds.text("msg_a", 1),
    ])
    expect(parts.every((part) => part.sessionID === "ses_1" && part.messageID === "msg_a")).toBe(true)
  })

  test("tool content becomes output text plus file attachments", () => {
    const { parts } = projectMessage(assistant, "ses_1")
    const tool = parts[2]
    if (tool.type !== "tool") throw new Error("expected tool part")
    expect(tool.tool).toBe("bash")
    expect(tool.callID).toBe("call_1")
    expect(tool.executed).toBe(true)
    if (tool.state.status !== "completed") throw new Error("expected completed")
    expect(tool.state.output).toBe("a\nb")
    expect(tool.state.time).toEqual({ start: 1004, end: 1005 })
    expect(tool.state.attachments).toEqual([
      {
        id: "call_1:file:0",
        sessionID: "ses_1",
        messageID: "msg_a",
        type: "file",
        mime: "image/png",
        filename: "out.png",
        url: "file:///tmp/out.png",
      },
    ])
    expect(tool.state.metadata).toEqual({ exit: 0 })
  })

  test("text parts of a completed message carry an end time, streaming ones do not", () => {
    const done = projectAssistantContent([{ type: "text", text: "x" }], {
      sessionID: "s",
      messageID: "m",
      created: 1,
      completed: 2,
    })
    const live = projectAssistantContent([{ type: "text", text: "x" }], { sessionID: "s", messageID: "m", created: 1 })
    expect(done[0].type === "text" && done[0].time).toEqual({ start: 1, end: 2 })
    expect(live[0].type === "text" && live[0].time).toEqual({ start: 1 })
  })
})

describe("projectToolPart", () => {
  const owner = { sessionID: "ses_1", messageID: "msg_a" }

  test("streaming input becomes a pending state with the raw argument text", () => {
    const part = projectToolPart(
      { type: "tool", id: "c", name: "edit", time: { created: 5 }, state: { status: "streaming", input: '{"pa' } },
      owner,
    )
    expect(part.state).toEqual({ status: "pending", input: {}, raw: '{"pa' })
  })

  test("running state uses the run timestamp as start", () => {
    const part = projectToolPart(
      {
        type: "tool",
        id: "c",
        name: "edit",
        time: { created: 5, ran: 7 },
        state: { status: "running", input: { path: "a" }, metadata: { title: "Editing" } },
      },
      owner,
    )
    expect(part.state).toEqual({ status: "running", input: { path: "a" }, metadata: { title: "Editing" }, time: { start: 7 } })
  })

  test("error state renders the structured error as text and keeps partial output", () => {
    const part = projectToolPart(
      {
        type: "tool",
        id: "c",
        name: "bash",
        time: { created: 5, ran: 6, completed: 9 },
        state: {
          status: "error",
          input: { command: "false" },
          error: { type: "tool.failed", message: "exit 1" },
          content: [{ type: "text", text: "partial" }],
        },
      },
      owner,
    )
    expect(part.state).toEqual({
      status: "error",
      input: { command: "false" },
      error: "exit 1",
      output: "partial",
      time: { start: 6, end: 9 },
    })
  })
})

describe("projectUserParts", () => {
  test("text, files, and agent mentions become parts in that order", () => {
    const parts = projectUserParts(
      {
        text: "hi",
        files: [
          { data: "QUJD", mime: "text/plain", source: { type: "inline" }, name: "a.txt" },
          { data: "", mime: "image/png", source: { type: "uri", uri: "file:///x.png" } },
        ],
        agents: [{ name: "explore" }],
      },
      { sessionID: "ses_1", messageID: "msg_u", created: 10 },
    )
    expect(parts.map((part) => part.type)).toEqual(["text", "file", "file", "agent"])
    expect(parts[0].id).toBe(partIds.userText("msg_u"))
    expect(parts[1]).toMatchObject({ url: "data:text/plain;base64,QUJD", filename: "a.txt" })
    expect(parts[2]).toMatchObject({ url: "file:///x.png" })
    expect(parts[3]).toMatchObject({ type: "agent", name: "explore" })
  })

  test("an empty prompt text produces no text part", () => {
    const parts = projectUserParts({ text: "" }, { sessionID: "s", messageID: "m", created: 1 })
    expect(parts).toEqual([])
  })
})

describe("projectMessage (other roles)", () => {
  test("every non-conversation message projects with its role and no parts", () => {
    const items: SessionMessageInfo[] = [
      { id: "1", type: "synthetic", time: { created: 1 }, text: "ctx" },
      { id: "2", type: "system", time: { created: 2 }, text: "sys", description: "d" },
      { id: "3", type: "skill", time: { created: 3 }, skill: "sk", name: "Skill", text: "t" },
      { id: "4", type: "shell", time: { created: 4 }, shellID: "sh", command: "ls", status: "exited", exit: 0 },
      { id: "5", type: "compaction", time: { created: 5 }, status: "running", reason: "auto", summary: "", recent: "" },
      {
        id: "6",
        type: "compaction",
        time: { created: 6 },
        status: "failed",
        reason: "manual",
        error: { type: "x", message: "boom" },
      },
      { id: "7", type: "agent-switched", time: { created: 7 }, agent: "plan", previous: "build" },
      { id: "8", type: "model-switched", time: { created: 8 }, model: { id: "m", providerID: "p" } },
      {
        id: "9",
        type: "location-switched",
        time: { created: 9 },
        location: { directory: "/b" },
        previous: { location: { directory: "/a" } },
      },
    ]
    const projected = items.map((item) => projectMessage(item, "ses_1"))
    expect(projected.map((entry) => entry.message.role)).toEqual([
      "synthetic",
      "system",
      "skill",
      "shell",
      "compaction",
      "compaction",
      "agent-switched",
      "model-switched",
      "location-switched",
    ])
    expect(projected.every((entry) => entry.parts.length === 0)).toBe(true)
    expect(projected[5].message).toMatchObject({ status: "failed", summary: "", error: { message: "boom" } })
    expect(projected[8].message).toMatchObject({ directory: "/b", previous: "/a" })
  })
})

describe("mergeConfigDocuments", () => {
  test("later documents win per key and record keys merge by name", () => {
    const entries: ConfigEntry[] = [
      {
        type: "document",
        path: "/home/u/.config/opencode/opencode.json",
        info: { model: "openai/a", agents: { build: { description: "global build" }, review: {} } },
      },
      { type: "directory", path: "/repo/.opencode" } as ConfigEntry,
      {
        type: "document",
        path: "/repo/opencode.json",
        info: { model: "openai/b", agents: { build: { description: "project build" } } },
      },
    ]
    const config = mergeConfigDocuments(entries)
    expect(config.model).toBe("openai/b")
    expect(config.agents).toEqual({ build: { description: "project build" }, review: {} })
  })

  test("no documents yields an empty config", () => {
    expect(mergeConfigDocuments([])).toEqual({})
  })
})

describe("projectAgent", () => {
  test("keys the agent by its wire id and keeps the wire name for display", () => {
    const agent = projectAgent({
      id: "build",
      name: "Build",
      mode: "primary",
      hidden: false,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
    })
    // Prompts and session switches send `name`; the server expects the id there.
    expect(agent.name).toBe("build")
    expect(agent.displayName).toBe("Build")
    expect(agent.id).toBe("build")
  })
})
