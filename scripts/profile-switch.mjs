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
 * - `content`: the timeline holds messages that were not in the DOM before
 *   (they may still be hidden behind the reveal gate);
 * - `visible`: those messages are actually on screen: every new message that
 *   intersects the chat viewport has an effective opacity of 1, so the
 *   timeline reveal (`data-timeline-reveal` pending, then fading) finished;
 * - `revealCleared`: the `data-timeline-reveal` attribute left the DOM;
 * - layout shift after `visible`: how far the messages on screen at reveal
 *   moved within `--shift-window` ms (late code highlighting, images, list
 *   re-measurement, scroll corrections), plus the browser's own layout-shift
 *   score for the same window;
 * - `longestTask`: the longest main-thread task inside the switch window;
 * - the requests the switch triggered, with encoded and decoded bytes per
 *   request and per endpoint pattern, so fan-out and payload regressions are
 *   visible next to the latency they cause.
 *
 * Every session in the plan is visited twice per cycle. A visit is labelled
 * cold when it is the first visit to that session since the page loaded, warm
 * otherwise. `--cold-reload` reloads the page before every cycle, so each
 * cycle yields one cold visit per session.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { expandProjects, expandSessionLists } from "./perf/scenario.mjs"
import { percentile, round } from "./perf/metrics.mjs"
import { createNetworkRecorder, endpointPattern, summarizeRequests } from "./perf/network.mjs"

const HELP = `Usage: bun run profile:switch -- [options]

Measures how long switching sessions from the sidebar takes.

Options:
  --url <url>              OpenChamber URL (default: http://localhost:3000)
  --sessions <ids>         Comma-separated session ids to click, in order.
                           Default: the first --count rows in the sidebar.
  --title <text>           Add the sidebar row whose text contains <text> to
                           the plan (repeatable; combines with --sessions).
                           Use it for long sessions built by
                           perf/seed-long-session.mjs.
  --count <n>              Number of sidebar rows to use when neither
                           --sessions nor --title is given (default: 6)
  --repeat <n>             Cycles through the plan (default: 1). Each cycle
                           visits every session twice.
  --cold-reload            Reload the page before every cycle, parked on a
                           session outside the plan, so every cycle has one
                           cold visit per session.
  --park <id>              Session to open on load (default: the first sidebar
                           row outside the plan). Keeps the restored session
                           out of the plan, so its first click is really cold.
  --settle <seconds>       Wait after load before clicking (default: 12)
  --hover <ms>             Rest the pointer on the row before pressing
                           (default: 400). Sidebar tooltips open on hover, so
                           a click straight after the move would measure the
                           tooltip opening instead of the switch.
  --gap <ms>               Minimum wait after each click (default: 2500). The
                           wait extends until the shift window after
                           'visible' has elapsed, up to 10 s more.
  --shift-window <ms>      How long after 'visible' to watch for layout shift
                           (default: 1500)
  --output <directory>     Artifact directory (default: artifacts/switch-profile-<time>)
  --baseline <directory>   Compare against a previous run's switch-summary.json
  --budget-ack <ms>        Fail when the median warm ack exceeds this
  --budget-content <ms>    Fail when the median warm content time exceeds this
  --budget-visible <ms>    Fail when the median warm visible time exceeds this
  --budget-shift <px>      Fail when any switch shifted visible messages by
                           more than this after the reveal
  --label <text>           Human label stored in the summary
  --inject-script <file>   Run a script in the page before it loads. For
                           attribution experiments and positive controls only
                           (for example, a script that moves content after the
                           reveal, to prove the shift metric reads it); the
                           summary is labelled as a modified app.
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Chrome profile (default: ~/.cache/openchamber-perf-switch-profile).
                           Its storage persists the sidebar and last session per
                           origin, so give each compared build its own fresh one.
  --headless               Run without a visible browser
  --help                   Show this help

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.
`

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000",
    sessions: [],
    titles: [],
    count: 6,
    repeat: 1,
    coldReload: false,
    park: null,
    settle: 12,
    hover: 400,
    gap: 2500,
    shiftWindow: 1500,
    output: null,
    baseline: null,
    budgetAck: null,
    budgetContent: null,
    budgetVisible: null,
    budgetShift: null,
    label: null,
    injectScript: null,
    chrome: null,
    profileDir: join(homedir(), ".cache", "openchamber-perf-switch-profile"),
    headless: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") { console.log(HELP); process.exit(0) }
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--sessions") options.sessions = String(argv[++index]).split(",").map((id) => id.trim()).filter(Boolean)
    else if (value === "--title") options.titles.push(String(argv[++index]))
    else if (value === "--count") options.count = Number(argv[++index])
    else if (value === "--repeat") options.repeat = Number(argv[++index])
    else if (value === "--cold-reload") options.coldReload = true
    else if (value === "--park") options.park = argv[++index]
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--hover") options.hover = Number(argv[++index])
    else if (value === "--gap") options.gap = Number(argv[++index])
    else if (value === "--shift-window") options.shiftWindow = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--baseline") options.baseline = argv[++index]
    else if (value === "--budget-ack") options.budgetAck = Number(argv[++index])
    else if (value === "--budget-content") options.budgetContent = Number(argv[++index])
    else if (value === "--budget-visible") options.budgetVisible = Number(argv[++index])
    else if (value === "--budget-shift") options.budgetShift = Number(argv[++index])
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--inject-script") options.injectScript = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = resolve(argv[++index])
    else if (value === "--headless") options.headless = true
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be a positive integer")
  return options
}

