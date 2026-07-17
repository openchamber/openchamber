import { describe, expect, test } from "bun:test"

import {
  CURRENT_LAYOUT_VERSION,
  closeTile,
  createSingleGroup,
  deserialize,
  focusedGroupLeaf,
  migrate,
  moveTileToGroup,
  pruneMissingLeaves,
  reorderWithinGroup,
  serialize,
  setActiveTile,
  setFocusedGroup,
  splitLeaf,
  syncLayoutWithTabs,
  type PanelLayout,
  type SplitBranch,
  type SplitNode,
  type TabGroupLeaf,
} from "./splitTree"

const leaves = (node: SplitNode): TabGroupLeaf[] => {
  switch (node.kind) {
    case "group":
      return [node]
    case "split":
      return node.children.flatMap(leaves)
    default:
      return assertNever(node)
  }
}

const assertNever = (value: never): never => {
  throw new TypeError(`Unexpected node: ${JSON.stringify(value)}`)
}

const assertInvariants = (layout: PanelLayout, tabIds: string[]): void => {
  const visit = (node: SplitNode): void => {
    switch (node.kind) {
      case "group":
        expect(node.tileIds.length).toBeGreaterThan(0)
        expect(node.tileIds).toContain(node.activeTileId)
        for (const tileId of node.tileIds) expect(tabIds).toContain(tileId)
        return
      case "split":
        expect(node.children.length).toBeGreaterThan(1)
        expect(node.sizes).toHaveLength(node.children.length)
        expect(Math.abs(node.sizes.reduce((sum, size) => sum + size, 0) - 1) <= 1e-6).toBe(true)
        node.children.forEach(visit)
        return
      default:
        return assertNever(node)
    }
  }

  visit(layout.root)
  expect(leaves(layout.root).map((leaf) => leaf.id)).toContain(layout.focusedGroupId)
}

const splitTwoGroups = (): PanelLayout =>
  splitLeaf(createSingleGroup(["a", "b", "c"], "a"), "group-1", "c", "right")

