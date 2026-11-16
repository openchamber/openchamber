/**
 * Scenario setup shared by the idle and streaming profilers.
 *
 * Idle and streaming cost both depend on how much of the sidebar is mounted,
 * so both commands need the same way to reach a heavily populated sidebar.
 * Setup always runs before the measured window.
 */

import process from "node:process"

import { evaluateValue, wait } from "./cdp.mjs"
import { metricMap } from "./metrics.mjs"

const QUIET_WINDOW_MS = 500
const QUIET_WINDOWS = 3
const QUIET_BUSY_SHARE = 0.05
// After load the app goes quiet for about a second, then starts its deferred
// work: a burst of requests and main-thread work that ends by 7 s (measured
// second by second). Quiet alone would end the wait inside that gap, and the
// burst would land in the measured window.
const DEFERRED_STARTUP_SECONDS = 7
const READY = `!!document.querySelector('[data-chat-input="true"]') && !!document.querySelector("[data-session-row]") && !document.getElementById("initial-loading")`

/**
 * Waits past the app's deferred startup work until it shows its composer and
 * session rows, its main thread has stayed under 5% busy and it has started no
 * request for 1.5 s, for at most `seconds`. Pass `afterLoad: false` when the
 * page loaded long ago. The page must have the Performance and Network domains
 * enabled. `PERF_FIXED_SETTLE=1` waits the whole `seconds`, to check a scenario
 * against the fixed wait.
 */
export const settlePage = async (client, seconds, { afterLoad = true } = {}) => {
  const startedAt = Date.now()
  const elapsed = () => Math.round((Date.now() - startedAt) / 100) / 10
  if (process.env.PERF_FIXED_SETTLE) {
    await wait(seconds * 1000)
    return { seconds: elapsed(), settled: null }
  }
  let requestStarted = false
  const unsubscribe = client.on("Network.requestWillBeSent", () => { requestStarted = true })
  try {
    if (afterLoad) await wait(Math.min(seconds, DEFERRED_STARTUP_SECONDS) * 1000)
    let previous = null
    let quietWindows = 0
    while (Date.now() - startedAt < seconds * 1000) {
      requestStarted = false
      await wait(QUIET_WINDOW_MS)
      const ready = await evaluateValue(client, READY)
      const taskSeconds = Number(metricMap((await client.send("Performance.getMetrics")).metrics).TaskDuration ?? 0)
      const quiet = previous !== null && !requestStarted && taskSeconds - previous < (QUIET_WINDOW_MS / 1000) * QUIET_BUSY_SHARE
      previous = taskSeconds
      quietWindows = ready && quiet ? quietWindows + 1 : 0
      if (quietWindows >= QUIET_WINDOWS) return { seconds: elapsed(), settled: true }
    }
  } finally {
    unsubscribe()
  }
  console.warn(`WARNING: the page was not ready and quiet after ${seconds}s; measuring anyway.`)
  return { seconds: elapsed(), settled: false }
}

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
