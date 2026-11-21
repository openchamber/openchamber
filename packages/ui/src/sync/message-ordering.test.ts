import { describe, expect, test } from "bun:test"
import type { Message } from "@/lib/opencode/model"
import {
  insertMessageInEventOrder,
  messagesBefore,
  messagesFrom,
} from "./message-ordering"

const message = (id: string, created: number): Message => ({
  id,
  sessionID: "session-a",
  role: "user",
  time: { created },
})

const context = (id: string, created: number): Message => ({
  id,
  sessionID: "session-a",
  role: "synthetic",
  time: { created },
  text: "ctx",
})

describe("message chronology", () => {
  test("appends post-rollover IDs in event order", () => {
    const legacy = message("msg_ffffffffffffLegacy", 100)
    const current = message("msg_000000000000Current", 200)

    const messages = [legacy]
    insertMessageInEventOrder(messages, current)
    expect(messages).toEqual([legacy, current])
  })

  test("keeps arrival order despite clock skew or equal timestamps", () => {
    const second = message("msg_b", 100)
    const first = message("msg_a", 100)
    const skewed = message("msg_future", 50_000)
    const messages = [skewed, second]
    insertMessageInEventOrder(messages, first)
    expect(messages).toEqual([skewed, second, first])
  })

  test("puts context that shares the prompt's millisecond before the prompt", () => {
    // Real records: the prompt id is minted on the client before the server
    // admits its context, so every context id sorts after the prompt's.
    const prompt = message("msg_0e9dc5bf3001QxTq3rvK2OQgcE", 52)
    const earlierContext = context("msg_0e9dc5c52001runEUuNdAOJEFu", 51)
    const sameMsContext = context("msg_0e9dc5c570010BvEsKh7unRZV5", 52)

    const messages = [earlierContext, prompt]
    insertMessageInEventOrder(messages, sameMsContext)
    expect(messages).toEqual([earlierContext, sameMsContext, prompt])
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
