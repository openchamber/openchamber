import { describe, expect, test } from "bun:test"

import { isSoleTileSourceRegion, mapTileIdsToGroupIds } from "./tileGroupIds"
import { createSingleGroup, splitLeaf } from "./splitTree"

describe("mapTileIdsToGroupIds", () => {
  test("maps every tile to its owning group across a nested split", () => {
    const layout = splitLeaf(createSingleGroup(["a", "b", "c"], "a"), "group-1", "c", "right")
    const map = mapTileIdsToGroupIds(layout.root)
    expect(map.get("a")).toBe("group-1")
    expect(map.get("b")).toBe("group-1")
    expect(map.get("c")).toBe("group-2")
  })
})

describe("isSoleTileSourceRegion", () => {
  test("true when the dragged tile is the region's only tile", () => {
    expect(isSoleTileSourceRegion(["plan"], "plan")).toBe(true)
  })

  test("false when the region has more than one tile (same-region split-off stays valid)", () => {
    expect(isSoleTileSourceRegion(["context", "plan"], "plan")).toBe(false)
  })

  test("false when the dragged tile belongs to a different region", () => {
    expect(isSoleTileSourceRegion(["context"], "plan")).toBe(false)
  })

  test("false when no tile is being dragged", () => {
    expect(isSoleTileSourceRegion(["plan"], null)).toBe(false)
  })
})
