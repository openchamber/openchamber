/**
 * Pure analysis for `profile:toggle`: frame pacing from sampled animation
 * frames, the rendering and forced-layout work inside one toggle's trace
 * window, React commits inside that window, and per-toggle-type statistics.
 *
 * Kept free of CDP and the page so it can be unit tested and reused by
 * `compare-runs.mjs`.
 */

import { percentile, round } from "./metrics.mjs"
import { rendererMainThread } from "./trace-analysis.mjs"

const median = (values) => percentile(values, 0.5)

/**
 * The display's frame interval, from animation-frame timestamps sampled while
 * the page was quiet: the median gap, so one late frame does not skew it.
 * Null with fewer than six frames, because then there is nothing to trust.
 */
export const estimateRefreshMs = (timestamps) => {
  if (timestamps.length < 6) return null
  const gaps = []
  for (let index = 1; index < timestamps.length; index += 1) gaps.push(timestamps[index] - timestamps[index - 1])
  return round(median(gaps))
}

/**
 * Frame pacing inside `(from, to]`, in the page's clock. Every frame in the
 * window is measured against the frame before it, which may lie before
 * `from`: the first frame after a click is exactly the one a slow click
 * handler delays. A gap of k refresh intervals means k-1 frames were dropped.
 */
export const frameStats = (timestamps, { from, to, refreshMs }) => {
  const deltas = []
  for (let index = 1; index < timestamps.length; index += 1) {
    const at = timestamps[index]
    if (at > from && at <= to) deltas.push(at - timestamps[index - 1])
  }
  const worstFrameMs = deltas.length ? round(deltas.reduce((max, delta) => Math.max(max, delta), 0)) : null
  if (!refreshMs) return { frames: deltas.length, worstFrameMs, droppedFrames: null, jankyFrames: null, refreshMs: null }
  return {
    frames: deltas.length,
    worstFrameMs,
    droppedFrames: deltas.reduce((total, delta) => total + Math.max(0, Math.round(delta / refreshMs) - 1), 0),
    jankyFrames: deltas.filter((delta) => delta > refreshMs * 1.5).length,
    refreshMs,
  }
}

// Trace events that run JavaScript. A style recalc or layout inside one of
// them was forced synchronously by a script reading geometry or style, rather
// than done once per frame by the rendering lifecycle.
const SCRIPT_EVENTS = new Set([
  "FunctionCall", "EvaluateScript", "v8.callFunction", "v8.run", "v8.evaluateModule",
  "TimerFire", "FireAnimationFrame", "FireIdleCallback", "EventDispatch", "RunMicrotasks", "HandlePostMessage",
])
const STYLE_LAYOUT = new Set(["UpdateLayoutTree", "Layout"])

const callFrame = (frame) => `${frame.functionName || "(anonymous)"} (${frame.url ?? ""}:${frame.lineNumber ?? 0}:${frame.columnNumber ?? 0})`

/**
 * The JS that forced a style recalc or layout: the stack Chrome recorded on
 * the event (`disabled-by-default-devtools.timeline.stack`), else the
 * innermost enclosing function call.
 */
const forcingStack = (event, enclosing) => {
  const stack = event.args?.beginData?.stackTrace ?? event.args?.data?.stackTrace
  if (Array.isArray(stack) && stack.length) return stack.slice(0, 3).map(callFrame).join(" <- ")
  const call = [...enclosing].reverse().find((entry) => entry.name === "FunctionCall" && entry.args?.data)
  if (call) return callFrame(call.args.data)
  return `(inside ${enclosing.at(-1)?.name ?? "script"}, no stack recorded)`
}

/**
 * Rendering work of the renderer main thread inside one toggle's window
 * (trace microseconds, `[start, end]`): the task that handled the input (the
 * last dispatch of one of `inputTypes`), the
 * longest task, style and layout counts and time overall and per frame, and
 * forced style/layout with the JS that forced it.
 *
 * Frames are delimited by the main thread's `Commit` events: work belongs to
 * the first commit that ends after it, and work after the last commit forms a
 * trailing bucket. Returns `mainThreadFound: false` with null figures when the
 * trace has no renderer main thread in the window, never zeros.
 */
