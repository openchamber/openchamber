/**
 * Offline analysis of a saved timeline (`trace.json`, written by
 * `profile:session --save-trace` and by every `profile:switch` run).
 *
 * The run summary already carries long tasks and the trace breakdown; these
 * helpers answer the next questions: how many frames the renderer produced and
 * what each cost in the pipeline, which tasks were long and what was inside
 * them, and which style recalculations touched most of the document.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const threadKey = (event) => `${event.pid}:${event.tid}`

export const loadTrace = (directory) => {
  const file = join(directory, "trace.json")
  if (!existsSync(file)) return null
  const raw = JSON.parse(readFileSync(file, "utf8"))
  return Array.isArray(raw) ? raw : raw.traceEvents
}

/**
 * The measured window: `perf:stream-start`..`perf:stream-end` for a session
 * run, otherwise the whole trace. `marked` says which one it is.
 */
export const traceWindow = (events) => {
  let start = null
  let end = null
  let first = Infinity
  let last = -Infinity
  for (const event of events) {
    const ts = Number(event.ts)
    if (!(ts > 0)) continue
    if (ts < first) first = ts
    if (ts > last) last = ts
    if (event.name === "perf:stream-start" && start === null) start = ts
    if (event.name === "perf:stream-end" && end === null) end = ts
  }
  const marked = start !== null && end !== null && end > start
  return marked ? { start, end, marked } : { start: first, end: last, marked: false }
}

/** The renderer main thread with the most events inside the window. */
export const rendererMainThread = (events, window) => {
  const names = new Map()
  for (const event of events) if (event.ph === "M" && event.name === "thread_name") names.set(threadKey(event), event.args?.name)
  const counts = new Map()
  for (const event of events) {
    if (event.ts < window.start || event.ts > window.end) continue
    const key = threadKey(event)
    if (names.get(key) === "CrRendererMain") counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const main = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  return { main, names }
}

/**
 * Rendering pipeline cost per second of the window: frames submitted by the
 * renderer and committed by its main thread, paints, elements restyled,
 * layerization, and the GPU process's compositor and raster time.
 */
export const pipelineMetrics = (events, window = traceWindow(events)) => {
  const { main, names } = rendererMainThread(events, window)
  const seconds = (window.end - window.start) / 1e6
  const totals = { framesSubmitted: 0, mainCommits: 0, paints: 0, recalcElements: 0, layerizeMs: 0, vizMs: 0, rasterMs: 0, displaySwaps: 0 }
  for (const event of events) {
    if (event.ts < window.start || event.ts > window.end) continue
    if (event.name === "EndActivateToSubmitCompositorFrame" && event.ph === "b") totals.framesSubmitted += 1
    if (event.ph !== "X") continue
    const key = threadKey(event)
    if (key === main) {
      if (event.name === "Layerize") totals.layerizeMs += event.dur / 1000
      else if (event.name === "Commit") totals.mainCommits += 1
      else if (event.name === "UpdateLayoutTree") totals.recalcElements += event.args?.elementCount ?? 0
      else if (event.name === "Paint") totals.paints += 1
    } else if (names.get(key) === "VizCompositorThread" && event.name === "RunTask") totals.vizMs += event.dur / 1000
    else if (event.name === "RasterTask") totals.rasterMs += event.dur / 1000
    if (/DrawAndSwap/.test(event.name)) totals.displaySwaps += 1
  }
  const perSecond = (value) => (seconds > 0 ? Math.round((value / seconds) * 100) / 100 : null)
  return {
    windowSeconds: Math.round(seconds * 100) / 100,
    windowMarked: window.marked,
    mainThreadFound: main !== null,
    framesSubmittedPerSecond: perSecond(totals.framesSubmitted),
    mainCommitsPerSecond: perSecond(totals.mainCommits),
    displaySwapsPerSecond: perSecond(totals.displaySwaps),
    paintsPerSecond: perSecond(totals.paints),
    recalcElementsPerSecond: perSecond(totals.recalcElements),
    layerizeMsPerSecond: perSecond(totals.layerizeMs),
    gpuCompositorMsPerSecond: perSecond(totals.vizMs),
    rasterMsPerSecond: perSecond(totals.rasterMs),
  }
}

/** `pipelineMetrics` for a run directory, cached next to the trace. */
export const cachedPipelineMetrics = (directory) => {
  const cache = join(directory, "trace-pipeline.json")
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"))
  const events = loadTrace(directory)
  if (!events) return null
  const metrics = pipelineMetrics(events)
  writeFileSync(cache, JSON.stringify(metrics))
  return metrics
}

/** A chunk URL without origin and content hash, for unmapped output. */
export const shortUrl = (text) => String(text).replace(/https?:\/\/[^\s)]*\/([^/\s)]+?)(-[A-Za-z0-9_-]{8})?\.js/g, "$1.js")

