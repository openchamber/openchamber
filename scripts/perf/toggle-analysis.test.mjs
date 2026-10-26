import assert from "node:assert/strict"
import { test } from "node:test"

import { analyzeToggleWindow, estimateRefreshMs, frameStats, rendersInWindow, summarizeByType } from "./toggle-analysis.mjs"

test("refresh interval is the median gap and needs enough frames", () => {
  assert.equal(estimateRefreshMs([0, 16.7, 33.4]), null)
  assert.equal(estimateRefreshMs([0, 16.7, 33.4, 50.1, 90, 106.7, 123.4]), 16.7)
})

test("frame stats measure the first frame after the input against the frame before it", () => {
  // 60 Hz, then a 50 ms gap right after the input at 40 ms: two frames dropped.
  const frames = [0, 16.7, 33.4, 83.4, 100.1, 116.8]
  const stats = frameStats(frames, { from: 40, to: 200, refreshMs: 16.7 })
  assert.equal(stats.frames, 3)
  assert.equal(stats.worstFrameMs, 50)
  assert.equal(stats.droppedFrames, 2)
  assert.equal(stats.jankyFrames, 1)
})

test("frame stats without a refresh estimate report dropped frames as missing, not zero", () => {
  const stats = frameStats([0, 16.7, 33.4], { from: 0, to: 100, refreshMs: null })
  assert.equal(stats.droppedFrames, null)
  assert.equal(stats.worstFrameMs, 16.7)
})

const MAIN = { pid: 1, tid: 2 }
const event = (name, ts, dur, extra = {}) => ({ ...MAIN, ph: "X", name, ts, dur, ...extra })
const trace = (events) => [{ ...MAIN, ph: "M", name: "thread_name", ts: 0, args: { name: "CrRendererMain" } }, ...events]

test("a layout inside script is forced and attributed to the stack Chrome recorded", () => {
  const stack = [{ functionName: "measure", url: "https://x/assets/Sidebar-abcdefgh.js", lineNumber: 10, columnNumber: 4 }]
  const events = trace([
    event("RunTask", 1000, 30_000),
    event("EventDispatch", 1100, 20_000, { args: { data: { type: "click" } } }),
    event("FunctionCall", 1200, 19_000, { args: { data: { functionName: "onClick", url: "u", lineNumber: 1, columnNumber: 1 } } }),
    event("Layout", 2000, 4000, { args: { beginData: { stackTrace: stack } } }),
    event("Commit", 31_000, 500),
    // The lifecycle's own style and layout: not forced.
    event("RunTask", 40_000, 10_000),
    event("UpdateLayoutTree", 40_100, 3000, { args: { elementCount: 120 } }),
    event("Layout", 43_200, 5000),
    event("Commit", 48_500, 500),
  ])
  const result = analyzeToggleWindow(events, { start: 900, end: 60_000 })
  assert.equal(result.inputEvent, "click")
  assert.equal(result.inputTaskMs, 30)
  assert.equal(result.longestTaskMs, 30)
  assert.equal(result.tasksOver16ms, 1)
  assert.deepEqual(result.layout, { count: 2, ms: 9 })
  assert.deepEqual(result.style, { count: 1, ms: 3, elements: 120 })
  assert.equal(result.forced.count, 1)
  assert.equal(result.forced.ms, 4)
  assert.match(result.forced.top[0].stack, /^measure \(https:\/\/x\/assets\/Sidebar-abcdefgh\.js:10:4\)$/)
  assert.equal(result.perFrame.mainFrames, 2)
  assert.equal(result.perFrame.maxStyleLayoutMs, 8)
})

test("a forced layout without a recorded stack falls back to the enclosing function call", () => {
  const events = trace([
    event("RunTask", 0, 10_000),
    event("FunctionCall", 100, 9000, { args: { data: { functionName: "onResize", url: "app.js", lineNumber: 3, columnNumber: 9 } } }),
    event("UpdateLayoutTree", 200, 1000),
  ])
  const result = analyzeToggleWindow(events, { start: 0, end: 20_000 })
  assert.equal(result.forced.top[0].stack, "onResize (app.js:3:9)")
})

test("a keyboard chord's input task is the one handling its last keydown, not the modifier's", () => {
  const events = trace([
    event("RunTask", 0, 500),
    event("EventDispatch", 100, 200, { args: { data: { type: "keydown" } } }),
    event("RunTask", 1000, 12_000),
    event("EventDispatch", 1100, 11_000, { args: { data: { type: "keydown" } } }),
  ])
  assert.equal(analyzeToggleWindow(events, { start: 0, end: 20_000, inputTypes: ["keydown"] }).inputTaskMs, 12)
})

test("no renderer main thread in the window reads as missing, not as a quiet window", () => {
  const result = analyzeToggleWindow([event("RunTask", 0, 1000)], { start: 0, end: 5000 })
  assert.equal(result.mainThreadFound, false)
  assert.equal(result.longestTaskMs, null)
  assert.equal(result.forced, null)
})

test("renders in a window count only commits inside it", () => {
  const commits = [
    { t: 5, renders: 3, mounts: 0, rendersWithoutDomChange: 1, names: { Sidebar: 2, Header: 1 } },
    { t: 50, renders: 4, mounts: 1, rendersWithoutDomChange: 0, names: { Sidebar: 4 } },
    { t: 500, renders: 9, names: { Other: 9 } },
  ]
  const result = rendersInWindow(commits, 0, 100)
  assert.equal(result.commits, 2)
  assert.equal(result.renders, 7)
  assert.equal(result.rendersWithoutDomChange, 1)
  assert.equal(result.mounts, 1)
  assert.deepEqual(result.topComponents[0], ["Sidebar", 6])
})

test("statistics per type leave out warm-up and invalid toggles", () => {
  const toggle = (type, worst, extra = {}) => ({ type, valid: true, warmup: false, frames: { worstFrameMs: worst }, ...extra })
  const summary = summarizeByType([
    toggle("panel-open", 400, { warmup: true }),
    toggle("panel-open", 20),
    toggle("panel-open", 30),
    toggle("panel-open", 999, { valid: false }),
    toggle("sidebar-close", 17),
  ])
  assert.equal(summary["panel-open"].n, 2)
  assert.equal(summary["panel-open"].worstFrameMs.max, 30)
  assert.equal(summary["panel-open"].inputTaskMs, null)
  assert.equal(summary["sidebar-close"].worstFrameMs.median, 17)
})