// Installed in the page before each click. Observes the DOM until the clicked
// row is highlighted and until messages that were not on screen before appear,
// then, once per animation frame, until those messages are visible and for
// `shiftWindowMs` after that, tracking how far they move. Records
// animation-frame timestamps so main-thread stalls are visible even when the
// trace is missing.
//
// `visible` does not read the reveal attribute: it multiplies the computed
// opacity of each new on-screen message and its ancestors, so it stays true
// to what the user sees if the reveal mechanism changes. The attribute is
// recorded separately (`revealCleared`, `revealStates`) to explain the number.
const buildProbeSource = (sessionId, shiftWindowMs) => `(() => {
  const messageIds = () => [...document.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id'))
  const before = new Set(messageIds())
  const state = {
    t0: null, ack: null, content: null, visible: null, revealCleared: null, messageCount: null,
    frames: [], revealStates: [], anchors: null, scroller: null, finished: false, shiftDone: false,
    shift: { maxPx: 0, movedFrames: 0, lastMoveAt: null, anchorsLost: 0, scrollHeightChanges: 0, scrollTopChanges: 0, maxScrollTopJump: 0 },
    layoutShifts: [],
  }
  const row = () => document.querySelector('[data-session-row="${sessionId}"]')
  const revealState = () => document.querySelector('[data-timeline-reveal]')?.getAttribute('data-timeline-reveal') ?? 'none'
  const newMessages = () => [...document.querySelectorAll('[data-message-id]')].filter((el) => !before.has(el.getAttribute('data-message-id')))
  const scrollerOf = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY
      if (overflow === 'auto' || overflow === 'scroll') return node
    }
    return null
  }
  const viewportOf = (scroller) => scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight }
  const onScreen = (el, viewport) => {
    const rect = el.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
  }
  const effectiveOpacity = (el) => {
    let opacity = 1
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
    return opacity
  }
  const elapsed = () => performance.now() - state.t0
  const noteReveal = () => {
    const current = revealState()
    if (state.revealStates.at(-1)?.state !== current) state.revealStates.push({ state: current, at: Math.round(elapsed()) })
    if (state.content !== null && state.revealCleared === null && current === 'none') state.revealCleared = elapsed()
  }
  const observer = new MutationObserver(() => {
    if (state.t0 === null) return
    const now = elapsed()
    if (state.ack === null && row()?.getAttribute("aria-current") === "page") state.ack = now
    if (state.content === null) {
      const ids = messageIds()
      if (ids.length > 0 && ids.some((id) => !before.has(id))) { state.content = now; state.messageCount = ids.length }
    }
    noteReveal()
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-current", "data-timeline-reveal"] })
  const layoutShiftObserver = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('layout-shift')
    ? new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.layoutShifts.push(entry) })
    : null
  layoutShiftObserver?.observe({ type: 'layout-shift', buffered: false })
  const checkVisible = () => {
    const fresh = newMessages()
    if (fresh.length === 0) return
    state.scroller ??= scrollerOf(fresh[0])
    const viewport = viewportOf(state.scroller)
    const shown = fresh.filter((el) => onScreen(el, viewport))
    if (shown.length === 0 || !shown.every((el) => effectiveOpacity(el) >= 0.99)) return
    state.visible = elapsed()
    state.anchors = shown.slice(-12).map((el) => ({ id: el.getAttribute('data-message-id'), offset: el.getBoundingClientRect().top - viewport.top, last: null }))
    for (const anchor of state.anchors) anchor.last = anchor.offset
    state.scrollHeight = state.scroller?.scrollHeight ?? null
    state.scrollTop = state.scroller?.scrollTop ?? null
  }
  const trackShift = () => {
    const viewport = viewportOf(state.scroller)
    let movedThisFrame = false
    for (const anchor of state.anchors) {
      const el = document.querySelector('[data-message-id="' + CSS.escape(anchor.id) + '"]')
      if (!el) { anchor.lost = true; continue }
      const offset = el.getBoundingClientRect().top - viewport.top
      state.shift.maxPx = Math.max(state.shift.maxPx, Math.abs(offset - anchor.offset))
      if (Math.abs(offset - anchor.last) > 1) movedThisFrame = true
      anchor.last = offset
    }
    if (movedThisFrame) { state.shift.movedFrames += 1; state.shift.lastMoveAt = elapsed() - state.visible }
    if (state.scroller) {
      if (state.scroller.scrollHeight !== state.scrollHeight) { state.shift.scrollHeightChanges += 1; state.scrollHeight = state.scroller.scrollHeight }
      if (Math.abs(state.scroller.scrollTop - state.scrollTop) > 1) {
        state.shift.scrollTopChanges += 1
        state.shift.maxScrollTopJump = Math.max(state.shift.maxScrollTopJump, Math.abs(state.scroller.scrollTop - state.scrollTop))
      }
      state.scrollTop = state.scroller.scrollTop
    }
    if (elapsed() - state.visible >= ${Number(shiftWindowMs)}) state.shiftDone = true
  }
  const tick = () => {
    if (state.finished) return
    if (state.t0 !== null) {
      state.frames.push(elapsed())
      if (state.content !== null && state.visible === null) checkVisible()
      else if (state.visible !== null && !state.shiftDone) trackShift()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.__openchamberSwitchProbe = {
    start() { state.t0 = performance.now(); performance.mark("switch:start"); noteReveal() },
    done() { return state.shiftDone || (state.t0 !== null && state.content === null && elapsed() > 8000) },
    finish() {
      state.finished = true
      observer.disconnect()
      layoutShiftObserver?.disconnect()
      const gaps = []
      for (let index = 1; index < state.frames.length; index += 1) gaps.push(state.frames[index] - state.frames[index - 1])
      const windowStart = state.visible === null ? null : state.t0 + state.visible
      const inWindow = windowStart === null ? [] : state.layoutShifts.filter((entry) => entry.startTime >= windowStart && entry.startTime <= windowStart + ${Number(shiftWindowMs)})
      const inChat = inWindow.filter((entry) => (entry.sources ?? []).some((source) => source.node && state.scroller?.contains(source.node)))
      return {
        ack: state.ack, content: state.content, visible: state.visible, revealCleared: state.revealCleared,
        messageCount: state.messageCount,
        revealStates: state.revealStates,
        shift: state.visible === null ? null : {
          ...state.shift,
          maxPx: Math.round(state.shift.maxPx * 10) / 10,
          lastMoveAt: state.shift.lastMoveAt === null ? null : Math.round(state.shift.lastMoveAt),
          anchors: state.anchors.length,
          anchorsLost: state.anchors.filter((anchor) => anchor.lost).length,
          layoutShiftScore: Math.round(inWindow.reduce((total, entry) => total + entry.value, 0) * 10000) / 10000,
          layoutShiftEntries: inWindow.length,
          layoutShiftScoreInChat: Math.round(inChat.reduce((total, entry) => total + entry.value, 0) * 10000) / 10000,
          windowMs: ${Number(shiftWindowMs)},
          complete: state.shiftDone,
          // Which element the scroll counters watched; null means only the
          // anchor offsets (against the window) were measured.
          scroller: state.scroller ? state.scroller.tagName.toLowerCase() + '.' + String(state.scroller.className).trim().split(/\\s+/).slice(0, 3).join('.') : null,
        },
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
  "ui.sidebar_tree_item.render",
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

const readSidebarRows = (client) => evaluateValue(client, `[...document.querySelectorAll('[data-session-row]')].map((el) => ({
  id: el.getAttribute('data-session-row'),
  text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
}))`)

const median = (values) => percentile(values, 0.5)

// Metric columns reported per visit type and per session. `pick` reads the
// value from a switch entry; null values are left out of the statistics.
const SWITCH_METRICS = {
  ack: (entry) => entry.ack,
  content: (entry) => entry.content,
  visible: (entry) => entry.visible,
  revealCleared: (entry) => entry.revealCleared,
  longestTask: (entry) => entry.longestTask,
  requests: (entry) => entry.requestCount,
  decodedKb: (entry) => entry.network?.decodedKb ?? null,
  encodedKb: (entry) => entry.network?.encodedKb ?? null,
  shiftMaxPx: (entry) => entry.shift?.maxPx ?? null,
  shiftMovedFrames: (entry) => entry.shift?.movedFrames ?? null,
  layoutShiftScore: (entry) => entry.shift?.layoutShiftScore ?? null,
}

const stats = (entries, pick) => {
  const values = entries.map(pick).filter((value) => Number.isFinite(value))
  if (values.length === 0) return null
  return {
    n: values.length,
    median: round(median(values)),
    p95: round(percentile(values, 0.95)),
    max: round(values.reduce((max, value) => Math.max(max, value), -Infinity)),
  }
}

// Mean requests and bytes per switch for each endpoint, over a set of switches.
const endpointsPerSwitch = (entries) => {
  const groups = new Map()
  for (const entry of entries) {
    for (const group of entry.network?.byEndpoint ?? []) {
      const total = groups.get(group.endpoint) ?? { endpoint: group.endpoint, count: 0, encodedBytes: 0, decodedBytes: 0 }
      total.count += group.count
      total.encodedBytes += group.encodedBytes
      total.decodedBytes += group.decodedBytes
      groups.set(group.endpoint, total)
    }
  }
  const switches = Math.max(1, entries.length)
  return [...groups.values()]
    .map((group) => ({ endpoint: group.endpoint, requestsPerSwitch: round(group.count / switches), decodedKbPerSwitch: round(group.decodedBytes / 1024 / switches, 1), encodedKbPerSwitch: round(group.encodedBytes / 1024 / switches, 1) }))
    .sort((left, right) => right.decodedKbPerSwitch - left.decodedKbPerSwitch || right.requestsPerSwitch - left.requestsPerSwitch)
}

const summarizeVisits = (entries) => {
  if (entries.length === 0) return null
  return {
    switches: entries.length,
    ...Object.fromEntries(Object.entries(SWITCH_METRICS).map(([key, pick]) => [key, stats(entries, pick)])),
    notVisible: entries.filter((entry) => entry.content !== null && entry.visible === null).length,
    endpoints: endpointsPerSwitch(entries),
  }
}

const summarizeSwitches = (switches, titles) => {
  const valid = switches.filter((entry) => entry.ack !== null && entry.content !== null)
  const summary = {}
  for (const visit of ["cold", "warm"]) summary[visit] = summarizeVisits(valid.filter((entry) => entry.visit === visit))
  summary.bySession = Object.fromEntries([...new Set(switches.map((entry) => entry.id))].map((id) => {
    const own = valid.filter((entry) => entry.id === id)
    return [id, {
      title: titles.get(id) ?? null,
      messageCount: own.reduce((max, entry) => Math.max(max, entry.messageCount ?? 0), 0),
      cold: summarizeVisits(own.filter((entry) => entry.visit === "cold")),
      warm: summarizeVisits(own.filter((entry) => entry.visit === "warm")),
    }]
  }))
  summary.invalidSwitches = switches.length - valid.length
  return summary
}

const printComparison = (current, baseline) => {
  const rows = []
  for (const visit of ["cold", "warm"]) {
    for (const metric of Object.keys(SWITCH_METRICS)) {
      const now = current[visit]?.[metric]?.median
      const then = baseline[visit]?.[metric]?.median
      if (now === undefined || then === undefined) continue
      rows.push({ metric: `${visit} ${metric} (median)`, baseline: then, current: now, delta: round(now - then) })
    }
  }
  console.table(rows)
}

const fmt = (value) => (value === null || value === undefined ? "-" : `${Math.round(value)}ms`)

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `switch-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  await mkdir(output, { recursive: true })
  const profileDir = options.profileDir
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
    if (options.injectScript) {
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: await readFile(resolve(options.injectScript), "utf8") })
      console.log(`MODIFIED APP — injected script: ${options.injectScript}`)
    }
    const network = createNetworkRecorder(client)

    // Opens the app parked on `parkId`, so the session it restores is not one
    // of the plan and the first click on every planned session is cold.
    const loadPage = async (parkId) => {
      const url = new URL(options.url)
      if (parkId) url.searchParams.set("session", parkId)
      const loaded = client.once("Page.loadEventFired", 60_000)
      await client.send("Page.navigate", { url: url.toString() })
      await loaded
      console.log(`Loaded ${options.url}${parkId ? ` parked on ${parkId}` : ""}; settling for ${options.settle}s.`)
      await wait(options.settle * 1000)
      const expanded = await expandSessionLists(client)
      if (expanded > 0) await wait(3000)
    }

    let loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: options.url })
    await loaded
    await expandProjects(client)
    await loadPage(options.park)

    const rows = await readSidebarRows(client)
    if (!rows || rows.length === 0) throw new Error("The sidebar rendered no session rows; the scenario never ran.")
    const rowIds = rows.map((row) => row.id)
    const titles = new Map(rows.map((row) => [row.id, row.text]))
    const plan = [...options.sessions]
    for (const title of options.titles) {
      const matches = rows.filter((row) => row.text.includes(title))
      if (matches.length === 0) throw new Error(`No sidebar row contains "${title}".`)
      if (matches.length > 1) console.warn(`Warning: ${matches.length} rows contain "${title}"; using the first (${matches[0].id}).`)
      if (!plan.includes(matches[0].id)) plan.push(matches[0].id)
    }
    if (plan.length === 0) plan.push(...rowIds.slice(0, options.count))
    const missing = plan.filter((id) => !rowIds.includes(id))
    if (missing.length > 0) throw new Error(`Sessions not present in the sidebar: ${missing.join(", ")}`)
    if (plan.length < 2) throw new Error("Need at least two sessions to switch between.")
    const park = options.park ?? rowIds.find((id) => !plan.includes(id)) ?? null
    if (!park && options.coldReload) console.warn("Warning: every sidebar row is in the plan, so a reload restores one of them and its first visit is not cold.")
    if (park && !options.park) await loadPage(park)
    console.log(`Switching between ${plan.length} sessions, two visits each, ${options.repeat} cycle(s)${options.coldReload ? ", page reloaded before each cycle" : ""}.`)

    const traceEvents = []
    client.on("Tracing.dataCollected", ({ value }) => { for (const event of value ?? []) traceEvents.push(event) })
    await client.send("Profiler.setSamplingInterval", { interval: 250 })
    await client.send("Profiler.start")
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing"].join(","),
    })

    const switches = []
    let index = 0
    for (let cycle = 0; cycle < options.repeat; cycle += 1) {
      if (cycle > 0 && options.coldReload) await loadPage(park)
      if (cycle === 0 || options.coldReload) {
        const present = (await readSidebarRows(client)).map((row) => row.id)
        const gone = plan.filter((id) => !present.includes(id))
        if (gone.length > 0) throw new Error(`Sessions missing from the sidebar after reload: ${gone.join(", ")}`)
      }
      const visitedThisLoad = cycle === 0 || options.coldReload ? new Set() : null
      for (const id of [...plan, ...plan]) {
        const visit = visitedThisLoad ? (visitedThisLoad.has(id) ? "warm" : "cold") : "warm"
        visitedThisLoad?.add(id)
        const box = await evaluateValue(client, `(() => {
          const el = document.querySelector('[data-session-row="${id}"]')
          if (!el) return null
          el.scrollIntoView({ block: "center" })
          const rect = el.getBoundingClientRect()
          return { x: rect.x + 60, y: rect.y + rect.height / 2, active: el.getAttribute("aria-current") === "page" }
        })()`)
        if (!box) throw new Error(`Row for ${id} disappeared from the sidebar.`)
        if (box.active) {
          console.warn(`Warning: ${id} was already the active session; this click would measure nothing, skipped.`)
          continue
        }
        await wait(800)
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y })
        await wait(options.hover)
        await evaluateValue(client, buildProbeSource(id, options.shiftWindow))
        await evaluateValue(client, `window.__openchamberStreamPerformance?.reset()`)
        const clickedAt = Date.now()
        await evaluateValue(client, `window.__openchamberSwitchProbe.start()`)
        await pressAt(client, box.x, box.y)
        await wait(options.gap)
        const extendUntil = Date.now() + 10_000
        while (Date.now() < extendUntil && !(await evaluateValue(client, `window.__openchamberSwitchProbe.done()`))) await wait(200)
        const probe = await evaluateValue(client, `window.__openchamberSwitchProbe.finish()`)
        const windowEnd = Date.now()
        await evaluateValue(client, `performance.mark("switch:end")`)
        const renders = await readRenderCounters(client)
        const triggered = network.startedBetween(clickedAt - 5, windowEnd)
        const requests = triggered.map((request) => ({
          at: round(request.wallTime - clickedAt, 0),
          endpoint: `${request.method} ${endpointPattern(request.url, options.url)}`,
          encodedBytes: request.encoded ?? request.streamedEncoded,
          decodedBytes: request.decoded,
          finished: request.finishedAt !== null,
        }))
        const networkSummary = summarizeRequests(triggered, options.url)
        const entry = { index, cycle, id, visit, ...probe, requestCount: triggered.length, requests, network: networkSummary, renders, longestTask: null }
        switches.push(entry)
        const renderSummary = Object.entries(renders).map(([metric, count]) => `${metric.replace(/\.render$/, "")}=${count}`).join(" ")
        console.log(`#${String(index).padStart(2)} ${visit.padEnd(4)} ${id.slice(0, 16)} ack=${fmt(probe.ack)} content=${fmt(probe.content)} visible=${fmt(probe.visible)} shift=${probe.shift ? `${probe.shift.maxPx}px` : "-"} (${probe.messageCount ?? "-"} msgs) longestFrameGap=${fmt(probe.longestFrameGap)} requests=${triggered.length} ${networkSummary.decodedKb}KB ${renderSummary}`)
        index += 1
      }
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
    if (marks.length !== switches.length * 2) console.warn(`Warning: ${marks.length} switch marks for ${switches.length} switches; longest-task attribution may be misaligned.`)
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
      injectedScript: options.injectScript,
      url: options.url,
      sessions: plan,
      park,
      repeat: options.repeat,
      coldReload: options.coldReload,
      shiftWindowMs: options.shiftWindow,
      frameLiveness,
      ...summarizeSwitches(switches, titles),
      switches,
      cpuProfile: summarizeCpuProfile(profile),
    }
    await writeFile(join(output, "switch-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents }))
    await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))

    console.log("")
    const line = (label, value, unit = "ms") => (value ? `${label} ${value.median}${unit} (p95 ${value.p95})` : `${label} -`)
    for (const visit of ["cold", "warm"]) {
      const visitStats = summary[visit]
      if (!visitStats) continue
      console.log(`${visit} (${visitStats.switches}): ${[
        line("ack", visitStats.ack), line("content", visitStats.content), line("visible", visitStats.visible),
        line("shift", visitStats.shiftMaxPx, "px"), line("longest task", visitStats.longestTask),
        line("requests", visitStats.requests, ""), line("decoded", visitStats.decodedKb, "KB"),
      ].join(" · ")}`)
      if (visitStats.notVisible > 0) console.log(`  ${visitStats.notVisible} switch(es) showed content that never became fully visible`)
    }
    for (const [id, session] of Object.entries(summary.bySession)) {
      const describe = (visitStats) => (visitStats ? `visible ${visitStats.visible?.median ?? "-"}ms, shift ${visitStats.shiftMaxPx?.median ?? "-"}px, ${visitStats.decodedKb?.median ?? "-"}KB` : "-")
      console.log(`  ${id.slice(0, 20)} ${String(session.messageCount).padStart(4)} msgs  cold: ${describe(session.cold)}  warm: ${describe(session.warm)}`)
    }
    if (summary.invalidSwitches > 0) console.warn(`Warning: ${summary.invalidSwitches} switch(es) never acknowledged or never showed content; they are excluded from the statistics.`)
    if (baseline) printComparison(summary, baseline)
    console.log(`Artifacts written to ${output}`)

    const failures = []
    if (options.budgetAck !== null && summary.warm && summary.warm.ack.median > options.budgetAck) failures.push(`warm ack median ${summary.warm.ack.median}ms exceeds ${options.budgetAck}ms`)
    if (options.budgetContent !== null && summary.warm && summary.warm.content.median > options.budgetContent) failures.push(`warm content median ${summary.warm.content.median}ms exceeds ${options.budgetContent}ms`)
    if (options.budgetVisible !== null && summary.warm?.visible && summary.warm.visible.median > options.budgetVisible) failures.push(`warm visible median ${summary.warm.visible.median}ms exceeds ${options.budgetVisible}ms`)
    if (options.budgetShift !== null) {
      const worst = switches.reduce((max, entry) => Math.max(max, entry.shift?.maxPx ?? 0), 0)
      if (worst > options.budgetShift) failures.push(`a switch shifted visible messages by ${worst}px, over ${options.budgetShift}px`)
    }
    if (failures.length > 0) {
      console.error(`Budget exceeded: ${failures.join("; ")}`)
      process.exitCode = 1
    }
  } finally {
    client?.close()
    chromeProcess.kill()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
