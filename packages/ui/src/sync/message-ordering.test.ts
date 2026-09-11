import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  insertMessageChronologically,
  messagesBefore,
  messagesFrom,
  sortMessagesChronologically,
} from "./message-ordering"

const message = (id: string, created: number): Message => ({
  id,
  sessionID: "session-a",
  role: "user",
  time: { created },
} as Message)

describe("message chronology", () => {
  test("orders post-rollover IDs after legacy IDs by creation time", () => {
    const legacy = message("msg_ffffffffffffLegacy", 100)
    const current = message("msg_000000000000Current", 200)

    expect(sortMessagesChronologically([current, legacy])).toEqual([legacy, current])

    const messages = [legacy]
    insertMessageChronologically(messages, current)
    expect(messages).toEqual([legacy, current])
  })

  test("uses ID only as a deterministic equal-time tie breaker", () => {
    const second = message("msg_b", 100)
    const first = message("msg_a", 100)
    expect(sortMessagesChronologically([second, first])).toEqual([first, second])

    const messages = [second]
    insertMessageChronologically(messages, first)
    expect(messages).toEqual([first, second])
  })

  test("splits a revert branch by marker position instead of ID value", () => {
    const before = message("msg_ffffBefore", 100)
    const marker = message("msg_0000Marker", 200)
    const after = message("msg_0001After", 300)
    const messages = [before, marker, after]

    expect(messagesBefore(messages, marker.id)).toEqual([before])
    expect(messagesFrom(messages, marker.id)).toEqual([marker, after])
  })

  test("does not destructively split when the marker is not materialized", () => {
    const messages = [message("msg_a", 100)]
    expect(messagesBefore(messages, "missing")).toBe(messages)
    expect(messagesFrom(messages, "missing")).toEqual([])
  })
})
