import assert from "node:assert/strict"
import test from "node:test"

import {
  GIT_DIFF_FILE_LIMIT,
  assertActionsRunnable,
  buildFixturePlan,
  expectedRequestsForAction,
  findMissingRequests,
  parseActions,
  peakInFlight,
  peakInFlightToComplete,
  summarizeTraffic,
} from "./git-panel.mjs"

test("fixture plan names deterministic files and stages a prefix", () => {
  const plan = buildFixturePlan({ files: 5, modified: 3, staged: 2 })
  assert.deepEqual(plan.paths, [
    "file-0001.txt",
    "file-0002.txt",
    "file-0003.txt",
    "file-0004.txt",
    "file-0005.txt",
  ])
  assert.deepEqual(plan.modifiedPaths, ["file-0001.txt", "file-0002.txt", "file-0003.txt"])
  assert.deepEqual(plan.stagedPaths, ["file-0001.txt", "file-0002.txt"])
  assert.deepEqual(plan.neverStagedPaths, ["file-0003.txt"])
})

test("fixture plan rejects counts that cannot describe a repository", () => {
  assert.throws(() => buildFixturePlan({ files: 0, modified: 0, staged: 0 }), /--files must be an integer of at least 1/)
  assert.throws(() => buildFixturePlan({ files: 5, modified: 6, staged: 0 }), /--modified cannot exceed --files/)
  assert.throws(() => buildFixturePlan({ files: 5, modified: 2, staged: 3 }), /--staged cannot exceed --modified/)
  assert.throws(() => buildFixturePlan({ files: 5, modified: -1, staged: 0 }), /--modified must be an integer/)
  assert.throws(() => buildFixturePlan({ files: 5, modified: 1.5, staged: 0 }), /--modified must be an integer/)
})

test("actions parse in order and reject unknown or duplicated entries", () => {
  assert.deepEqual(parseActions("generate, revert-all"), ["generate", "revert-all"])
  assert.throws(() => parseActions(" , "), /at least one action/)
  assert.throws(() => parseActions("generate,stash"), /Unknown action\(s\): stash/)
  assert.throws(() => parseActions("revert-all,revert-all"), /Duplicate action\(s\): revert-all/)
})

test("actions are refused when the fixture cannot produce them", () => {
  const noStaged = buildFixturePlan({ files: 4, modified: 2, staged: 0 })
  assert.throws(() => assertActionsRunnable(["generate"], noStaged), /generate needs staged files/)
  const noModified = buildFixturePlan({ files: 4, modified: 0, staged: 0 })
  assert.throws(() => assertActionsRunnable(["revert-all"], noModified), /revert-all needs modified/)
  assert.throws(() => assertActionsRunnable(["stage-commit"], noModified), /stage-commit needs modified/)
  const plan = buildFixturePlan({ files: 4, modified: 2, staged: 1 })
  assert.deepEqual(assertActionsRunnable(["generate", "revert-all"], plan), ["generate", "revert-all"])
  assert.deepEqual(assertActionsRunnable(["generate", "stage-commit"], plan), ["generate", "stage-commit"])
})

test("revert-all and stage-commit are refused together: each consumes the fixture's changes", () => {
  const plan = buildFixturePlan({ files: 4, modified: 2, staged: 1 })
  assert.throws(() => assertActionsRunnable(["revert-all", "stage-commit"], plan), /separate captures/)
  assert.throws(() => assertActionsRunnable(["stage-commit", "revert-all"], plan), /separate captures/)
})

test("expected requests mirror the app's per-action fan-out", () => {
  const plan = buildFixturePlan({ files: 200, modified: 40, staged: 30 })
  assert.deepEqual(expectedRequestsForAction("generate", plan), { "/api/git/diff": 2 * GIT_DIFF_FILE_LIMIT })
  assert.deepEqual(expectedRequestsForAction("revert-all", plan), { "/api/git/revert": 40 })
  assert.deepEqual(expectedRequestsForAction("stage-commit", plan), { "/api/git/stage": 1, "/api/git/commit": 1 })

  // Beyond the app's collect limit the fixture does not raise the expectation.
  const many = buildFixturePlan({ files: 60, modified: 50, staged: 50 })
  assert.deepEqual(expectedRequestsForAction("generate", many), { "/api/git/diff": 2 * GIT_DIFF_FILE_LIMIT })
})

