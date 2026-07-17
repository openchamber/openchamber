import { beforeEach, describe, expect, test } from "bun:test"

import {
  createSingleGroup,
  splitLeaf,
  type PanelLayout,
  type SplitNode,
  type TabGroupLeaf,
} from "../../components/layout/tiling/splitTree"
import { useUIStore } from "../useUIStore"

const DIR = "/layout/project"

// Seeds go through the store's own persist storage so the deferred layer sees them
// in pendingWrites, which rehydrate reads before the backing store.
const persistStorage = () => useUIStore.persist.getOptions().storage

const panel = () => {
  const state = useUIStore.getState().contextPanelByDirectory[DIR]
  if (!state) throw new Error(`expected ContextPanel state for ${DIR}`)
  return state
}

const groups = (node: SplitNode): TabGroupLeaf[] => {
  switch (node.kind) {
    case "group":
      return [node]
    case "split":
      return node.children.flatMap(groups)
  }
}

const layout = (): PanelLayout => {
  const value = panel().layout
  if (!value) throw new Error("expected panel layout")
  return value
}

const openSplitPanel = () => {
  const store = useUIStore.getState()
  store.openContextPanelTab(DIR, { mode: "context" })
  store.openContextPanelTab(DIR, { mode: "plan" })
  const split = splitLeaf(createSingleGroup(["context", "plan"], "plan"), "group-1", "plan", "right")
  useUIStore.setState((state) => ({
    contextPanelByDirectory: {
      ...state.contextPanelByDirectory,
      [DIR]: { ...panel(), layout: split },
    },
  }))
}

const rehydrate = async (entry: Record<string, unknown>) => {
  persistStorage()?.setItem("ui-store", {
    state: { contextPanelByDirectory: { [DIR]: entry } },
    version: 9,
  } as Parameters<NonNullable<ReturnType<typeof persistStorage>>["setItem"]>[1])
  await useUIStore.persist.rehydrate()
}

beforeEach(() => {
  persistStorage()?.removeItem("ui-store")
  useUIStore.setState({ contextPanelByDirectory: {} })
})