/**
 * Main-thread tasks between `minMs` and `maxMs`, grouped by what started them
 * (timer, animation frame, event, message) and the outermost function call,
 * with the time inside each spent on script, style, layout and paint.
 */
export const classifyTasks = (events, { minMs = 8.33, maxMs = Infinity, window = traceWindow(events) } = {}) => {
  const { main } = rendererMainThread(events, window)
  if (!main) return { main: null, tasks: 0, groups: [] }
  const onMain = events.filter((event) => threadKey(event) === main && event.ph === "X").sort((left, right) => left.ts - right.ts)
  const tasks = onMain.filter((event) => event.name === "RunTask" && event.ts >= window.start && event.ts <= window.end && event.dur / 1000 > minMs && event.dur / 1000 <= maxMs)
  const sum = (inner, eventNames) => inner.filter((event) => eventNames.includes(event.name)).reduce((total, event) => total + event.dur, 0) / 1000
  const groups = new Map()
  let cursor = 0
  for (const task of tasks) {
    while (cursor < onMain.length && onMain[cursor].ts < task.ts) cursor += 1
    const inner = []
    for (let index = cursor; index < onMain.length && onMain[index].ts <= task.ts + task.dur; index += 1) {
      if (onMain[index] !== task && onMain[index].ts + onMain[index].dur <= task.ts + task.dur) inner.push(onMain[index])
    }
    const call = inner.filter((event) => event.name === "FunctionCall").sort((left, right) => right.dur - left.dur)[0]
    const trigger = inner.find((event) => ["TimerFire", "FireAnimationFrame", "FireIdleCallback", "EventDispatch", "v8.callFunction", "ParseHTML", "HandlePostMessage"].includes(event.name)
      && call && event.ts <= call.ts && event.ts + event.dur >= call.ts + call.dur)?.name ?? (call ? "task" : "native")
    const data = call?.args?.data ?? {}
    // Stack-trace shape, so a source mapper can map it.
    const frame = call ? `${data.functionName || "(anonymous)"} (${data.url ?? ""}:${data.lineNumber ?? 0}:${data.columnNumber ?? 0})` : "(no script)"
    const key = `${trigger} ${frame}`
    const group = groups.get(key) ?? { key, trigger, frame, count: 0, totalMs: 0, scriptMs: 0, styleMs: 0, layoutMs: 0, paintMs: 0, atSeconds: [] }
    group.count += 1
    group.totalMs += task.dur / 1000
    group.scriptMs += (call?.dur ?? 0) / 1000
    group.styleMs += sum(inner, ["UpdateLayoutTree"])
    group.layoutMs += sum(inner, ["Layout"])
    group.paintMs += sum(inner, ["Paint", "PrePaint", "Layerize", "Commit"])
    group.atSeconds.push(Math.round((task.ts - window.start) / 1e5) / 10)
    groups.set(key, group)
  }
  return { main, tasks: tasks.length, groups: [...groups.values()].sort((left, right) => right.totalMs - left.totalMs) }
}

/** Style recalculations that restyled at least `minElements` elements. */
export const largeRecalcs = (events, { minElements = 3000, window = traceWindow(events) } = {}) => {
  const all = events.filter((event) => event.name === "UpdateLayoutTree" && event.ts >= window.start && event.ts <= window.end)
  const large = all.filter((event) => (event.args?.elementCount ?? 0) >= minElements)
  const elements = (list) => list.reduce((total, event) => total + (event.args?.elementCount ?? 0), 0)
  const ms = (list) => list.reduce((total, event) => total + (event.dur ?? 0) / 1000, 0)
  return {
    minElements,
    count: large.length,
    elementShare: elements(all) > 0 ? Math.round((elements(large) / elements(all)) * 1000) / 10 : 0,
    ms: Math.round(ms(large) * 10) / 10,
    totalMs: Math.round(ms(all) * 10) / 10,
    recalcs: large.map((event) => ({ atMs: Math.round((event.ts - window.start) / 1000), elements: event.args.elementCount, ms: Math.round(event.dur / 10) / 100 })),
  }
}
