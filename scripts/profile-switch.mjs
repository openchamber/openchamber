#!/usr/bin/env node
/**
 * Fully automated session-switch latency capture for OpenChamber.
 *
 * Clicks sidebar session rows with real input events and measures, per click,
 * how long the page takes to acknowledge the click and to show the target
 * session's messages. Everything between those two moments is the
 * "the app strains a little" feeling users report when switching sessions.
 *
 * Reported per switch, in milliseconds after the click:
 * - `ack`: the clicked row is highlighted as active (first visible reaction);
 * - `content`: the timeline shows messages that were not on screen before;
 * - `longestTask`: the longest main-thread task inside the switch window;
 * - the requests the switch triggered, so fan-out regressions are visible.
 *
 * Every session in the plan is visited twice. The first visit is usually a
 * cold load (network round trip); the second is a warm switch served from the
 * in-memory session store. Both are reported separately because they have
 * different budgets.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { expandProjects, expandSessionLists } from "./perf/scenario.mjs"
import { percentile, round } from "./perf/metrics.mjs"

const HELP = `Usage: bun run profile:switch -- [options]

Measures how long switching sessions from the sidebar takes.

Options:
  --url <url>              OpenChamber URL (default: http://localhost:3000)
  --sessions <ids>         Comma-separated session ids to click, in order.
                           Every id is visited twice (cold, then warm).
                           Default: the first 6 rows in the sidebar.
  --count <n>              Number of sidebar rows to use when --sessions is
                           not given (default: 6)
  --settle <seconds>       Wait after load before clicking (default: 12)
  --hover <ms>             Rest the pointer on the row before pressing
                           (default: 400). Sidebar tooltips open on hover, so
                           a click straight after the move would measure the
                           tooltip opening instead of the switch.
  --gap <ms>               Wait after each click before the next (default: 2500)
  --output <directory>     Artifact directory (default: artifacts/switch-profile-<time>)
  --baseline <directory>   Compare against a previous run's switch-summary.json
  --budget-ack <ms>        Fail when the median warm ack exceeds this
  --budget-content <ms>    Fail when the median warm content time exceeds this
  --label <text>           Human label stored in the summary
  --chrome <path>          Chrome/Chromium executable
  --headless               Run without a visible browser
  --help                   Show this help

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.
`

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000",
    sessions: [],
    count: 6,
    settle: 12,
    hover: 400,
    gap: 2500,
    output: null,
    baseline: null,
    budgetAck: null,
    budgetContent: null,
    label: null,
    chrome: null,
    headless: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") { console.log(HELP); process.exit(0) }
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--sessions") options.sessions = String(argv[++index]).split(",").map((id) => id.trim()).filter(Boolean)
    else if (value === "--count") options.count = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--hover") options.hover = Number(argv[++index])
    else if (value === "--gap") options.gap = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--baseline") options.baseline = argv[++index]
    else if (value === "--budget-ack") options.budgetAck = Number(argv[++index])
    else if (value === "--budget-content") options.budgetContent = Number(argv[++index])
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--headless") options.headless = true
    else throw new Error(`Unknown option: ${value}`)
  }
  return options
}

// Installed in the page before each click. Observes the DOM until the clicked
// row is highlighted and until messages that were not on screen before appear,
// and records animation-frame timestamps so main-thread stalls are visible even
// when the trace is missing.
const buildProbeSource = (sessionId) => `(() => {
  const before = new Set([...document.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id')))
  const state = { t0: null, ack: null, content: null, messageCount: null, frames: [] }
  const row = () => document.querySelector('[data-session-row="${sessionId}"]')
  const observer = new MutationObserver(() => {
    if (state.t0 === null) return
    const now = performance.now()
    if (state.ack === null && row()?.getAttribute("aria-current") === "page") state.ack = now - state.t0
    if (state.content === null) {
      const ids = [...document.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id'))
      if (ids.length > 0 && ids.some((id) => !before.has(id))) { state.content = now - state.t0; state.messageCount = ids.length }
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-current"] })
  const tick = () => {
    if (state.t0 !== null) state.frames.push(performance.now() - state.t0)
    if (state.frames.length < 300) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.__openchamberSwitchProbe = {
    start() { state.t0 = performance.now(); performance.mark("switch:start") },
    finish() {
      observer.disconnect()
      const gaps = []
      for (let index = 1; index < state.frames.length; index += 1) gaps.push(state.frames[index] - state.frames[index - 1])
      return {
        ack: state.ack, content: state.content, messageCount: state.messageCount,
        firstFrame: state.frames[0] ?? null,
        longestFrameGap: gaps.reduce((max, gap) => Math.max(max, gap), 0),
        framesRecorded: state.frames.length,
      }
    },
  }
  return true
})()`

const pressAt = async (client, x, y) => {
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
}

// Render counters worth reading per switch. They are the app's own stream
// perf counters, so the numbers mean "React renders of that component".
const RENDER_COUNTERS = [
  "ui.session_sidebar.render",
  "ui.sidebar_projects_list.render",
  "ui.sidebar_session_node.render",
  "ui.message_list.render",
  "ui.chat_message.render",
  "ui.markdown_renderer.settled_paint.reused",
  "ui.markdown_renderer.dom_cache.hit",
]

const readRenderCounters = async (client) => {
  const entries = await evaluateValue(client, `(window.__openchamberStreamPerformance?.getSnapshot().entries ?? []).map((entry) => [entry.metric, entry.count])`)
  const counters = {}
  for (const [metric, count] of entries ?? []) if (RENDER_COUNTERS.includes(metric)) counters[metric.replace(/^ui\./, "")] = count
  return counters
}

const median = (values) => percentile(values, 0.5)

const summarizeSwitches = (switches) => {
  const valid = switches.filter((entry) => entry.ack !== null && entry.content !== null)
  const byVisit = (visit) => valid.filter((entry) => entry.visit === visit)
  const stats = (entries, key) => ({
    median: round(median(entries.map((entry) => entry[key]))),
    p95: round(percentile(entries.map((entry) => entry[key]), 0.95)),
    max: round(entries.reduce((max, entry) => Math.max(max, entry[key]), 0)),
  })
  const summary = {}
  for (const visit of ["cold", "warm"]) {
    const entries = byVisit(visit)
    summary[visit] = entries.length === 0 ? null : {
      switches: entries.length,
      ack: stats(entries, "ack"),
      content: stats(entries, "content"),
      longestTask: stats(entries, "longestTask"),
      requests: stats(entries, "requestCount"),
    }
  }
  return summary
}

const printComparison = (current, baseline) => {
  const rows = []
  for (const visit of ["cold", "warm"]) {
    for (const metric of ["ack", "content", "longestTask", "requests"]) {
      const now = current[visit]?.[metric]?.median
      const then = baseline[visit]?.[metric]?.median
      if (now === undefined || then === undefined) continue
      rows.push({ metric: `${visit} ${metric} (median)`, baseline: then, current: now, delta: round(now - then) })
    }
  }
  console.table(rows)
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `switch-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  await mkdir(output, { recursive: true })
  const profileDir = join(homedir(), ".cache", "openchamber-perf-switch-profile")
  const chrome = resolveChrome(options.chrome)
  const baseline = options.baseline
    ? JSON.parse(await readFile(join(resolve(options.baseline), "switch-summary.json"), "utf8"))
    : null

  const port = await reservePort()
  const chromeProcess = launchChrome({ chrome, profileDir, port, headless: options.headless })
  let client
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Profiler.enable"),
      client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
    ])
    await client.send("Network.setBypassServiceWorker", { bypass: true })
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    // The app's render counters are off by default; the flag is read at load.
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("openchamber_stream_perf", "1") } catch {}`,
    })

    let loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: options.url })
    await loaded
    await expandProjects(client)
    loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.reload")
    await loaded
    console.log(`Loaded ${options.url}; settling for ${options.settle}s.`)
    await wait(options.settle * 1000)
    const expanded = await expandSessionLists(client)
    if (expanded > 0) await wait(3000)

    const rows = await evaluateValue(client, `[...document.querySelectorAll('[data-session-row]')].map((el) => el.getAttribute('data-session-row'))`)
    if (!rows || rows.length === 0) throw new Error("The sidebar rendered no session rows; the scenario never ran.")
    const plan = options.sessions.length > 0 ? options.sessions : rows.slice(0, options.count)
    const missing = plan.filter((id) => !rows.includes(id))
    if (missing.length > 0) throw new Error(`Sessions not present in the sidebar: ${missing.join(", ")}`)
    if (plan.length < 2) throw new Error("Need at least two sessions to switch between.")
    console.log(`Switching between ${plan.length} sessions, two visits each.`)

    const requests = new Map()
    client.on("Network.requestWillBeSent", (params) => {
      requests.set(params.requestId, { url: params.request.url, wallTime: params.wallTime * 1000 })
    })

    const traceEvents = []
    client.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...(value ?? [])))
    await client.send("Profiler.setSamplingInterval", { interval: 250 })
    await client.send("Profiler.start")
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing"].join(","),
    })

    const switches = []
    const visits = [...plan.map((id) => ({ id, visit: "cold" })), ...plan.map((id) => ({ id, visit: "warm" }))]
    for (const [index, { id, visit }] of visits.entries()) {
      const box = await evaluateValue(client, `(() => {
        const el = document.querySelector('[data-session-row="${id}"]')
        if (!el) return null
        el.scrollIntoView({ block: "center" })
        const rect = el.getBoundingClientRect()
        return { x: rect.x + 60, y: rect.y + rect.height / 2 }
      })()`)
      if (!box) throw new Error(`Row for ${id} disappeared from the sidebar.`)
      await wait(800)
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y })
      await wait(options.hover)
      await evaluateValue(client, buildProbeSource(id))
      await evaluateValue(client, `window.__openchamberStreamPerformance?.reset()`)
      const clickedAt = Date.now()
      await evaluateValue(client, `window.__openchamberSwitchProbe.start()`)
      await pressAt(client, box.x, box.y)
      await wait(options.gap)
      const probe = await evaluateValue(client, `window.__openchamberSwitchProbe.finish()`)
      await evaluateValue(client, `performance.mark("switch:end")`)
      const renders = await readRenderCounters(client)
      const triggered = [...requests.values()]
        .filter((request) => request.wallTime >= clickedAt - 5 && request.wallTime <= clickedAt + 1500)
        .map((request) => ({ at: round(request.wallTime - clickedAt, 0), url: request.url.replace(options.url, "").split("?")[0] }))
      const entry = { index, id, visit, ...probe, requestCount: triggered.length, requests: triggered, renders, longestTask: null }
      switches.push(entry)
      const renderSummary = Object.entries(renders).map(([metric, count]) => `${metric.replace(/\.render$/, "")}=${count}`).join(" ")
      console.log(`#${String(index).padStart(2)} ${visit.padEnd(4)} ${id.slice(0, 16)} ack=${fmt(probe.ack)} content=${fmt(probe.content)} (${probe.messageCount ?? "-"} msgs) longestFrameGap=${fmt(probe.longestFrameGap)} requests=${triggered.length} ${renderSummary}`)
    }

    const tracingComplete = client.once("Tracing.tracingComplete", 120_000)
    await client.send("Tracing.end")
    await tracingComplete
    await wait(500)
    const { profile } = await client.send("Profiler.stop")

    // Attribute the longest task to each switch from the user-timing marks.
    const marks = traceEvents.filter((event) => event.cat?.includes("blink.user_timing") && (event.name === "switch:start" || event.name === "switch:end"))
      .sort((left, right) => left.ts - right.ts)
    const tasks = traceEvents.filter((event) => event.name === "RunTask" && event.ph === "X" && Number(event.dur) > 0)
    if (tasks.length === 0) console.warn("Warning: the trace contains no RunTask events; longest-task metrics are unavailable, not zero.")
    let switchIndex = 0
    for (let markIndex = 0; markIndex + 1 < marks.length && switchIndex < switches.length; markIndex += 2) {
      const start = marks[markIndex].ts
      const end = marks[markIndex + 1].ts
      const longest = tasks.filter((event) => event.ts >= start && event.ts <= end).reduce((max, event) => Math.max(max, event.dur / 1000), 0)
      switches[switchIndex].longestTask = tasks.length === 0 ? null : round(longest)
      switchIndex += 1
    }

    const frameLiveness = await evaluateValue(client, `new Promise((resolve) => {
      let frames = 0
      const startedAt = performance.now()
      const tick = () => { frames += 1; if (performance.now() - startedAt < 1000) requestAnimationFrame(tick); else resolve(frames) }
      requestAnimationFrame(tick)
      setTimeout(() => resolve(frames), 2000)
    })`)
    if (Number(frameLiveness) < 20) console.warn(`Warning: the renderer produced ${frameLiveness} frames/s; it may have been throttled.`)

    const summary = {
      recordedAt: new Date().toISOString(),
      label: options.label,
      url: options.url,
      sessions: plan,
      ...summarizeSwitches(switches),
      switches,
      cpuProfile: summarizeCpuProfile(profile),
    }
    await writeFile(join(output, "switch-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents }))
    await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))

    console.log("")
    for (const visit of ["cold", "warm"]) {
      const stats = summary[visit]
      if (!stats) continue
      console.log(`${visit}: ack median ${stats.ack.median}ms (p95 ${stats.ack.p95}) · content median ${stats.content.median}ms (p95 ${stats.content.p95}) · longest task median ${stats.longestTask.median}ms · requests median ${stats.requests.median}`)
    }
    if (baseline) printComparison(summary, baseline)
    console.log(`Artifacts written to ${output}`)

    const failures = []
    if (options.budgetAck !== null && summary.warm && summary.warm.ack.median > options.budgetAck) failures.push(`warm ack median ${summary.warm.ack.median}ms exceeds ${options.budgetAck}ms`)
    if (options.budgetContent !== null && summary.warm && summary.warm.content.median > options.budgetContent) failures.push(`warm content median ${summary.warm.content.median}ms exceeds ${options.budgetContent}ms`)
    if (failures.length > 0) {
      console.error(`Budget exceeded: ${failures.join("; ")}`)
      process.exitCode = 1
    }
  } finally {
    client?.close()
    chromeProcess.kill()
  }
}

const fmt = (value) => (value === null || value === undefined ? "-" : `${Math.round(value)}ms`)

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