test("peak in flight finds the largest overlap and orders ends before starts", () => {
  assert.equal(peakInFlight([]), 0)
  assert.equal(peakInFlight([{ startedAt: 0, endedAt: 1 }]), 1)
  assert.equal(peakInFlight([
    { startedAt: 0, endedAt: 1 },
    { startedAt: 2, endedAt: 3 },
  ]), 1)
  assert.equal(peakInFlight([
    { startedAt: 0, endedAt: 5 },
    { startedAt: 1, endedAt: 2 },
    { startedAt: 1.5, endedAt: 4 },
    { startedAt: 6, endedAt: 7 },
  ]), 3)
  // A request ending at t does not overlap one starting at t.
  assert.equal(peakInFlight([
    { startedAt: 0, endedAt: 1 },
    { startedAt: 1, endedAt: 2 },
  ]), 1)
  // An unterminated request is treated as instantaneous, never as infinite.
  assert.equal(peakInFlight([{ startedAt: 0, endedAt: null }, { startedAt: 0.5, endedAt: 1 }]), 1)
})

test("response headers close the client interval before the body completes", () => {
  // The unread-body pattern: the mapper resolves on the headers and starts the
  // next request while the previous body is still in transfer.
  const unreadBody = { startedAt: 0, responseAt: 0.05, endedAt: 0.9 }
  const next = { startedAt: 0.2, responseAt: 0.25, endedAt: 0.3 }
  assert.equal(peakInFlight([unreadBody, next]), 1)
  assert.equal(peakInFlightToComplete([unreadBody, next]), 2)

  // Headers landing exactly when the next request starts are not an overlap.
  assert.equal(peakInFlight([
    { startedAt: 0, responseAt: 1, endedAt: 5 },
    { startedAt: 1, responseAt: 2, endedAt: 6 },
  ]), 1)

  // A request that failed before any headers still occupied its client slot.
  assert.equal(peakInFlight([
    { startedAt: 0, responseAt: null, endedAt: 3 },
    { startedAt: 1, responseAt: null, endedAt: 2 },
  ]), 2)
})

test("an unbounded fan-out keeps its full width in the client peak", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    startedAt: 5 + index * 0.001,
    responseAt: 5.5,
    endedAt: 5.6,
  }))
  assert.equal(peakInFlight(entries), 12)
  assert.equal(peakInFlightToComplete(entries), 12)
})

test("traffic summary groups by endpoint and keeps failures visible", () => {
  const traffic = summarizeTraffic([
    { endpoint: "/api/git/diff", method: "GET", startedAt: 0, endedAt: 0.05 },
    { endpoint: "/api/git/diff", method: "GET", startedAt: 0.01, endedAt: 0.2, servedFromCache: true },
    { endpoint: "/api/git/revert", method: "POST", startedAt: 0.02, endedAt: 0.03, failed: true },
  ])
  assert.equal(traffic.total, 3)
  assert.equal(traffic.failed, 1)
  assert.equal(traffic.servedFromCache, 1)
  assert.equal(traffic.byEndpoint["/api/git/diff"].count, 2)
  assert.equal(traffic.byEndpoint["/api/git/diff"].peakInFlight, 2)
  assert.equal(traffic.byEndpoint["/api/git/diff"].peakInFlightToComplete, 2)
  assert.deepEqual(traffic.byEndpoint["/api/git/diff"].methods, { GET: 2 })
  assert.equal(traffic.byEndpoint["/api/git/revert"].failed, 1)
  assert.equal(traffic.byEndpoint["/api/git/revert"].maxDurationMs, 10)
})

test("traffic summary keeps the two peaks apart for unread bodies", () => {
  const traffic = summarizeTraffic([
    { endpoint: "/api/git/revert", method: "POST", startedAt: 0, responseAt: 0.05, endedAt: 0.9 },
    { endpoint: "/api/git/revert", method: "POST", startedAt: 0.2, responseAt: 0.25, endedAt: 0.3 },
  ])
  const bucket = traffic.byEndpoint["/api/git/revert"]
  assert.equal(bucket.count, 2)
  assert.equal(bucket.peakInFlight, 1)
  assert.equal(bucket.peakInFlightToComplete, 2)
  assert.equal(bucket.maxDurationMs, 900)
})

