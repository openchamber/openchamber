/**
 * Fixture plan and request-burst arithmetic for `profile:git`.
 *
 * The git-panel capture needs three derivations before it can measure
 * anything: which files the disposable fixture will contain, how many requests
 * the app is expected to fire for a given action, and how much of that fan-out
 * overlapped in time — as client concurrency and as completed transfers. They
 * are kept pure so they can be tested without a browser, a server, or a
 * repository.
 */

import { round } from "./metrics.mjs"

// Mirrors COMMIT_DIFF_FILE_LIMIT in packages/ui/src/lib/gitApi.ts: Generate
// reads at most this many staged files at two requests each (staged and
// unstaged). If the app's limit changes, the expectation must move with it or
// the run would report a false failure.
export const GIT_DIFF_FILE_LIMIT = 30

export const SUPPORTED_ACTIONS = ["generate", "revert-all", "stage-commit"]

const requireInteger = (value, name, { minimum = 0 } = {}) => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`)
  }
}

export const parseActions = (value) => {
  const actions = String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
  if (actions.length === 0) throw new Error("--actions must name at least one action")
  const unknown = actions.filter((action) => !SUPPORTED_ACTIONS.includes(action))
  if (unknown.length > 0) {
    throw new Error(`Unknown action(s): ${unknown.join(", ")}. Supported actions: ${SUPPORTED_ACTIONS.join(", ")}`)
  }
  const duplicates = [...new Set(actions.filter((action, index) => actions.indexOf(action) !== index))]
  if (duplicates.length > 0) throw new Error(`Duplicate action(s): ${duplicates.join(", ")}`)
  return actions
}

/**
 * Names the fixture's tracked files deterministically, then splits the
 * modified prefix into the part that is staged (and modified again afterwards,
 * so both the index and the working tree carry a diff) and the part that is
 * only modified.
 */
export const buildFixturePlan = ({ files, modified, staged }) => {
  requireInteger(files, "--files", { minimum: 1 })
  requireInteger(modified, "--modified")
  requireInteger(staged, "--staged")
  if (modified > files) throw new Error("--modified cannot exceed --files")
  if (staged > modified) throw new Error("--staged cannot exceed --modified")
  const paths = Array.from({ length: files }, (_, index) => `file-${String(index + 1).padStart(4, "0")}.txt`)
  const modifiedPaths = paths.slice(0, modified)
  return {
    paths,
    modifiedPaths,
    stagedPaths: modifiedPaths.slice(0, staged),
    // Modified once and never staged, so they never appear in the Staged group.
    neverStagedPaths: modifiedPaths.slice(staged),
  }
}

/** Refuses an action combination the fixture's changes cannot produce, before anything runs. */
export const assertActionsRunnable = (actions, plan) => {
  if (actions.includes("revert-all") && actions.includes("stage-commit")) {
    throw new Error(
      "revert-all and stage-commit cannot run in the same capture: each consumes the fixture's modified files, "
      + "so the second finds nothing to act on. Run them as separate captures.",
    )
  }
  for (const action of actions) {
    if (action === "generate" && plan.stagedPaths.length === 0) {
      throw new Error("generate needs staged files: pass --staged greater than zero")
    }
    if ((action === "revert-all" || action === "stage-commit") && plan.modifiedPaths.length === 0) {
      throw new Error(`${action} needs modified working-tree files: pass --modified greater than zero`)
    }
  }
  return actions
}

/** The endpoint whose burst is the evidence for an action. */
export const primaryEndpointForAction = (action) => {
  if (action === "generate") return "/api/git/diff"
  if (action === "revert-all") return "/api/git/revert"
  if (action === "stage-commit") return "/api/git/commit"
  throw new Error(`Unknown action: ${action}`)
}

/** Request counts the app is expected to fire for an action. */
export const expectedRequestsForAction = (action, plan) => {
  if (action === "generate") {
    return { "/api/git/diff": 2 * Math.min(GIT_DIFF_FILE_LIMIT, plan.stagedPaths.length) }
  }
  if (action === "revert-all") {
    // One POST per changed path, both groups included.
    return { "/api/git/revert": plan.modifiedPaths.length }
  }
  if (action === "stage-commit") {
    // Staging is one batch request; the commit is one more.
    const expected = { "/api/git/commit": 1 }
    if (plan.modifiedPaths.length > 0) expected["/api/git/stage"] = 1
    return expected
  }
  throw new Error(`Unknown action: ${action}`)
}

/**
 * Largest number of entries in flight at the same instant. An end sorts before
 * a start at the same timestamp: a request that finishes exactly when another
 * begins was never in flight alongside it. `endOf` chooses the moment that
 * closes an interval.
 */
const peakOverlap = (entries, endOf) => {
  const events = []
  for (const entry of entries) {
    const start = Number(entry.startedAt)
    if (!Number.isFinite(start)) continue
    const end = Number(endOf(entry))
    events.push({ at: start, delta: 1 })
    events.push({ at: Number.isFinite(end) ? Math.max(end, start) : start, delta: -1 })
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta)
  let current = 0
  let peak = 0
  for (const event of events) {
    current += event.delta
    if (current > peak) peak = current
  }
  return peak
}

/**
 * Client-side concurrency: request start to response headers. A caller that
 * resolves on the headers releases its slot before the body is read, so this
 * is the figure a concurrency limit bounds. A request that failed before any
 * headers arrived still occupied its slot, so it falls back to the completion
 * time.
 */
export const peakInFlight = (entries) => peakOverlap(entries, (entry) => entry.responseAt ?? entry.endedAt)

/**
 * Transfer occupancy: request start to completion (`loadingFinished` or
 * failure). A body can arrive after the client has resolved on the headers,
 * so this figure can exceed the client concurrency on a correct build.
 * `maxDurationMs` is measured over this interval.
 */
export const peakInFlightToComplete = (entries) => peakOverlap(entries, (entry) => entry.endedAt)

/**
 * A request is failed when its transport failed or its HTTP response carried an
 * error status. An HTTP error still completes as `Network.loadingFinished`
 * with `failed: false`, so without the status check a burst of 500s would read
 * as a clean run. `profile-browser.mjs` applies the same rule.
 */
const requestFailed = (entry) => Boolean(entry.failed) || Number(entry.status) >= 400

/**
 * Groups request records by endpoint and reports, per endpoint, the count, both
 * peak overlaps and the duration spread. Failed and cache-served requests stay
 * visible instead of being folded into a clean total; `requestFailed` decides
 * what counts as failed.
 */
export const summarizeTraffic = (entries) => {
  const byEndpoint = {}
  let failed = 0
  let servedFromCache = 0
  for (const entry of entries) {
    const endpoint = entry.endpoint ?? "(unknown)"
    const bucket = byEndpoint[endpoint] ?? {
      count: 0,
      failed: 0,
      servedFromCache: 0,
      peakInFlight: 0,
      peakInFlightToComplete: 0,
      maxDurationMs: 0,
      totalDurationMs: 0,
      methods: {},
    }
    bucket.count += 1
    if (requestFailed(entry)) {
      bucket.failed += 1
      failed += 1
    }
    if (entry.servedFromCache) {
      bucket.servedFromCache += 1
      servedFromCache += 1
    }
    bucket.methods[entry.method ?? "GET"] = (bucket.methods[entry.method ?? "GET"] ?? 0) + 1
    const start = Number(entry.startedAt)
    const end = Number(entry.endedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const durationMs = Math.max(0, end - start) * 1000
      bucket.totalDurationMs += durationMs
      if (durationMs > bucket.maxDurationMs) bucket.maxDurationMs = durationMs
    }
    byEndpoint[endpoint] = bucket
  }
  for (const [endpoint, bucket] of Object.entries(byEndpoint)) {
    const endpointEntries = entries.filter((entry) => (entry.endpoint ?? "(unknown)") === endpoint)
    bucket.peakInFlight = peakInFlight(endpointEntries)
    bucket.peakInFlightToComplete = peakInFlightToComplete(endpointEntries)
    bucket.maxDurationMs = round(bucket.maxDurationMs, 1)
    bucket.totalDurationMs = round(bucket.totalDurationMs, 1)
  }
  return { total: entries.length, failed, servedFromCache, byEndpoint }
}

/**
 * Expected-vs-observed failures for one action's request burst, plus failures
 * on the endpoint that carries the action's evidence. Counts alone would let a
 * burst where every response failed pass with the expected total; the primary
 * endpoint is what the action is judged by, so any failure there is reported.
 * Endpoints the action also touches (staging, supporting reads) keep their
 * failures visible in the summary but do not fail the capture.
 */
export const findMissingRequests = (action, plan, traffic) => {
  const expected = expectedRequestsForAction(action, plan)
  const failures = []
  for (const [endpoint, count] of Object.entries(expected)) {
    const observed = traffic?.byEndpoint?.[endpoint]?.count ?? 0
    if (observed < count) {
      failures.push(`${action}: expected ${count} request(s) to ${endpoint}, observed ${observed}`)
    }
  }
  const primary = primaryEndpointForAction(action)
  const primaryFailed = traffic?.byEndpoint?.[primary]?.failed ?? 0
  if (primaryFailed > 0) {
    failures.push(`${action}: ${primaryFailed} request(s) to ${primary} failed`)
  }
  return failures
}
