/**
 * Scenario setup shared by the profilers.
 *
 * Idle and streaming cost both depend on how much of the sidebar is mounted,
 * so both commands need the same way to reach a heavily populated sidebar.
 * A capture that needs a specific context-panel surface (the Git panel, for
 * example) seeds it through the same persisted store the app reads on boot.
 * Setup always runs before the measured window.
 */

import { evaluateValue, wait } from "./cdp.mjs"

/**
 * Expands every project. The sidebar persists the ids of collapsed projects,
 * so an empty list expands everything. Requires a reload to take effect.
 */
export const expandProjects = async (client) => {
  await evaluateValue(client, `localStorage.setItem("oc.sessions.projectCollapse", "[]")`)
}

/**
 * Clicks every "Show more sessions" control until none remain.
 *
 * Session list pagination is component state, so unlike project collapse it
 * cannot be seeded through storage. The controls only exist once the sidebar
 * has populated, so call this after the page has settled, never straight after
 * the load event.
 *
 * Matching is a case-insensitive substring test, which assumes the English UI
 * locale; a non-English locale expands nothing and reports zero.
 */
export const expandSessionLists = async (client, { passes = 40, settleMs = 400 } = {}) => {
  let totalClicked = 0
  for (let pass = 0; pass < passes; pass += 1) {
    const clicked = await evaluateValue(client, `(() => {
      const controls = [...document.querySelectorAll("button")]
        .filter((button) => (button.textContent ?? "").toLowerCase().includes("show more"))
      for (const control of controls) control.click()
      return controls.length
    })()`)
    if (!clicked) break
    totalClicked += clicked
    await wait(settleMs)
  }
  return totalClicked
}

/**
 * Mirrors `useUIStore`'s context-panel tab identity rules so a seeded tab is
 * indistinguishable from one the user opened. Only `file` and `preview` key
 * their identity by target path; every other surface allows one tab per mode.
 */
const buildPanelTab = (descriptor, touchedAt) => {
  const { mode, targetPath } = descriptor
  const dedupeKey = (mode === "file" || mode === "preview") ? (targetPath || mode) : mode
  return {
    id: dedupeKey === mode ? mode : `${mode}:${dedupeKey}`,
    mode,
    targetPath: targetPath || null,
    dedupeKey,
    label: null,
    sessionTitleFallback: null,
    readOnly: false,
    stagedDiff: false,
    diffScope: "working",
    touchedAt,
  }
}

const parsePanelDescriptor = (value) => {
  const separator = value.indexOf("=")
  if (separator === -1) return { mode: value.trim(), targetPath: null }
  return { mode: value.slice(0, separator).trim(), targetPath: value.slice(separator + 1).trim() || null }
}

/**
 * Opens the context panel by seeding the persisted store the app reads on
 * boot, then reloading. Driving persisted state rather than synthesising
 * clicks keeps the scenario deterministic and keeps a measured window free of
 * input-driven work that the interaction under test would not perform.
 */
export const seedContextPanel = async (client, panels, sessionId) => {
  const descriptors = panels.map(parsePanelDescriptor)
  const tabs = descriptors.map((descriptor, index) => buildPanelTab(
    descriptor.mode === "chat" && !descriptor.targetPath ? { ...descriptor, targetPath: sessionId } : descriptor,
    Date.now() + index,
  ))

  const stored = await evaluateValue(client, `JSON.stringify({
    lastDirectory: localStorage.getItem("lastDirectory"),
    uiStore: localStorage.getItem("ui-store"),
  })`)
  const { lastDirectory, uiStore } = JSON.parse(stored ?? "{}")
  if (!lastDirectory) throw new Error("Could not open the context panel: no lastDirectory in browser storage")
  if (!uiStore) throw new Error("Could not open the context panel: no ui-store in browser storage")

  // `lastDirectory` is persisted as a JSON string by some writers and as a raw
  // path by others; accept both rather than guessing. A JSON-encoded path is
  // the only persisted form that starts with a quote.
  let directory = lastDirectory
  if (lastDirectory.startsWith('"')) {
    try {
      directory = JSON.parse(lastDirectory)
    } catch {
      // Malformed JSON: treat the stored value as a raw path.
    }
  }
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/g, "") || "/"

  const parsed = JSON.parse(uiStore)
  parsed.state = parsed.state ?? {}
  parsed.state.contextPanelByDirectory = parsed.state.contextPanelByDirectory ?? {}
  parsed.state.contextPanelByDirectory[normalized] = {
    isOpen: true,
    expanded: false,
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    widthByMode: {},
    touchedAt: Date.now(),
  }

  await evaluateValue(client, `localStorage.setItem("ui-store", ${JSON.stringify(JSON.stringify(parsed))})`)
  console.log(`Context panel seeded for ${normalized}: ${tabs.map((tab) => tab.id).join(", ")}`)
}
