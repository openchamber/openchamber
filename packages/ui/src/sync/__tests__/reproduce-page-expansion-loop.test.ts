/**
 * Reproduction test for issue #2084
 *
 * Verifies that the page-expansion loop in use-sync.ts causes multiple
 * sequential round-trips when loading long sessions (200+ messages) whose
 * most recent messages are all assistant/tool responses.
 *
 * The bug: INITIAL_MESSAGE_PAGE_SIZE = 50. If none of the first 50 messages
 * is a user message, the code expands sequentially: 50 -> 100 -> 150 (hard cap).
 * Each expansion is a separate HTTP round-trip. For a 200-message session
 * where the first user message is beyond the most recent 150 messages,
 * this means 3 sequential round-trips before the chat can render.
 *
 * Additionally:
 * - HISTORY_MESSAGE_PAGE_SIZE = 100 prepend fetch fires after initial page
 * - The `renderable` gate requires EVERY assistant message to have parts
 */

import { describe, test, expect } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getSessionMaterializationStatus } from "../materialization"

// ============================================================
// Constants replicated from use-sync.ts for test isolation
// ============================================================
const INITIAL_MESSAGE_PAGE_SIZE = 50
const INITIAL_PAGE_EXPANSION_LIMITS = [100, 150] as const

function isUserMessage(message: Message): boolean {
  const info = message as Message & { clientRole?: unknown; role?: unknown }
  const role = typeof info.clientRole === "string" ? info.clientRole : info.role
  return role === "user"
}

function hasUserMessage(messages: Message[] | undefined): boolean {
  return Boolean(messages?.some(isUserMessage))
}

/** Create a minimal message-like object for testing */
function makeMsg(id: string, role: "user" | "assistant" | "tool"): Message {
  return { id, role, sessionID: "ses_1", time: { created: 1 } } as unknown as Message
}

/**
 * Simulates what loadMessages() does: fetches a page from the tail,
 * checks for user message, expands if needed.
 *
 * The API returns messages sorted by ID ascending, so index 0 = oldest.
 * An INITIAL fetch (no `before` cursor) returns the most recent `limit`
 * messages (the tail).
 */
function simulatePageExpansion(
  messageCount: number,
  userMsgIndexFromEnd: number, // 0 = user is the very latest message
): { roundTrips: number; finalLimit: number; foundUser: boolean } {
  let roundTrips = 0
  let limit = INITIAL_MESSAGE_PAGE_SIZE
  let foundUser = false
  let complete = false

  // Initial fetch
  roundTrips++
  let page = buildPage(messageCount, limit, userMsgIndexFromEnd)
  foundUser = hasUserMessage(page)
  complete = limit >= messageCount

  // Expansion loop — replicates use-sync.ts lines 360-366
  if (!complete && !foundUser) {
    for (const nextLimit of INITIAL_PAGE_EXPANSION_LIMITS) {
      if (nextLimit <= limit) continue
      roundTrips++
      limit = nextLimit
      page = buildPage(messageCount, limit, userMsgIndexFromEnd)
      foundUser = hasUserMessage(page)
      complete = limit >= messageCount
      if (complete || foundUser) break
    }
  }

  return { roundTrips, finalLimit: limit, foundUser }
}

/**
 * Build a page of `limit` messages from the tail of a session with
 * `messageCount` total messages. A single user message is placed at
 * `userMsgRelativeIndex` positions from the end (0 = latest).
 *
 * Example: messageCount=200, limit=50, userMsgIndexFromEnd=55
 *   Fetches messages at indices 150-199 (the tail)
 *   The user message would be at index 200-55-1 = 144 (not in this page)
 */
function buildPage(
  messageCount: number,
  limit: number,
  userMsgIndexFromEnd: number,
): Message[] {
  const userAbsoluteIndex = messageCount - userMsgIndexFromEnd - 1
  const startIndex = Math.max(0, messageCount - limit)
  const msgs: Message[] = []

  for (let i = startIndex; i < messageCount; i++) {
    const role: "user" | "assistant" =
      i === userAbsoluteIndex ? "user" : "assistant"
    msgs.push(makeMsg(String(i).padStart(10, "0"), role))
  }

  return msgs
}

// ============================================================
// Test 1: Page expansion adds unnecessary round-trips
// ============================================================

