import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { compareMessages } from "./message-ordering"
import { mergeMessages, mergeOptimisticPage } from "./optimistic"

const WRAP = 1_786_706_395_136

const idAt = (timestamp: number, counter = 1) => {
  const value = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter)
  const bytes = Buffer.alloc(6)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number((value >> BigInt(40 - 8 * index)) & BigInt(0xff))
  }
  return `msg_${bytes.toString("hex")}0000000000000A`
}

const messageAt = (timestamp: number, counter = 1) => ({
  id: idAt(timestamp, counter),
  sessionID: "ses_1",
  role: "user",
  time: { created: timestamp },
}) as Message

describe("message ordering", () => {
  test("orders messages chronologically across an id clock wrap", () => {
    const beforeWrap = messageAt(WRAP - 1)
    const afterWrap = messageAt(WRAP)

    expect(afterWrap.id < beforeWrap.id).toBe(true)
    expect([afterWrap, beforeWrap].sort(compareMessages)).toEqual([beforeWrap, afterWrap])
  })

  test("uses id as the tie-breaker within one millisecond", () => {
    const first = messageAt(WRAP, 1)
    const second = messageAt(WRAP, 2)

    expect([second, first].sort(compareMessages)).toEqual([first, second])
  })

  test("merges history in chronological order across a wrap", () => {
    const older = [messageAt(WRAP - 2), messageAt(WRAP - 1)]
    const newer = [messageAt(WRAP), messageAt(WRAP + 1)]

    expect(mergeMessages(newer, older)).toEqual([...older, ...newer])
  })

  test("places an optimistic post-wrap message after pre-wrap history", () => {
    const beforeWrap = messageAt(WRAP - 1)
    const afterWrap = messageAt(WRAP)

    const merged = mergeOptimisticPage(
      { session: [beforeWrap], part: [], complete: true },
      [{ message: afterWrap, parts: [] }],
    )

    expect(merged.session).toEqual([beforeWrap, afterWrap])
  })
})