describe("ContextPanel split-tree layout", () => {
  test("open adds tab to focused group without splitting", () => {
    openSplitPanel()

    useUIStore.getState().openContextPanelTab(DIR, { mode: "file", targetPath: "src/a.ts" })

    expect(groups(layout().root).map((group) => group.tileIds)).toEqual([
      ["context"],
      ["plan", "file:src/a.ts"],
    ])
  })

  test("set active tile focuses its owning group", () => {
    openSplitPanel()

    useUIStore.getState().setActiveContextPanelTab(DIR, "context")

    expect(layout().focusedGroupId).toBe("group-1")
    expect(groups(layout().root)[0]?.activeTileId).toBe("context")
  })

  test("re-opening an already-tiled tab focuses its region and activates it (no no-op)", () => {
    openSplitPanel()
    // openSplitPanel leaves group-2 (with plan) focused; context lives in group-1.
    useUIStore.getState().setFocusedContextPanelRegion(DIR, "group-2")
    expect(layout().focusedGroupId).toBe("group-2")

    useUIStore.getState().openContextPanelTab(DIR, { mode: "context" })

    expect(layout().focusedGroupId).toBe("group-1")
    expect(groups(layout().root)[0]?.activeTileId).toBe("context")
    expect(panel().activeTabId).toBe("context")
    expect(panel().tabs.map((tab) => tab.id)).toEqual(["context", "plan"])
  })

  test("setFocusedContextPanelRegion focuses region on body click", () => {
    openSplitPanel()
    expect(layout().focusedGroupId).toBe("group-2")

    useUIStore.getState().setFocusedContextPanelRegion(DIR, "group-1")
    expect(layout().focusedGroupId).toBe("group-1")

    const before = panel()
    useUIStore.getState().setFocusedContextPanelRegion(DIR, "group-1")
    expect(panel()).toBe(before)

    useUIStore.getState().setFocusedContextPanelRegion(DIR, "missing")
    expect(layout().focusedGroupId).toBe("group-1")
  })

  test("close last tile in group collapses split", () => {
    openSplitPanel()

    useUIStore.getState().closeContextPanelTab(DIR, "plan")

    expect(layout().root).toEqual({ kind: "group", id: "group-1", tileIds: ["context"], activeTileId: "context" })
    expect(panel().tabs.map((tab) => tab.id)).toEqual(["context"])
  })

  test("close derives global activeTabId from the focused group's result", () => {
    const store = useUIStore.getState()
    store.openContextPanelTab(DIR, { mode: "context" })
    store.openContextPanelTab(DIR, { mode: "plan" })
    store.openContextPanelTab(DIR, { mode: "file", targetPath: "x.ts" })
    // focused group = [context, file], sibling = [plan]
    const split = splitLeaf(createSingleGroup(["context", "plan", "file:x.ts"], "context"), "group-1", "plan", "right")
    useUIStore.setState((state) => ({
      contextPanelByDirectory: {
        ...state.contextPanelByDirectory,
        [DIR]: { ...panel(), layout: split },
      },
    }))
    useUIStore.getState().setFocusedContextPanelRegion(DIR, "group-1")
    useUIStore.getState().setActiveContextPanelTab(DIR, "file:x.ts")

    useUIStore.getState().closeContextPanelTab(DIR, "file:x.ts")

    const focused = groups(layout().root).find((group) => group.id === layout().focusedGroupId)
    expect(panel().activeTabId).toBe(focused?.activeTileId ?? null)
    expect(panel().activeTabId).toBe("context")
  })

  test("close final tile closes panel and omits layout", () => {
    useUIStore.getState().openContextPanelTab(DIR, { mode: "context" })

    useUIStore.getState().closeContextPanelTab(DIR, "context")

    expect(panel().isOpen).toBe(false)
    expect(panel().tabs).toEqual([])
    expect(panel().layout).toBeFalsy()
  })

  test("reorder updates tabs and owning group order", () => {
    const store = useUIStore.getState()
    store.openContextPanelTab(DIR, { mode: "context" })
    store.openContextPanelTab(DIR, { mode: "plan" })
    store.openContextPanelTab(DIR, { mode: "file", targetPath: "x.ts" })

    store.reorderContextPanelTabs(DIR, "context", "file:x.ts")

    expect(panel().tabs.map((tab) => tab.id)).toEqual(["plan", "file:x.ts", "context"])
    expect(groups(layout().root)[0]?.tileIds).toEqual(["plan", "file:x.ts", "context"])
  })

  test("hydrate legacy entry creates single group", async () => {
    await rehydrate({
      isOpen: true,
      expanded: false,
      tabs: [{ mode: "context" }, { mode: "plan" }],
      activeTabId: "plan",
      width: 500,
      touchedAt: 1,
    })

    expect(groups(layout().root)[0]?.tileIds).toEqual(["context", "plan"])
  })

  test("hydrate malformed layout rebuilds single group", async () => {
    await rehydrate({
      isOpen: true,
      expanded: false,
      tabs: [{ mode: "context" }, { mode: "plan" }],
      activeTabId: "plan",
      width: 500,
      touchedAt: 1,
      layout: { version: 999, root: null, focusedGroupId: "missing" },
    })

    expect(layout().root).toEqual({
      kind: "group",
      id: "group-1",
      tileIds: ["context", "plan"],
      activeTileId: "context",
    })
  })

  test("hydrate empty tabs omits layout and closes panel", async () => {
    await rehydrate({
      isOpen: true,
      expanded: false,
      tabs: [],
      activeTabId: null,
      width: 500,
      touchedAt: 1,
      layout: createSingleGroup(["stale"], "stale"),
    })

    expect(panel().layout).toBeFalsy()
    expect(panel().isOpen).toBe(false)
  })
})