describe("split tree", () => {
  test("creates one current-version group", () => {
    const layout = createSingleGroup(["a", "b"], "b")

    expect(layout).toEqual({
      version: CURRENT_LAYOUT_VERSION,
      focusedGroupId: "group-1",
      root: { kind: "group", id: "group-1", tileIds: ["a", "b"], activeTileId: "b" },
    })
  })

  const anchorCases = [
    ["left", "horizontal", ["c", "a"]],
    ["right", "horizontal", ["a", "c"]],
    ["top", "vertical", ["c", "a"]],
    ["bottom", "vertical", ["a", "c"]],
  ] as const

  for (const [anchor, direction, activeTiles] of anchorCases) {
    test(`peels tile at ${anchor} anchor`, () => {
      const input = createSingleGroup(["a", "b", "c"], "a")

      const result = splitLeaf(input, "group-1", "c", anchor)

      expect(result.root.kind).toBe("split")
      if (result.root.kind !== "split") return
      expect(result.root.direction).toBe(direction)
      expect(result.root.children.map((child) => (child.kind === "group" ? child.activeTileId : ""))).toEqual(activeTiles)
      expect(result.focusedGroupId).not.toBe("group-1")
      expect(input.root).toEqual({ kind: "group", id: "group-1", tileIds: ["a", "b", "c"], activeTileId: "a" })
    })
  }

  test("repositions a single-tile source without leaving an empty group", () => {
    const input = splitTwoGroups()
    const target = leaves(input.root)[0]
    const source = leaves(input.root)[1]
    if (!target || !source) throw new TypeError("Expected two groups")

    const result = splitLeaf(input, target.id, source.activeTileId, "left")

    expect(leaves(result.root)).toHaveLength(2)
    expect(leaves(result.root).map((leaf) => leaf.activeTileId)).toEqual(["c", "a"])
    assertInvariants(result, ["a", "b", "c"])
  })

  test("soft cap stacks tile in target instead of creating seventh group", () => {
    let layout = createSingleGroup(["a", "b", "c", "d", "e", "f", "g"], "a")
    for (const tileId of ["b", "c", "d", "e", "f"]) {
      layout = splitLeaf(layout, "group-1", tileId, "right")
    }

    const result = splitLeaf(layout, "group-1", "g", "right")

    expect(leaves(result.root)).toHaveLength(6)
    expect(leaves(result.root).find((leaf) => leaf.id === "group-1")?.tileIds).toEqual(["a", "g"])
    assertInvariants(result, ["a", "b", "c", "d", "e", "f", "g"])
  })

  test("moves tile to indexed target position and collapses empty source", () => {
    const input = splitTwoGroups()
    const [target, source] = leaves(input.root)
    if (!target || !source) throw new TypeError("Expected two groups")

    const result = moveTileToGroup(input, source.activeTileId, target.id, 1)

    expect(result.root).toEqual({ kind: "group", id: target.id, tileIds: ["a", "c", "b"], activeTileId: "c" })
    expect(result.focusedGroupId).toBe(target.id)
  })

  test("reorders tiles within one group", () => {
    const input = createSingleGroup(["a", "b", "c"], "a")

    const result = reorderWithinGroup(input, "group-1", "a", "c")

    expect(result.root).toEqual({ kind: "group", id: "group-1", tileIds: ["b", "c", "a"], activeTileId: "a" })
  })

  test("sets active tile only in owning group", () => {
    const input = createSingleGroup(["a", "b"], "a")

    expect(setActiveTile(input, "b").root).toEqual({ kind: "group", id: "group-1", tileIds: ["a", "b"], activeTileId: "b" })
    expect(setActiveTile(input, "missing")).toBe(input)
  })

  test("sets focus only for real group", () => {
    const input = splitTwoGroups()
    const target = leaves(input.root)[1]
    if (!target) throw new TypeError("Expected target group")

    expect(setFocusedGroup(input, target.id).focusedGroupId).toBe(target.id)
    expect(setFocusedGroup(input, "missing")).toBe(input)
  })

  test("closes active tile and selects next tile", () => {
    const input = createSingleGroup(["a", "b", "c"], "b")

    const result = closeTile(input, "b")

    expect(result?.root).toEqual({ kind: "group", id: "group-1", tileIds: ["a", "c"], activeTileId: "c" })
  })

  test("closing focused group collapses it and focuses first leaf", () => {
    const input = splitTwoGroups()
    const [first, focused] = leaves(input.root)
    if (!first || !focused) throw new TypeError("Expected two groups")
    const focusedInput = setFocusedGroup(input, focused.id)

    const result = closeTile(focusedInput, focused.activeTileId)

    expect(result?.root).toEqual(first)
    expect(result?.focusedGroupId).toBe(first.id)
  })

  test("closing final tile returns null", () => {
    expect(closeTile(createSingleGroup(["a"], "a"), "a")).toBeNull()
  })

  test("prunes missing tiles and collapses emptied groups", () => {
    const input = splitTwoGroups()

    const result = pruneMissingLeaves(input, ["c"])

    expect(result?.root).toEqual({ kind: "group", id: "group-1", tileIds: ["a", "b"], activeTileId: "a" })
    expect(pruneMissingLeaves(input, ["a", "b", "c"])).toBeNull()
  })

  test("sync removes stale tiles and appends new tabs to requested focus", () => {
    const input = splitTwoGroups()
    const target = leaves(input.root)[1]
    if (!target) throw new TypeError("Expected target group")

    const result = syncLayoutWithTabs(input, ["a", "c", "d"], target.id)

    expect(leaves(result.root).map((leaf) => leaf.tileIds)).toEqual([["a"], ["c", "d"]])
    expect(result.focusedGroupId).toBe(target.id)
    assertInvariants(result, ["a", "c", "d"])
  })

  test("migrates absent, legacy, malformed, version-mismatched, and invalid layouts", () => {
    const valid = splitTwoGroups()
    const cases: unknown[] = [
      undefined,
      { tabs: ["legacy"] },
      { version: CURRENT_LAYOUT_VERSION, root: { kind: "wat" }, focusedGroupId: "group-1" },
      { ...valid, version: CURRENT_LAYOUT_VERSION + 1 },
      { ...valid, focusedGroupId: "missing" },
    ]

    for (const raw of cases) {
      expect(migrate(raw, ["a", "b"])).toEqual(createSingleGroup(["a", "b"], "a"))
    }
  })

  test("migrate accepts valid layout then reconciles tab ids", () => {
    const input = splitTwoGroups()

    const result = migrate(input, ["a", "c", "d"])

    expect(leaves(result.root).map((leaf) => leaf.tileIds)).toEqual([["a"], ["c", "d"]])
    assertInvariants(result, ["a", "c", "d"])
  })

  test("serialize and deserialize round trip valid layout", () => {
    const input = splitTwoGroups()

    expect(deserialize(serialize(input))).toEqual(input)
    expect(deserialize("not-json")).toBeNull()
    expect(deserialize(JSON.stringify({ bad: true }))).toBeNull()
  })

  test("normalizes invalid sizes while preserving valid proportions", () => {
    const input = splitTwoGroups()
    if (input.root.kind !== "split") throw new TypeError("Expected split")

    const equal = migrate({ ...input, root: { ...input.root, sizes: [0, -1] } }, ["a", "b", "c"])
    const proportional = migrate({ ...input, root: { ...input.root, sizes: [2, 6] } }, ["a", "b", "c"])

    expect(equal.root.kind === "split" ? equal.root.sizes : []).toEqual([0.5, 0.5])
    expect(proportional.root.kind === "split" ? proportional.root.sizes : []).toEqual([0.25, 0.75])
    assertInvariants(equal, ["a", "b", "c"])
    assertInvariants(proportional, ["a", "b", "c"])
  })

  test("rejects a non-binary (3-child) persisted split, rebuilding a single group", () => {
    const nonBinary = {
      version: CURRENT_LAYOUT_VERSION,
      focusedGroupId: "group-1",
      root: {
        kind: "split",
        direction: "horizontal",
        sizes: [1 / 3, 1 / 3, 1 / 3],
        children: [
          { kind: "group", id: "group-1", tileIds: ["a"], activeTileId: "a" },
          { kind: "group", id: "group-2", tileIds: ["b"], activeTileId: "b" },
          { kind: "group", id: "group-3", tileIds: ["c"], activeTileId: "c" },
        ],
      },
    }

    expect(deserialize(JSON.stringify(nonBinary))).toBeNull()

    const migrated = migrate(nonBinary, ["a", "b", "c"])
    expect(migrated.root.kind).toBe("group")
    expect(migrated.root.kind === "group" ? migrated.root.tileIds : []).toEqual(["a", "b", "c"])
    assertInvariants(migrated, ["a", "b", "c"])
  })

  test("focusedGroupLeaf resolves the focused group's active tile after a sibling close", () => {
    const split = splitLeaf(createSingleGroup(["a", "b", "c"], "a"), "group-1", "b", "right")
    const focusedOnGroup1 = setFocusedGroup(split, "group-1")

    const closed = closeTile(focusedOnGroup1, "a")
    if (!closed) throw new TypeError("close removed everything unexpectedly")

    const focused = focusedGroupLeaf(closed)
    expect(focused?.tileIds).toContain(focused?.activeTileId)
    expect(focused?.tileIds).toEqual(["c"])
  })

  const asSplit = (node: SplitNode, reason: string): SplitBranch => {
    if (node.kind !== "split") throw new TypeError(reason)
    return node
  }

  // Root split with two NESTED-split children: left [group-1|group-4] stays
  // untouched by ops on group-2/group-3; right [group-2|group-3] is the one ops mutate.
  const nestedFourRegion = (): { layout: PanelLayout; untouchedSplit: SplitNode; changedSplit: SplitNode } => {
    const l1 = splitLeaf(createSingleGroup(["a", "b", "c", "d"], "a"), "group-1", "b", "right")
    const l2 = splitLeaf(l1, "group-2", "c", "bottom")
    const l3 = splitLeaf(l2, "group-1", "d", "right")
    const root = asSplit(l3.root, "expected split root")
    const untouchedSplit = root.children[0]
    const changedSplit = root.children[1]
    if (!untouchedSplit || untouchedSplit.kind !== "split") throw new TypeError("expected nested split as left child")
    if (!changedSplit || changedSplit.kind !== "split") throw new TypeError("expected nested split as right child")
    return { layout: l3, untouchedSplit, changedSplit }
  }

  test("close preserves untouched nested split branch and rebuilds the changed one", () => {
    const { layout, untouchedSplit, changedSplit } = nestedFourRegion()
    const closed = closeTile(layout, "c")
    if (!closed) throw new TypeError("close removed everything unexpectedly")
    const root = asSplit(closed.root, "expected split root")
    expect(root.children[0]).toBe(untouchedSplit)
    expect(root.children[1]).not.toBe(changedSplit)
  })

  test("move preserves untouched nested split branch and rebuilds the changed one", () => {
    const { layout, untouchedSplit, changedSplit } = nestedFourRegion()
    const moved = moveTileToGroup(layout, "c", "group-2")
    const root = asSplit(moved.root, "expected split root")
    expect(root.children[0]).toBe(untouchedSplit)
    expect(root.children[1]).not.toBe(changedSplit)
  })

  test("split preserves untouched nested split branch and rebuilds the changed one", () => {
    const { layout, untouchedSplit, changedSplit } = nestedFourRegion()
    const resplit = splitLeaf(layout, "group-2", "c", "left")
    const root = asSplit(resplit.root, "expected split root")
    expect(root.children[0]).toBe(untouchedSplit)
    expect(root.children[1]).not.toBe(changedSplit)
  })
})
