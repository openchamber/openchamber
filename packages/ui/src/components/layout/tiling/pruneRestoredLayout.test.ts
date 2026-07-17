import { describe, expect, test } from "bun:test"

import { classifySessionExistence } from "./classifySessionExistence"
import { pruneRestoredLayout } from "./pruneRestoredLayout"
import { createSingleGroup, splitLeaf } from "./splitTree"

const FILE_TILE_ID = "file:src/main.ts"
const SESSION_TILE_ID = "chat:session:ses_missing"

const splitSessionLayout = () =>
  splitLeaf(
    createSingleGroup([FILE_TILE_ID, SESSION_TILE_ID], FILE_TILE_ID),
    "group-1",
    SESSION_TILE_ID,
    "right",
  )

describe("pruneRestoredLayout", () => {
  test("prunes confirmed-missing session tile and collapses emptied group", () => {
    const layout = splitSessionLayout()

    const result = pruneRestoredLayout(layout, { [SESSION_TILE_ID]: "missing" })

    expect(result?.root).toEqual({
      kind: "group",
      id: "group-1",
      tileIds: [FILE_TILE_ID],
      activeTileId: FILE_TILE_ID,
    })
  })

  test("keeps session tile when existence fetch failed transiently", () => {
    const layout = splitSessionLayout()

    const result = pruneRestoredLayout(layout, { [SESSION_TILE_ID]: "unknown-fetch-failed" })

    expect(result).toBe(layout)
  })

  test("keeps present session tile", () => {
    const layout = splitSessionLayout()

    const result = pruneRestoredLayout(layout, { [SESSION_TILE_ID]: "present" })

    expect(result).toBe(layout)
  })

  test("leaves non-session tile untouched", () => {
    const layout = createSingleGroup([FILE_TILE_ID], FILE_TILE_ID)

    const result = pruneRestoredLayout(layout, {})

    expect(result).toBe(layout)
  })

  test("returns null when pruning empties final group", () => {
    const layout = createSingleGroup([SESSION_TILE_ID], SESSION_TILE_ID)

    const result = pruneRestoredLayout(layout, { [SESSION_TILE_ID]: "missing" })

    expect(result).toBeNull()
  })
})

describe("classifySessionExistence", () => {
  test("classifies successful session-list membership as present or missing", async () => {
    const result = await classifySessionExistence(
      ["ses_present", "ses_missing"],
      async () => ["ses_present"],
    )

    expect(result).toEqual({
      ses_present: "present",
      ses_missing: "missing",
    })
  })

  test("classifies every session as unknown when whole batch fetch fails", async () => {
    const layout = createSingleGroup([SESSION_TILE_ID], SESSION_TILE_ID)
    const result = await classifySessionExistence(["ses_missing"], async () => {
      throw new TypeError("network offline")
    })

    expect(result).toEqual({ ses_missing: "unknown-fetch-failed" })
    expect(pruneRestoredLayout(layout, { [SESSION_TILE_ID]: result.ses_missing })).toBe(layout)
  })
})