test("missing requests are reported against the expected endpoint", () => {
  const plan = buildFixturePlan({ files: 10, modified: 6, staged: 4 })
  const traffic = summarizeTraffic([
    { endpoint: "/api/git/diff", startedAt: 0, endedAt: 0.01 },
  ])
  assert.deepEqual(findMissingRequests("revert-all", plan, traffic), [
    "revert-all: expected 6 request(s) to /api/git/revert, observed 0",
  ])
  assert.deepEqual(findMissingRequests("generate", plan, traffic), [
    `generate: expected 8 request(s) to /api/git/diff, observed 1`,
  ])
  const complete = summarizeTraffic(
    Array.from({ length: 8 }, () => ({ endpoint: "/api/git/diff", startedAt: 0, endedAt: 0.01 })),
  )
  assert.deepEqual(findMissingRequests("generate", plan, complete), [])
  assert.deepEqual(findMissingRequests("generate", plan, { byEndpoint: {} }), [
    "generate: expected 8 request(s) to /api/git/diff, observed 0",
  ])
})

test("failed requests on the action's primary endpoint fail the capture", () => {
  const plan = buildFixturePlan({ files: 10, modified: 6, staged: 4 })
  const failedDiffs = summarizeTraffic(
    Array.from({ length: 8 }, () => ({ endpoint: "/api/git/diff", startedAt: 0, endedAt: 0.01, failed: true })),
  )
  assert.deepEqual(findMissingRequests("generate", plan, failedDiffs), [
    "generate: 8 request(s) to /api/git/diff failed",
  ])

  const failedReverts = summarizeTraffic(
    Array.from({ length: 6 }, () => ({ endpoint: "/api/git/revert", startedAt: 0, endedAt: 0.01, failed: true })),
  )
  assert.deepEqual(findMissingRequests("revert-all", plan, failedReverts), [
    "revert-all: 6 request(s) to /api/git/revert failed",
  ])

  // A failure on an endpoint that is not the action's evidence stays visible
  // in the summary instead of failing the capture.
  const failedStage = summarizeTraffic([
    { endpoint: "/api/git/commit", startedAt: 0, endedAt: 0.01 },
    { endpoint: "/api/git/stage", startedAt: 0, endedAt: 0.01, failed: true },
  ])
  assert.deepEqual(findMissingRequests("stage-commit", plan, failedStage), [])
})

test("HTTP error responses count as failed, and only the primary endpoint gates the capture", () => {
  const plan = buildFixturePlan({ files: 10, modified: 6, staged: 4 })
  // An HTTP error completes as loadingFinished with failed=false; the status is
  // what identifies it, matching profile-browser.mjs's failure rule.
  const errorDiffs = summarizeTraffic(
    Array.from({ length: 8 }, () => ({
      endpoint: "/api/git/diff",
      startedAt: 0,
      endedAt: 0.01,
      failed: false,
      status: 500,
    })),
  )
  assert.equal(errorDiffs.failed, 8)
  assert.equal(errorDiffs.byEndpoint["/api/git/diff"].failed, 8)
  assert.deepEqual(findMissingRequests("generate", plan, errorDiffs), [
    "generate: 8 request(s) to /api/git/diff failed",
  ])

  // A 500 on an endpoint that is not the action's evidence stays visible in
  // the summary instead of failing the capture.
  const errorStage = summarizeTraffic([
    { endpoint: "/api/git/commit", startedAt: 0, endedAt: 0.01, failed: false, status: 200 },
    { endpoint: "/api/git/stage", startedAt: 0, endedAt: 0.01, failed: false, status: 500 },
  ])
  assert.equal(errorStage.failed, 1)
  assert.equal(errorStage.byEndpoint["/api/git/stage"].failed, 1)
  assert.equal(errorStage.byEndpoint["/api/git/commit"].failed, 0)
  assert.deepEqual(findMissingRequests("stage-commit", plan, errorStage), [])
})
