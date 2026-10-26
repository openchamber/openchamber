/**
 * What Chrome's accessibility tree costs inside a trace, and whether it was
 * built at all.
 *
 * Chrome keeps no accessibility tree until a client asks for one: a screen
 * reader, or on macOS any app that reads other windows (window managers,
 * launchers, clipboard and automation tools). Once one has, every frame that
 * changed something it exposes ends in a serialization pass inside the main
 * thread's `Commit` (`SerializeLifecycleStage`), and the browser process
 * receives the result. The same build therefore measures differently on two
 * machines, and headed differently from headless. Each run records the
 * `accessibility` trace category so it can say which case it measured, and
 * `--force-accessibility` turns the tree on in any Chrome, headless included,
 * so a comparison measures the same case everywhere.
 */

import { round } from "./metrics.mjs"

export const ACCESSIBILITY_CATEGORY = "accessibility"

/** Chrome flag that builds and serializes the full tree with no client attached. */
export const FORCE_ACCESSIBILITY_ARGS = ["--force-renderer-accessibility"]

// Renderer main-thread stages of one accessibility update. They nest (sending
// the events runs inside serialization), so time is the union, not the sum.
const RENDERER_STAGES = new Set([
  "ProcessDeferredUpdatesLifecycleStage",
  "FinalizingTreeLifecycleStage",
  "SerializeLifecycleStage",
  "TakeLocationChangsForSerialization",
  "RenderAccessibilityImpl::SendPendingAccessibilityEvents",
])
// A native client reading the browser's tree on macOS.
const NATIVE_CLIENT = /^(AXPlatformNodeCocoa|BrowserAccessibilityCocoa)::/

const isRendererStage = (event) => event.ph === "X" && event.cat === ACCESSIBILITY_CATEGORY && RENDERER_STAGES.has(event.name)

/** Union of the durations of `events` (sorted by start), in ms. */
const unionMs = (events) => {
  let total = 0
  let end = -Infinity
  for (const event of events) {
    const eventEnd = event.ts + Number(event.dur ?? 0)
    if (eventEnd <= end) continue
    total += eventEnd - Math.max(event.ts, end)
    end = eventEnd
  }
  return total / 1000
}

/**
 * Accessibility work on one renderer main thread (`main`, "pid:tid") inside
 * `[start, end]` (trace microseconds): total time, and the passes, one per
 * task that did any. Null when the category was not recorded, never zero.
 */
export const accessibilityInWindow = (events, { main, start, end, recorded }) => {
  if (!recorded || !main) return null
  const stages = events
    .filter((event) => isRendererStage(event) && `${event.pid}:${event.tid}` === main && event.ts >= start && event.ts <= end)
    .sort((left, right) => left.ts - right.ts)
  const tasks = events.filter((event) => event.ph === "X" && event.name === "RunTask" && `${event.pid}:${event.tid}` === main && event.ts + Number(event.dur ?? 0) >= start && event.ts <= end)
  const passes = []
  for (const task of tasks) {
    const inside = stages.filter((event) => event.ts >= task.ts && event.ts <= task.ts + task.dur)
    if (inside.length) passes.push(unionMs(inside))
  }
  return { ms: round(unionMs(stages)), passes: passes.length, longestPassMs: round(passes.reduce((max, value) => Math.max(max, value), 0)) }
}

/**
 * Whether the run built an accessibility tree, from the trace itself:
 * `recorded` (the category was on), `active` (the renderer serialized a tree),
 * `nativeClientCalls` (a macOS app read the browser's tree; 0 elsewhere and
 * with a forced tree), and `forced` as launched.
 */
export const accessibilityState = (events, { categories, forced = false }) => {
  const recorded = categories.includes(ACCESSIBILITY_CATEGORY)
  if (!recorded) return { recorded, forced, active: null, serializations: null, nativeClientCalls: null }
  let serializations = 0
  let nativeClientCalls = 0
  for (const event of events) {
    if (event.cat !== ACCESSIBILITY_CATEGORY) continue
    if (event.name === "SerializeLifecycleStage" && event.ph === "X") serializations += 1
    else if (NATIVE_CLIENT.test(event.name)) nativeClientCalls += 1
  }
  return { recorded, forced, active: serializations > 0, serializations, nativeClientCalls }
}

/** One line for a run's report. */
export const describeAccessibility = (state) => {
  if (!state?.recorded) return "accessibility: not recorded"
  if (!state.active) return "accessibility: off (no tree was built; a user with an accessibility client pays more)"
  const why = state.forced ? "forced with --force-accessibility" : state.nativeClientCalls > 0 ? `an accessibility client is reading the browser (${state.nativeClientCalls} native calls)` : "a client turned it on"
  return `accessibility: on, ${why}; ${state.serializations} serializations`
}
