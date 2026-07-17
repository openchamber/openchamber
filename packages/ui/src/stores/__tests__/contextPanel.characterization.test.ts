/**
 * Characterization baseline for the single-active-tab Side Panel (ContextPanel).
 *
 * Wave-1 T1 for the "Tiled Side Panel" feature: these tests PIN today's
 * `useUIStore` Side Panel action semantics BEFORE any tiling refactor. They
 * assert observable invariants only (not implementation), so they must stay
 * GREEN through every later wave (T5 store, T7 render, T10 lifecycle) as proof
 * that the non-tiling single-tab UX is unchanged.
 *
 * DO NOT relax these to make a later change pass. A failure here means the
 * single-tab Side Panel behavior regressed.
 */
import { beforeEach, describe, expect, test } from "bun:test"

import { useUIStore } from "../useUIStore"

const DIR = "/baseline/project"

// Throws on missing state so the return type is non-undefined for assertions.
const panel = (directory: string = DIR) => {
  const state = useUIStore.getState().contextPanelByDirectory[directory]
  if (!state) {
    throw new Error(`expected a ContextPanel state for ${directory}`)
  }
  return state
}

beforeEach(() => {
  // Isolate every test: wipe only the Side Panel slice, leave the rest intact.
  useUIStore.setState({ contextPanelByDirectory: {} })
})