export const analyzeToggleWindow = (events, { start, end, inputTypes = ["click", "keydown"], topStacks = 5 }) => {
  const { main } = rendererMainThread(events, { start, end })
  if (!main) return { mainThreadFound: false, inputTaskMs: null, longestTaskMs: null, style: null, layout: null, perFrame: null, forced: null }
  const onMain = events
    .filter((event) => `${event.pid}:${event.tid}` === main && event.ph === "X" && event.ts + Number(event.dur ?? 0) >= start && event.ts <= end)
    .sort((left, right) => left.ts - right.ts || Number(right.dur) - Number(left.dur))
  const ms = (micros) => Number(micros ?? 0) / 1000
  const tasks = onMain.filter((event) => event.name === "RunTask")
  // The last one: a keyboard chord dispatches a keydown per modifier before
  // the key the shortcut handler acts on.
  const input = onMain.findLast((event) => event.name === "EventDispatch" && inputTypes.includes(event.args?.data?.type) && event.ts >= start)
  const inputTask = input ? tasks.find((task) => task.ts <= input.ts && task.ts + task.dur >= input.ts + input.dur) : null

  const style = { count: 0, ms: 0, elements: 0 }
  const layout = { count: 0, ms: 0 }
  const forced = { count: 0, ms: 0, stacks: new Map() }
  const commits = onMain.filter((event) => event.name === "Commit").map((event) => event.ts + event.dur)
  const buckets = new Array(commits.length + 1).fill(0)
  // Script events still open at the current position; the stack is the
  // nesting of JS around a style/layout event.
  const open = []
  for (const event of onMain) {
    while (open.length && open.at(-1).ts + open.at(-1).dur <= event.ts) open.pop()
    if (SCRIPT_EVENTS.has(event.name)) { open.push(event); continue }
    if (!STYLE_LAYOUT.has(event.name) || event.ts < start) continue
    const duration = ms(event.dur)
    if (event.name === "Layout") { layout.count += 1; layout.ms += duration }
    else { style.count += 1; style.ms += duration; style.elements += event.args?.elementCount ?? 0 }
    const frame = commits.findIndex((commitEnd) => commitEnd >= event.ts + event.dur)
    buckets[frame === -1 ? commits.length : frame] += duration
    if (open.length) {
      forced.count += 1
      forced.ms += duration
      const key = forcingStack(event, open)
      const entry = forced.stacks.get(key) ?? { stack: key, count: 0, ms: 0 }
      entry.count += 1
      entry.ms += duration
      forced.stacks.set(key, entry)
    }
  }
  const usedBuckets = buckets.filter((value, index) => value > 0 || index < commits.length)
  return {
    mainThreadFound: true,
    inputEvent: input?.args?.data?.type ?? null,
    inputTaskMs: inputTask ? round(ms(inputTask.dur)) : null,
    longestTaskMs: round(tasks.reduce((max, task) => Math.max(max, ms(task.dur)), 0)),
    tasksOver16ms: tasks.filter((task) => ms(task.dur) > 16.7).length,
    style: { count: style.count, ms: round(style.ms), elements: style.elements },
    layout: { count: layout.count, ms: round(layout.ms) },
    perFrame: {
      mainFrames: commits.length,
      maxStyleLayoutMs: round(usedBuckets.reduce((max, value) => Math.max(max, value), 0)),
      meanStyleLayoutMs: usedBuckets.length ? round((style.ms + layout.ms) / usedBuckets.length) : null,
    },
    forced: {
      count: forced.count,
      ms: round(forced.ms),
      top: [...forced.stacks.values()].sort((left, right) => right.ms - left.ms).slice(0, topStacks).map((entry) => ({ ...entry, ms: round(entry.ms) })),
    },
  }
}

/**
 * React commits recorded by the render probe between `fromMs` and `toMs`
 * (milliseconds since the probe started), with the components rendered most.
 */
