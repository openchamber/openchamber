import assert from "node:assert/strict"
import { test } from "node:test"

import { accessibilityInWindow, accessibilityState, describeAccessibility } from "./accessibility.mjs"

const MAIN = { pid: 1, tid: 2 }
const event = (name, ts, dur, extra = {}) => ({ ...MAIN, ph: "X", cat: "accessibility", name, ts, dur, ...extra })
const task = (ts, dur) => ({ ...MAIN, ph: "X", cat: "disabled-by-default-devtools.timeline", name: "RunTask", ts, dur })

test("accessibility time is the union of nested stages, one pass per task", () => {
  const events = [
    task(0, 50_000),
    event("ProcessDeferredUpdatesLifecycleStage", 1000, 1000),
    event("SerializeLifecycleStage", 3000, 40_000),
    // Sending the events runs inside serialization: not counted twice.
    event("RenderAccessibilityImpl::SendPendingAccessibilityEvents", 30_000, 10_000),
    task(100_000, 10_000),
    event("SerializeLifecycleStage", 101_000, 5000),
    // Another thread's work and work outside the window are not this window's.
    event("SerializeLifecycleStage", 101_000, 5000, { tid: 9 }),
    task(500_000, 10_000),
    event("SerializeLifecycleStage", 501_000, 5000),
  ]
  assert.deepEqual(accessibilityInWindow(events, { main: "1:2", start: 0, end: 200_000, recorded: true }), { ms: 46, passes: 2, longestPassMs: 41 })
})

test("an unrecorded category reads as missing, not as zero", () => {
  assert.equal(accessibilityInWindow([], { main: "1:2", start: 0, end: 1, recorded: false }), null)
  assert.deepEqual(accessibilityInWindow([task(0, 10)], { main: "1:2", start: 0, end: 100, recorded: true }), { ms: 0, passes: 0, longestPassMs: 0 })
})

test("the state says whether a tree was built and who asked for it", () => {
  const client = [event("SerializeLifecycleStage", 0, 10), { pid: 3, tid: 4, ph: "X", cat: "accessibility", name: "AXPlatformNodeCocoa::isAccessibilitySelectorAllowed", ts: 0, dur: 1 }]
  const withClient = accessibilityState(client, { categories: ["devtools.timeline", "accessibility"] })
  assert.deepEqual(withClient, { recorded: true, forced: false, active: true, serializations: 1, nativeClientCalls: 1 })
  assert.match(describeAccessibility(withClient), /accessibility client is reading the browser/)
  const off = accessibilityState([task(0, 10)], { categories: ["accessibility"] })
  assert.equal(off.active, false)
  assert.match(describeAccessibility(off), /^accessibility: off/)
  assert.match(describeAccessibility(accessibilityState(client, { categories: ["accessibility"], forced: true })), /forced/)
  assert.deepEqual(accessibilityState(client, { categories: ["devtools.timeline"] }), { recorded: false, forced: false, active: null, serializations: null, nativeClientCalls: null })
})
