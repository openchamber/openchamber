import { describe, expect, test } from "bun:test"
import type { Event, Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import {
  fromOpenCodeEvent,
  fromOpenCodeMessage,
  fromOpenCodePart,
  fromOpenCodeRunConfig,
  fromOpenCodeSession,
  toOpenCodeMessageCompat,
  toOpenCodePartCompat,
  toOpenCodeSessionCompat,
} from "./opencode"

describe("OpenCode sync adapter", () => {
  test("maps session IDs and parent IDs to neutral names", () => {
    const session = {
      id: "ses_1",
      title: "Build feature",
      parentID: "ses_parent",
      time: { created: 1, updated: 2 },
    } as Session

    const result = fromOpenCodeSession(session)

    expect({
      id: result.id,
      backendId: result.backendId,
      title: result.title,
      parentId: result.parentId,
      time: result.time,
    }).toEqual({
      id: "ses_1",
      backendId: "opencode",
      title: "Build feature",
      parentId: "ses_parent",
      time: { created: 1, updated: 2 },
    })
    expect(toOpenCodeSessionCompat(result)).toBe(session)
  })

  test("maps message attribution from OpenCode provider/model/agent/variant fields", () => {
    const message = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      agent: "build",
      variant: "plan",
      time: { created: 10, completed: 20 },
      finish: "stop",
    } as Message

    const result = fromOpenCodeMessage(message)

    expect({
      id: result.id,
      sessionId: result.sessionId,
      role: result.role,
      finish: result.finish,
      attribution: result.attribution,
    }).toEqual({
      id: "msg_1",
      sessionId: "ses_1",
      role: "assistant",
      finish: "stop",
      attribution: {
        backendId: "opencode",
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        modeId: "build",
        effortId: "plan",
      },
    })
    expect(toOpenCodeMessageCompat(result)).toBe(message)
  })

  test("maps text and tool parts to neutral part kinds", () => {
    const textPart = {
      id: "part_text",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hello",
    } as Part
    const toolPart = {
      id: "part_tool",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/tmp",
        time: { start: 30, end: 40 },
      },
    } as unknown as Part

    const mappedText = fromOpenCodePart(textPart)
    const mappedTool = fromOpenCodePart(toolPart)

    expect({
      kind: mappedText.kind,
      id: mappedText.id,
      sessionId: mappedText.sessionId,
      messageId: mappedText.messageId,
      text: mappedText.kind === "text" ? mappedText.text : undefined,
    }).toEqual({
      kind: "text",
      id: "part_text",
      sessionId: "ses_1",
      messageId: "msg_1",
      text: "hello",
    })
    const tool = mappedTool.kind === "tool" ? mappedTool.tool : undefined
    expect({
      kind: mappedTool.kind,
      tool: tool
        ? {
            id: tool.id,
            name: tool.name,
            category: tool.category,
            status: tool.status,
            output: tool.output,
            startedAt: tool.startedAt,
            endedAt: tool.endedAt,
          }
        : undefined,
    }).toEqual({
      kind: "tool",
      tool: {
        id: "call_1",
        name: "bash",
        category: "shell",
        status: "completed",
        output: "/tmp",
        startedAt: 30,
        endedAt: 40,
      },
    })
    expect(toOpenCodePartCompat(fromOpenCodePart(textPart))).toBe(textPart)
  })

  test("maps OpenCode run config fields into neutral run config", () => {
    expect(fromOpenCodeRunConfig({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      agent: "build",
      variant: "plan",
    })).toEqual({
      backendId: "opencode",
      model: {
        backendId: "opencode",
        modelId: "anthropic/claude-sonnet-4-5",
      },
      interactionMode: "build",
      options: [{ id: "variant", value: "plan" }],
    })
  })

  test("maps OpenCode events to chat sync events", () => {
    const event = {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "hi",
      },
    } as Event

    expect(fromOpenCodeEvent(event)).toEqual({
      type: "part.delta",
      sessionId: "ses_1",
      messageId: "msg_1",
      partId: "part_1",
      field: "text",
      delta: "hi",
    })
  })
})