describe("page expansion loop (#2084)", () => {
  test("needs 3 round-trips when user message is deep (index 160 from end)", () => {
    // 200-msg session where the first user message is 160 from the end
    // Initial (limit=50): indices 150-199 -> no user
    // Expand to 100:      indices 100-199 -> no user
    // Expand to 150:      indices 50-199  -> no user (hard cap)
    const result = simulatePageExpansion(200, 160)
    expect(result.roundTrips).toBe(3)
    expect(result.foundUser).toBe(false)
  })

  test("needs 2 round-trips when user message is 55th from end", () => {
    // Initial (limit=50):  indices 150-199 -> no user
    // Expand to 100:       indices 100-199 -> user found
    const result = simulatePageExpansion(200, 55)
    expect(result.roundTrips).toBe(2)
    expect(result.foundUser).toBe(true)
  })

  test("needs 1 round-trip when user message is in the initial 50", () => {
    // User is within the most recent 50 messages
    const result = simulatePageExpansion(200, 30)
    expect(result.roundTrips).toBe(1)
    expect(result.foundUser).toBe(true)
  })

  test("needs 1 round-trip when session is small enough to complete in one fetch", () => {
    // Session with only 40 messages
    const result = simulatePageExpansion(40, 10)
    expect(result.roundTrips).toBe(1)
    expect(result.foundUser).toBe(true)
  })

  test("even with expansion, user may not be found if beyond hard cap of 150", () => {
    // 300-msg session where user is 200 from end
    // Initial 50:  -> no user
    // Expand 100:  -> no user
    // Expand 150:  -> no user (hard cap, user at index 99, but we fetched from 150-299)
    const result = simulatePageExpansion(300, 200)
    expect(result.roundTrips).toBe(3)
    expect(result.foundUser).toBe(false)
  })
})

// ============================================================
// Test 2: renderable gate — requires ALL assistant messages to have parts
// ============================================================

describe("renderable gate (#2084)", () => {
  test("shows renderable=false when assistant messages lack parts", () => {
    const messages: Message[] = [
      makeMsg("001", "user"),
      makeMsg("002", "assistant"),
      makeMsg("003", "user"),
      makeMsg("004", "assistant"),
    ]

    // No parts loaded yet
    const status = getSessionMaterializationStatus(
      { message: { "session-1": messages }, part: {} },
      "session-1",
    )
    expect(status.renderable).toBe(false)
    expect(status.missingPartMessageIDs).toContain("002")
    expect(status.missingPartMessageIDs).toContain("004")

    // After parts arrive for ALL assistant messages
    const statusWithParts = getSessionMaterializationStatus(
      {
        message: { "session-1": messages },
        part: {
          "002": [{ id: "part-1", type: "text", text: "hello" } as unknown as Part],
          "004": [{ id: "part-2", type: "text", text: "world" } as unknown as Part],
        },
      },
      "session-1",
    )
    expect(statusWithParts.renderable).toBe(true)
    expect(statusWithParts.missingPartMessageIDs).toEqual([])
  })

  test("keeps renderable=false when even one assistant message lacks parts", () => {
    const messages: Message[] = [
      makeMsg("001", "user"),
      makeMsg("002", "assistant"),
      makeMsg("003", "assistant"),
    ]

    const status = getSessionMaterializationStatus(
      {
        message: { "session-1": messages },
        part: {
          "002": [], // Empty parts — still counts as missing
        },
      },
      "session-1",
    )
    expect(status.renderable).toBe(false)
    expect(status.missingPartMessageIDs).toContain("003")
  })
})

// ============================================================
// Test 3: Full chain — expand loop + renderable gate
// ============================================================

describe("full chain: expand loop + renderable gate (#2084)", () => {
  test("simulates the full flow for a 200-msg session with deep user message", () => {
    const TOTAL = 200
    // User message is at absolute index 30 (170th from the end)
    // This means the user is NOT within any of the expanded pages
    // (50, 100, or 150 from tail)
    const userAbsoluteIndex = 30

    // Simulate the tail fetch for each expansion stage
    const attempt = (limit: number) => {
      const msgs: Message[] = []
      for (let i = TOTAL - limit; i < TOTAL; i++) {
        msgs.push(
          makeMsg(
            String(i).padStart(10, "0"),
            i === userAbsoluteIndex ? "user" : "assistant",
          ),
        )
      }
      return { msgs, foundUser: hasUserMessage(msgs) }
    }

    // Initial 50: indices 150-199 -> user not found
    const page50 = attempt(50)
    expect(page50.foundUser).toBe(false)

    // Expand 100: indices 100-199 -> user not found
    const page100 = attempt(100)
    expect(page100.foundUser).toBe(false)

    // Expand 150: indices 50-199 -> user not found (hard cap)
    const page150 = attempt(150)
    expect(page150.foundUser).toBe(false)

    // Even after 3 round-trips, the expanded 150 messages have no user
    // AND the renderable gate also fails because no parts are loaded
    const status = getSessionMaterializationStatus(
      { message: { "session-1": page150.msgs }, part: {} },
      "session-1",
    )
    expect(status.renderable).toBe(false)
    // All 150 assistant messages in the page are missing parts
    expect(status.missingPartMessageIDs.length).toBeGreaterThan(0)
  })
})