export const rendersInWindow = (commits, fromMs, toMs, top = 8) => {
  const inWindow = commits.filter((commit) => commit.t >= fromMs && commit.t <= toMs)
  const names = new Map()
  for (const commit of inWindow) for (const [name, count] of Object.entries(commit.names ?? {})) names.set(name, (names.get(name) ?? 0) + count)
  return {
    commits: inWindow.length,
    renders: inWindow.reduce((total, commit) => total + commit.renders, 0),
    rendersWithoutDomChange: inWindow.reduce((total, commit) => total + (commit.rendersWithoutDomChange ?? 0), 0),
    mounts: inWindow.reduce((total, commit) => total + (commit.mounts ?? 0), 0),
    topComponents: [...names].sort((left, right) => right[1] - left[1]).slice(0, top),
  }
}

/**
 * Per-toggle figures, as [key, label, read(toggle), shownInCompare]. Lower is
 * better for all of them. `compare-runs.mjs` shows the marked subset, so the
 * before/after table stays readable with six toggle types.
 */
export const TOGGLE_METRICS = [
  ["inputToNextFrameMs", "input to next frame ms", (toggle) => toggle.inputToNextFrameMs, true],
  ["inputTaskMs", "input task ms", (toggle) => toggle.trace?.inputTaskMs, true],
  ["eventTimingMs", "event timing duration ms", (toggle) => toggle.eventTiming?.durationMs, false],
  ["worstFrameMs", "worst frame ms", (toggle) => toggle.frames?.worstFrameMs, true],
  ["droppedFrames", "dropped frames", (toggle) => toggle.frames?.droppedFrames, true],
  ["longestTaskMs", "longest task ms", (toggle) => toggle.trace?.longestTaskMs, false],
  ["styleMs", "style recalc ms", (toggle) => toggle.trace?.style?.ms, false],
  ["styleCount", "style recalcs", (toggle) => toggle.trace?.style?.count, false],
  ["elementsRestyled", "elements restyled", (toggle) => toggle.trace?.style?.elements, true],
  ["layoutMs", "layout ms", (toggle) => toggle.trace?.layout?.ms, false],
  ["layoutCount", "layouts", (toggle) => toggle.trace?.layout?.count, false],
  ["styleLayoutMs", "style + layout ms", (toggle) => (toggle.trace?.style && toggle.trace?.layout ? round(toggle.trace.style.ms + toggle.trace.layout.ms) : null), true],
  ["maxStyleLayoutMsPerFrame", "worst frame style + layout ms", (toggle) => toggle.trace?.perFrame?.maxStyleLayoutMs, false],
  ["forcedLayouts", "forced style/layouts", (toggle) => toggle.trace?.forced?.count, true],
  ["forcedLayoutMs", "forced style/layout ms", (toggle) => toggle.trace?.forced?.ms, false],
  ["accessibilityMs", "accessibility ms", (toggle) => toggle.accessibility?.ms, true],
  ["accessibilityLongestPassMs", "longest accessibility pass ms", (toggle) => toggle.accessibility?.longestPassMs, false],
  ["loafWorstMs", "worst long animation frame ms", (toggle) => toggle.loaf?.worstMs, false],
  ["observedTransitionMs", "observed transition ms", (toggle) => toggle.transition?.observedMs, false],
  ["commits", "React commits", (toggle) => toggle.renders?.commits, true],
  ["renders", "component renders", (toggle) => toggle.renders?.renders, false],
]

/** Toggles that count toward statistics: measured (not warm-up) and valid. */
export const measuredToggles = (toggles) => toggles.filter((toggle) => !toggle.warmup && toggle.valid)

/** Median, p95 and max of every metric per toggle type, over measured toggles. */
export const summarizeByType = (toggles) => {
  const byType = {}
  for (const toggle of measuredToggles(toggles)) (byType[toggle.type] ??= []).push(toggle)
  return Object.fromEntries(Object.entries(byType).map(([type, entries]) => [type, {
    n: entries.length,
    ...Object.fromEntries(TOGGLE_METRICS.map(([key, , read]) => {
      const values = entries.map(read).filter((value) => Number.isFinite(value))
      return [key, values.length ? { n: values.length, median: round(median(values)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)) } : null]
    })),
  }]))
}
