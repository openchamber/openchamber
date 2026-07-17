import { describe, expect, test } from "bun:test"

import { resolveTileDrop } from "./resolveTileDrop"

describe("resolveTileDrop", () => {
  test("anchor drop peels into a split with the anchor's side (right -> horizontal branch)", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "anchor", groupId: "group-1", anchor: "right" },
      }),
    ).toEqual({ kind: "split", groupId: "group-1", anchor: "right" })
  })

  test("anchor drop bottom -> split bottom (vertical branch)", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "anchor", groupId: "group-2", anchor: "bottom" },
      }),
    ).toEqual({ kind: "split", groupId: "group-2", anchor: "bottom" })
  })

  test("strip drop on ANOTHER group moves the tile (append)", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "strip", groupId: "group-2" },
      }),
    ).toEqual({ kind: "move", groupId: "group-2" })
  })

  test("strip drop on the SAME group is a no-op (null)", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "strip", groupId: "group-1" },
      }),
    ).toBeNull()
  })

  test("tab drop within the SAME strip reorders", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "tab", groupId: "group-1", tileId: "tile-b", index: 1 },
      }),
    ).toEqual({ kind: "reorder", groupId: "group-1", overTileId: "tile-b" })
  })

  test("tab drop onto a tab in ANOTHER group moves at that tab's index", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "tab", groupId: "group-2", tileId: "tile-c", index: 0 },
      }),
    ).toEqual({ kind: "move", groupId: "group-2", index: 0 })
  })

  test("dropping onto itself is null", () => {
    expect(
      resolveTileDrop({
        activeTileId: "tile-a",
        activeGroupId: "group-1",
        over: { kind: "tab", groupId: "group-1", tileId: "tile-a", index: 0 },
      }),
    ).toBeNull()
  })

  test("dropping over nothing is null", () => {
    expect(
      resolveTileDrop({ activeTileId: "tile-a", activeGroupId: "group-1", over: null }),
    ).toBeNull()
  })
})