describe("ContextPanel characterization (single-active-tab baseline)", () => {
  describe("openContextPanelTab", () => {
    test("opening a tab adds it, opens the panel, and makes it active", () => {
      useUIStore.getState().openContextPanelTab(DIR, { mode: "context" })

      const state = panel()
      expect(state.isOpen).toBe(true)
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].mode).toBe("context")
      expect(state.tabs[0].id).toBe("context")
      expect(state.activeTabId).toBe("context")
    })

    test("a path-keyed tab derives a stable composite id (mode:targetPath)", () => {
      useUIStore.getState().openContextPanelTab(DIR, { mode: "file", targetPath: "src/a.ts" })

      const state = panel()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].id).toBe("file:src/a.ts")
      expect(state.tabs[0].targetPath).toBe("src/a.ts")
      expect(state.activeTabId).toBe("file:src/a.ts")
    })

    test("opening a duplicate dedupeKey does not add a second tab", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "file", targetPath: "src/a.ts" })
      store.openContextPanelTab(DIR, { mode: "file", targetPath: "src/a.ts" })

      const state = panel()
      expect(state.tabs).toHaveLength(1)
      expect(state.activeTabId).toBe("file:src/a.ts")
    })

    test("diff tabs dedupe by mode only, collapsing distinct files into one tab", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "diff", targetPath: "src/a.ts" })
      store.openContextPanelTab(DIR, { mode: "diff", targetPath: "src/b.ts" })

      const state = panel()
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].id).toBe("diff")
      expect(state.tabs[0].targetPath).toBe("src/b.ts")
      expect(state.activeTabId).toBe("diff")
    })

    test("re-opening a diff for the same path reuses its tab (path-keyed)", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "diff", targetPath: "src/a.ts" })
      store.openContextPanelTab(DIR, { mode: "diff", targetPath: "src/a.ts", dedupeKey: "staged" })

      const state = panel()
      expect(state.tabs.map((t) => t.id)).toEqual(["diff"])
      expect(state.activeTabId).toBe("diff")
    })

    test("distinct tabs accumulate and the newest becomes active", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })

      const state = panel()
      expect(state.tabs.map((t) => t.id)).toEqual(["context", "plan"])
      expect(state.activeTabId).toBe("plan")
      expect(state.isOpen).toBe(true)
    })

    test("blank directory is a no-op", () => {
      useUIStore.getState().openContextPanelTab("   ", { mode: "context" })
      expect(useUIStore.getState().contextPanelByDirectory).toEqual({})
    })
  })

  describe("setActiveContextPanelTab", () => {
    test("switching active tab updates activeTabId and keeps the panel open", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })

      store.setActiveContextPanelTab(DIR, "context")

      const state = panel()
      expect(state.activeTabId).toBe("context")
      expect(state.isOpen).toBe(true)
      expect(state.tabs).toHaveLength(2)
    })

    test("activating an unknown tab id is a no-op", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })

      store.setActiveContextPanelTab(DIR, "does-not-exist")

      expect(panel().activeTabId).toBe("context")
    })

    test("re-activates the panel after it was closed (isOpen back to true)", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })
      store.closeContextPanel(DIR)
      expect(panel().isOpen).toBe(false)

      store.setActiveContextPanelTab(DIR, "context")

      const state = panel()
      expect(state.isOpen).toBe(true)
      expect(state.activeTabId).toBe("context")
    })
  })

  describe("reorderContextPanelTabs", () => {
    test("moves a tab to another tab's position", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })
      store.openContextPanelTab(DIR, { mode: "file", targetPath: "x.ts" })
      expect(panel().tabs.map((t) => t.id)).toEqual(["context", "plan", "file:x.ts"])

      store.reorderContextPanelTabs(DIR, "context", "file:x.ts")

      expect(panel().tabs.map((t) => t.id)).toEqual(["plan", "file:x.ts", "context"])
    })

    test("reordering with an unknown tab id leaves order untouched", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })

      store.reorderContextPanelTabs(DIR, "context", "nope")

      expect(panel().tabs.map((t) => t.id)).toEqual(["context", "plan"])
    })
  })

  describe("closeContextPanelTab", () => {
    test("closing the last tab closes the panel", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })

      store.closeContextPanelTab(DIR, "context")

      const state = panel()
      expect(state.tabs).toHaveLength(0)
      expect(state.isOpen).toBe(false)
      expect(state.activeTabId).toBeNull()
    })

    test("closing the active tab keeps the panel open and reassigns active", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })
      expect(panel().activeTabId).toBe("plan")

      store.closeContextPanelTab(DIR, "plan")

      const state = panel()
      expect(state.tabs.map((t) => t.id)).toEqual(["context"])
      expect(state.isOpen).toBe(true)
      expect(state.activeTabId).toBe("context")
    })

    test("closing a non-active tab preserves the active tab", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })

      store.closeContextPanelTab(DIR, "context")

      const state = panel()
      expect(state.tabs.map((t) => t.id)).toEqual(["plan"])
      expect(state.activeTabId).toBe("plan")
      expect(state.isOpen).toBe(true)
    })
  })

  describe("closeContextPanel", () => {
    test("hides the panel but preserves tabs and active selection", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      store.openContextPanelTab(DIR, { mode: "plan" })

      store.closeContextPanel(DIR)

      const state = panel()
      expect(state.isOpen).toBe(false)
      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabId).toBe("plan")
    })
  })

  describe("toggleContextPanelExpanded", () => {
    test("flips the expanded flag on each call", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })
      expect(panel().expanded).toBe(false)

      store.toggleContextPanelExpanded(DIR)
      expect(panel().expanded).toBe(true)

      store.toggleContextPanelExpanded(DIR)
      expect(panel().expanded).toBe(false)
    })
  })

  describe("setContextPanelWidth", () => {
    test("clamps below the minimum up to 380", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })

      store.setContextPanelWidth(DIR, 100)

      expect(panel().width).toBe(380)
    })

    test("clamps above the maximum down to 1400", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })

      store.setContextPanelWidth(DIR, 5000)

      expect(panel().width).toBe(1400)
    })

    test("keeps and rounds an in-range width", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })

      store.setContextPanelWidth(DIR, 640.6)

      expect(panel().width).toBe(641)
    })

    test("non-finite width falls back to the default 380", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab(DIR, { mode: "context" })

      store.setContextPanelWidth(DIR, Number.NaN)

      expect(panel().width).toBe(380)
    })
  })

  describe("per-directory isolation", () => {
    test("panels are keyed by directory and do not bleed across directories", () => {
      const store = useUIStore.getState()
      store.openContextPanelTab("/dir/a", { mode: "context" })
      store.openContextPanelTab("/dir/b", { mode: "plan" })

      expect(panel("/dir/a").tabs.map((t) => t.id)).toEqual(["context"])
      expect(panel("/dir/b").tabs.map((t) => t.id)).toEqual(["plan"])
      expect(panel("/dir/a").activeTabId).toBe("context")
      expect(panel("/dir/b").activeTabId).toBe("plan")
    })
  })
})
