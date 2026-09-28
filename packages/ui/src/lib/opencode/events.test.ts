import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"

import { partIds } from "./model"
import { messageIdFromEvent, routeWireEvent, syncEventMessageID, syncEventSessionID, translateWireEvent } from "./events"

const base = { id: "evt_1", created: 1000, location: { directory: "/repo" } }
const durable = { aggregateID: "ses_1", seq: 1, version: 1 as const }

describe("translateWireEvent", () => {
  test("session.created becomes a full session with zeroed usage", () => {
    const [event] = translateWireEvent({
      ...base,
      type: "session.created",
      durable,
      data: {
        sessionID: "ses_1",
        projectID: "proj_1",
        location: { directory: "/repo" },
        slug: "one",
        title: "One",
        agent: "build",
        version: "2.0.2",
      },
    })
    expect(event).toEqual({
      type: "session.created",
      properties: {
        info: {
          id: "ses_1",
          projectID: "proj_1",
          directory: "/repo",
          title: "One",
          agent: "build",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000, updated: 1000 },
        },
      },
    })
  })

  test("session.forked carries the fork and parent ids (2.x sends no session.created for a fork)", () => {
    const forked = translateWireEvent({
      ...base,
      type: "session.forked",
      durable: { ...durable, version: 2 as const },
      data: {
        sessionID: "ses_fork",
        parentID: "ses_1",
        boundary: { type: "through", messageID: "msg_1" },
      },
    })
    expect(forked).toEqual([{ type: "session.forked", properties: { sessionID: "ses_fork", parentID: "ses_1" } }])
    expect(syncEventSessionID(forked[0])).toBe("ses_fork")
  })

  test("session lifecycle events patch the session and emit switch messages", () => {
    const renamed = translateWireEvent({ ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "New" } })
    expect(renamed).toEqual([{ type: "session.patched", properties: { sessionID: "ses_1", patch: { title: "New", time: { updated: 1000 } } } }])

    const metadata = translateWireEvent({ ...base, type: "session.metadata.updated", durable, data: { sessionID: "ses_1", metadata: { openchamber: { goal: { id: "g1" } } } } })
    expect(metadata).toEqual([{ type: "session.patched", properties: { sessionID: "ses_1", patch: { metadata: { openchamber: { goal: { id: "g1" } } } } } }])

    const agent = translateWireEvent({ ...base, type: "session.agent.selected", durable, data: { sessionID: "ses_1", agent: "plan", previous: "build" } })
    expect(agent[0]).toEqual({ type: "session.patched", properties: { sessionID: "ses_1", patch: { agent: "plan" } } })
    expect(agent[1]).toMatchObject({ type: "message.updated", properties: { info: { id: "msg_1", role: "agent-switched", agent: "plan", previous: "build" } } })

    const cleared = translateWireEvent({ ...base, type: "session.revert.cleared", durable, data: { sessionID: "ses_1" } })
    expect(cleared).toEqual([{ type: "session.patched", properties: { sessionID: "ses_1", patch: { revert: null } } }])
  })

  test("a committed revert trims from the boundary before dropping the marker", () => {
    const committed = translateWireEvent({ ...base, type: "session.revert.committed", durable, data: { sessionID: "ses_1", to: "msg_u2" } })
    expect(committed).toEqual([
      { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_u2" } },
      { type: "session.patched", properties: { sessionID: "ses_1", patch: { revert: null } } },
    ])
    expect(syncEventSessionID(committed[0])).toBe("ses_1")
  })

  test("an interruption settles the session unless OpenCode is shutting down", () => {
    const user = translateWireEvent({ ...base, type: "session.execution.interrupted", durable, data: { sessionID: "ses_1", reason: "user" } })
    expect(user.map((e) => e.type)).toEqual(["session.patched", "session.idle"])
    expect(user[0]).toMatchObject({ properties: { patch: { outcome: "interrupted", time: { idle: 1000 } } } })
    const inactivity = translateWireEvent({ ...base, type: "session.execution.interrupted", durable, data: { sessionID: "ses_1", reason: "inactivity" } })
    expect(inactivity.map((e) => e.type)).toEqual(["session.patched", "session.idle"])
    // A shutdown keeps the turn resumable: no outcome, no idle, no local
    // interruption mark; the reconnect status snapshot decides.
    const shutdown = translateWireEvent({ ...base, type: "session.execution.interrupted", durable, data: { sessionID: "ses_1", reason: "shutdown" } })
    expect(shutdown).toEqual([])
  })

  test("execution outcomes settle status and record the outcome", () => {
    const failed = translateWireEvent({
      ...base,
      type: "session.execution.failed",
      durable,
      data: { sessionID: "ses_1", error: { type: "provider", message: "boom" } },
    })
    expect(failed.map((e) => e.type)).toEqual(["session.patched", "session.error"])
    expect(failed[0]).toMatchObject({ properties: { patch: { outcome: "failed", time: { idle: 1000 } } } })
    const done = translateWireEvent({ ...base, type: "session.execution.succeeded", durable, data: { sessionID: "ses_1" } })
    expect(done.map((e) => e.type)).toEqual(["session.patched", "session.idle"])
  })

  test("a user prompt entering the inbox becomes a user message with projected parts", () => {
    const events = translateWireEvent({
      ...base,
      type: "session.inbox.enqueued",
      durable,
      data: {
        sessionID: "ses_1",
        inboxID: "msg_u",
        item: { type: "user", delivery: "queue", payload: { text: "hi", files: [], metadata: { source: "chat" } } },
      },
    })
    expect(events[0]).toEqual({
      type: "message.updated",
      properties: { info: { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1000 }, metadata: { source: "chat" } } },
    })
    expect(events[1]).toMatchObject({
      type: "message.parts.replaced",
      properties: { messageID: "msg_u", parts: [{ id: partIds.userText("msg_u"), type: "text", text: "hi" }] },
    })
  })

  test("assistant steps create the message, then patch it on completion", () => {
    const started = translateWireEvent({
      ...base,
      type: "session.step.started",
      durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", agent: "build", model: { id: "m", providerID: "p" }, started: 1000 },
    })
    expect(started).toEqual([
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: 1000 }, agent: "build", providerID: "p", modelID: "m" },
        },
      },
    ])
    const ended = translateWireEvent({
      ...base,
      type: "session.step.ended",
      durable,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        finish: "stop",
        cost: 0.1,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    expect(ended).toEqual([
      {
        type: "message.patched",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_a",
          patch: { time: { completed: 1000 }, finish: "stop", cost: 0.1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, retry: null },
        },
      },
    ])
  })

  test("text streams as a part, deltas, then a final snapshot", () => {
    const started = translateWireEvent({
      ...base,
      type: "session.text.started",
      durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 1 },
    })
    expect(started).toEqual([
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { id: "msg_a:text:1", sessionID: "ses_1", messageID: "msg_a", type: "text", text: "", time: { start: 1000 } },
        },
      },
    ])
    const delta = translateWireEvent({
      ...base,
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 1, delta: "he" },
    })
    expect(delta).toEqual([
      { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "msg_a:text:1", field: "text", delta: "he" } },
    ])
    expect(translateWireEvent({ ...base, type: "session.compaction.delta", data: { sessionID: "ses_1", text: "sum" } })).toEqual([
      { type: "message.compaction.delta", properties: { sessionID: "ses_1", delta: "sum" } },
    ])
    const ended = translateWireEvent({
      ...base,
      type: "session.text.ended",
      durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 1, text: "hello" },
    })
    expect(ended[0]).toMatchObject({ properties: { part: { id: "msg_a:text:1", text: "hello", time: { start: 1000, end: 1000 } } } })
  })

  test("tool calls: pending while streaming input, running once called, then a success transition", () => {
    const pending = translateWireEvent({
      ...base,
      type: "session.tool.input.started",
      durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", name: "bash" },
    })
    expect(pending[0]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { id: "call_1", type: "tool", tool: "bash", callID: "call_1", state: { status: "pending", raw: "" } } },
    })
    const rawDelta = translateWireEvent({
      ...base,
      type: "session.tool.input.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", delta: '{"c' },
    })
    expect(rawDelta[0]).toMatchObject({ type: "message.part.delta", properties: { partID: "call_1", field: "raw", delta: '{"c' } })

    const called = translateWireEvent({
      ...base,
      type: "session.tool.called",
      durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", input: { command: "ls" }, executed: true },
    })
    expect(called).toEqual([
      {
        type: "message.tool.transition",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_a",
          partID: "call_1",
          transition: { kind: "called", input: { command: "ls" }, executed: true, start: 1000 },
        },
      },
    ])

    const success = translateWireEvent({
      ...base,
      type: "session.tool.success",
      durable: { ...durable, version: 2 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_1",
        content: [{ type: "text", text: "a" }, { type: "file", uri: "file:///x.png", mime: "image/png" }],
        metadata: { exit: 0 },
        executed: true,
      },
    })
    expect(success).toEqual([
      {
        type: "message.tool.transition",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_a",
          partID: "call_1",
          transition: {
            kind: "success",
            output: "a",
            attachments: [{ id: "call_1:file:0", sessionID: "ses_1", messageID: "msg_a", type: "file", mime: "image/png", url: "file:///x.png" }],
            metadata: { exit: 0 },
            executed: true,
            end: 1000,
          },
        },
      },
    ])
  })

  test("permissions and forms keep their request payloads", () => {
    const asked = translateWireEvent({
      ...base,
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["rm"], metadata: { command: "rm -rf" } },
    })
    expect(asked).toEqual([{ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["rm"], metadata: { command: "rm -rf" } } }])
    const form = translateWireEvent({
      ...base,
      type: "form.created",
      data: { form: { id: "form_1", sessionID: "ses_1", title: "Pick", fields: [{ key: "a", type: "boolean" }] } },
    })
    expect(form[0]).toMatchObject({ type: "form.created", properties: { form: { id: "form_1" } } })
    const settled = translateWireEvent({ ...base, type: "form.cancelled", data: { id: "form_1", sessionID: "ses_1" } })
    expect(settled).toEqual([{ type: "form.settled", properties: { sessionID: "ses_1", formID: "form_1" } }])
  })

  test("catalog rebuilds name the list that has to be re-read", () => {
    const kinds: Array<[OpenCodeEvent, string]> = [
      [{ ...base, type: "config.updated", data: {} }, "config"],
      [{ ...base, type: "agent.updated", data: {} }, "agent"],
      [{ ...base, type: "command.updated", data: {} }, "command"],
      [{ ...base, type: "skill.updated", data: {} }, "skill"],
      [{ ...base, type: "plugin.updated", data: {} }, "plugin"],
      [{ ...base, type: "credential.updated", data: {} }, "credential"],
      [{ ...base, type: "credential.switched", data: { integrationID: "openai", credentialID: null } }, "credential"],
      [
        { ...base, type: "project.updated", data: { id: "proj", canonical: "/repo", time: { created: 1, updated: 1, active: 1 }, sandboxes: [] } },
        "project",
      ],
      [{ ...base, type: "websearch.updated", data: {} }, "websearch"],
    ]
    for (const [event, kind] of kinds) {
      expect(translateWireEvent(event)).toEqual([{ type: "catalog.updated", properties: { kind } }])
    }
  })

  test("the provider and model announcements re-read the model list", () => {
    // 2.0.8 replaced the `catalog.updated` storm with these two, which OpenCode
    // publishes only when the list they name actually changed.
    expect(translateWireEvent({ ...base, type: "provider.updated", data: {} })).toEqual([
      { type: "catalog.updated", properties: { kind: "provider" } },
    ])
    expect(translateWireEvent({ ...base, type: "model.updated", data: {} })).toEqual([
      { type: "catalog.updated", properties: { kind: "model" } },
    ])
  })

  test("a location shutdown asks the sync layer to revalidate that directory", () => {
    expect(translateWireEvent({ ...base, type: "location.shutdown", data: {} })).toEqual([
      { type: "location.shutdown", properties: {} },
    ])
  })

  test("skill activation appears in the transcript live", () => {
    expect(
      translateWireEvent({
        ...base,
        type: "session.skill.activated",
        durable,
        data: { sessionID: "ses_1", id: "skill_1", name: "research", text: "Researching" },
      }),
    ).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "skill",
            time: { created: 1000 },
            skill: "skill_1",
            name: "research",
            text: "Researching",
          },
        },
      },
    ])
  })

  test("mcp status changes stay their own event", () => {
    expect(translateWireEvent({ ...base, type: "mcp.status.changed", data: { server: "filesystem" } }))
      .toEqual([{ type: "mcp.status.changed", properties: { server: "filesystem" } }])
  })

  test("events the sync layer does not model translate to nothing", () => {
    const ignored: OpenCodeEvent[] = [
      { ...base, type: "session.inbox.delivery.changed", durable, data: { sessionID: "ses_1", inboxID: "in_1", delivery: "queue" } },
      { ...base, type: "tui.toast.show", data: { message: "x", variant: "info" } },
      { ...base, type: "integration.updated", data: {} },
      { ...base, type: "filesystem.changed", data: { file: "/repo/a.ts", event: "change" } },
      { ...base, type: "worktree.updated", data: { projectID: "proj" } },
    ]
    for (const event of ignored) expect(translateWireEvent(event)).toEqual([])
  })
})

describe("routing helpers", () => {
  test("routeWireEvent tags events with the wire location, else global", () => {
    const routed = routeWireEvent({ ...base, type: "session.idle", data: { sessionID: "ses_1" } })
    expect(routed).toEqual([{ directory: "/repo", event: { type: "session.idle", properties: { sessionID: "ses_1" } } }])
    const global = routeWireEvent({ id: "evt_2", type: "server.connected", data: {} })
    expect(global[0].directory).toBe("global")
  })

  test("session and message ids can be read off any translated event", () => {
    const [created] = translateWireEvent({
      ...base,
      type: "session.text.started",
      durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 },
    })
    expect(syncEventSessionID(created)).toBe("ses_1")
    expect(syncEventMessageID(created)).toBe("msg_a")
    expect(messageIdFromEvent("evt_abc")).toBe("msg_abc")
  })
})
