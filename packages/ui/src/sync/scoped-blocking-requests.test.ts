import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"

import {
  areRequestArraysReferentiallyEqual,
  collectScopedBlockingRequests,
} from "./scoped-blocking-requests"

const session = (id: string, parentID?: string): Session => ({ id, parentID }) as Session

describe("scoped blocking requests", () => {
  test("collects requests for the current session subtree", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const grandchildRequest = { id: "perm_grandchild" }
    const siblingRequest = { id: "perm_sibling" }
    const empty: Array<typeof rootRequest> = []

    const result = collectScopedBlockingRequests(
      [
        session("ses_root"),
        session("ses_child", "ses_root"),
        session("ses_grandchild", "ses_child"),
        session("ses_sibling"),
      ],
      {
        ses_root: [rootRequest],
        ses_child: [childRequest],
        ses_grandchild: [grandchildRequest],
        ses_sibling: [siblingRequest],
      },
      "ses_root",
      empty,
    )

    expect(result).toEqual([rootRequest, childRequest, grandchildRequest])
  })

  test("aggregates subagent permissions onto the parent when the parent has none (#2247)", () => {
    const childRequest = { id: "perm_child" }
    const siblingRequestA = { id: "perm_sibling_a" }
    const siblingRequestB = { id: "perm_sibling_b" }
    const empty: Array<{ id: string }> = []

    const result = collectScopedBlockingRequests(
      [
        session("ses_parent"),
        session("ses_child", "ses_parent"),
        session("ses_sibling", "ses_parent"),
      ],
      {
        // Parent has no pending permission of its own; only the subagents do.
        ses_child: [childRequest],
        ses_sibling: [siblingRequestA, siblingRequestB],
      },
      "ses_parent",
      empty,
    )

    expect(result).toEqual([childRequest, siblingRequestA, siblingRequestB])
  })

  test("returns the provided empty array when no scoped requests exist", () => {
    const empty: Array<{ id: string }> = []

    expect(collectScopedBlockingRequests([session("ses_root")], {}, "ses_root", empty)).toBe(empty)
    expect(collectScopedBlockingRequests([session("ses_root")], {}, null, empty)).toBe(empty)
  })

  test("compares request arrays by item identity", () => {
    const first = { id: "perm_1" }
    const second = { id: "perm_2" }

    expect(areRequestArraysReferentiallyEqual([first, second], [first, second])).toBe(true)
    expect(areRequestArraysReferentiallyEqual([first, second], [second, first])).toBe(false)
    expect(areRequestArraysReferentiallyEqual([first], [{ id: "perm_1" }])).toBe(false)
  })
})
