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
 * - `content`: the timeline renders messages that were not rendered before
 *   (they may still be hidden behind the reveal gate);
 * - `visible`: those messages are actually on screen: every new message that
 *   intersects the chat viewport has an effective opacity of 1, so the
 *   timeline reveal (`data-timeline-reveal` pending) finished;
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

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

import { ACCESSIBILITY_CATEGORY, accessibilityInWindow, accessibilityState, describeAccessibility, FORCE_ACCESSIBILITY_ARGS } from "./perf/accessibility.mjs"
import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from "./perf/cdp.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { expandProjects, expandSessionLists, settlePage } from "./perf/scenario.mjs"
import { percentile, round } from "./perf/metrics.mjs"
import { createNetworkRecorder, endpointPattern, summarizeRequests } from "./perf/network.mjs"
import { buildRenderProbeSource, printRenderProbe, readRenderProbe, RENDER_PROBE_GLOBAL, summarizeRenderProbe } from "./perf/render-probe.mjs"
import { rendererMainThread } from "./perf/trace-analysis.mjs"

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
  --settle <seconds>       Longest wait after load for the app to be ready and
                           its main thread quiet (default: 12)
  --timing                 Timing run: no sampler and no RunTask trace, so the
                           longest task per switch is missing. The figures to
                           compare between builds; attribution needs a run
                           without this flag.
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
  --render-probe           Count renders per component, renders that changed
                           nothing in the DOM, store notifications and DOM
                           mutations per region over the switches after the
                           last page load (every switch without --cold-reload;
                           the last cycle with it), per
                           scripts/perf/render-probe.mjs. Writes
                           render-probe.json. An attribution run: the probe
                           adds work to every commit, so quote counts, not ms.
  --render-probe-hook <Component:index>
                           With --render-probe, record the call stacks that
                           dispatch to this component's hook
  --extra-categories <list> Comma-separated trace categories to add. The
                           accessibility category is always recorded
  --force-accessibility    Launch Chrome with its accessibility tree on, as an
                           accessibility client turns it on (a screen reader,
                           or a macOS app that reads other windows), so every
                           machine and headless runs measure that case
  --rtt <ms>               Emulate a remote server: every HTTP request waits
                           <ms> between being sent and its response headers
                           (CDP Network.emulateNetworkConditions, from page load
                           on). Covers fetch, XHR, the WebSocket handshake and
                           the EventSource connect; does NOT delay WebSocket
                           messages or SSE events after the first. Default 0 (off)
  --down-kbps <n>          With or without --rtt, cap download throughput at
                           <n> kilobits per second (default: unlimited)
  --up-kbps <n>            Cap upload throughput at <n> kilobits per second
  --stream <ids>           Keep these sessions (comma-separated) streaming a
                           reply through every switch: before each click each
                           idle one gets a prompt (the fixture provider only).
                           They may also be in the plan, to switch to and away
                           from them. Needs --dir
  --stream-model <model>   Model for --stream (default: perf/agent-40tools-300cps)
  --dir <path>             Project directory of the sessions (for --stream)
  --cpu-throttle <rate>    Slow the page's CPU by <rate> (Emulation.setCPUThrottlingRate),
                           to approximate a slower or loaded machine
  --no-expand              Leave the sidebar's "Show more" lists as they load,
                           as a user sees them; a large session list expanded
                           in full virtualizes rows out of the DOM
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Chrome profile to reuse (default: a fresh temporary
                           profile per run, removed afterwards). Its storage
                           persists the sidebar and last session per origin, so
                           give each compared build its own fresh one.
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
    timing: false,
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
    renderProbe: false,
    renderProbeHook: null,
    extraCategories: [],
    forceAccessibility: false,
    rtt: 0,
    downKbps: null,
    upKbps: null,
    stream: null,
    streamModel: "perf/agent-40tools-300cps",
    dir: null,
    expand: true,
    cpuThrottle: 1,
    chrome: null,
    profileDir: null,
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
    else if (value === "--timing") options.timing = true
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
    else if (value === "--render-probe") options.renderProbe = true
    else if (value === "--render-probe-hook") options.renderProbeHook = argv[++index]
    else if (value === "--extra-categories") options.extraCategories = String(argv[++index]).split(",").map((category) => category.trim()).filter(Boolean)
    else if (value === "--force-accessibility") options.forceAccessibility = true
    else if (value === "--rtt") options.rtt = Number(argv[++index])
    else if (value === "--down-kbps") options.downKbps = Number(argv[++index])
    else if (value === "--up-kbps") options.upKbps = Number(argv[++index])
    else if (value === "--stream") options.stream = String(argv[++index]).split(",").map((id) => id.trim()).filter(Boolean)
    else if (value === "--stream-model") options.streamModel = argv[++index]
    else if (value === "--dir") options.dir = resolve(argv[++index])
    else if (value === "--no-expand") options.expand = false
    else if (value === "--cpu-throttle") options.cpuThrottle = Number(argv[++index])
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = resolve(argv[++index])
    else if (value === "--headless") options.headless = true
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be a positive integer")
  if (!Number.isFinite(options.rtt) || options.rtt < 0) throw new Error("--rtt must be a non-negative number of milliseconds")
  if (options.stream && !options.dir) throw new Error("--stream needs --dir")
  if (options.stream && !options.streamModel.startsWith("perf/")) throw new Error("--stream-model must be a fixture model (perf/...)")
  for (const [flag, kbps] of [["--down-kbps", options.downKbps], ["--up-kbps", options.upKbps]]) {
    if (kbps !== null && (!Number.isFinite(kbps) || kbps <= 0)) throw new Error(`${flag} must be a positive number`)
  }
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
  // Rendered messages only: a retained timeline keeps its messages in the DOM
  // under display:none, and showing it again is the switch being measured.
  const renderedMessages = () => [...document.querySelectorAll('[data-message-id]')].filter((el) => el.checkVisibility())
  const messageIds = () => renderedMessages().map((el) => el.getAttribute('data-message-id'))
  // Refreshed at the click: a streaming session adds messages during the hover.
  let before = new Set(messageIds())
  // Messages of the previous session still painted on screen after the click
  // (the "old message lingers" glitch), and every new message id seen, with
  // the first and last frame it was on screen; the caller checks afterwards
  // which of them belong to the clicked session.
  const stale = { lastAt: null, frames: 0, ids: new Set() }
  const seen = new Map()
  const paintedOnScreen = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false
    return effectiveOpacity(el) > 0.01
  }
  const trackPainted = () => {
    const now = elapsed()
    let staleThisFrame = false
    for (const el of renderedMessages()) {
      const id = el.getAttribute('data-message-id')
      if (before.has(id)) {
        if (state.ack !== null && paintedOnScreen(el)) { staleThisFrame = true; stale.ids.add(id) }
        continue
      }
      if (!paintedOnScreen(el)) continue
      const entry = seen.get(id)
      if (entry) entry.last = now
      else seen.set(id, { first: now, last: now })
    }
    if (staleThisFrame) { stale.frames += 1; stale.lastAt = now }
  }
  const state = {
    t0: null, ack: null, content: null, visible: null, revealCleared: null, messageCount: null,
    frames: [], revealStates: [], anchors: null, scroller: null, finished: false, shiftDone: false,
    shift: { maxPx: 0, movedFrames: 0, lastMoveAt: null, anchorsLost: 0, scrollHeightChanges: 0, scrollTopChanges: 0, maxScrollTopJump: 0 },
    layoutShifts: [],
  }
  const row = () => document.querySelector('[data-session-row="${sessionId}"]')
  const revealState = () => document.querySelector('[data-timeline-reveal]')?.getAttribute('data-timeline-reveal') ?? 'none'
  const newMessages = () => renderedMessages().filter((el) => !before.has(el.getAttribute('data-message-id')))
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
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "aria-current", "data-timeline-reveal"] })
  const layoutShiftObserver = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('layout-shift')
    ? new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.layoutShifts.push(entry) })
    : null
  layoutShiftObserver?.observe({ type: 'layout-shift', buffered: false })
  // Grouped activity splits one message into several rows that share its
  // data-message-id; the slice tells them apart, so an anchor re-finds the row
  // it was taken from instead of the message's first row.
  const anchorSelector = (el) => {
    const id = '[data-message-id="' + CSS.escape(el.getAttribute('data-message-id')) + '"]'
    const slice = el.getAttribute('data-message-slice')
    return id + (slice === null ? ':not([data-message-slice])' : '[data-message-slice="' + CSS.escape(slice) + '"]')
  }
  const checkVisible = () => {
    const fresh = newMessages()
    if (fresh.length === 0) return
    state.scroller ??= scrollerOf(fresh[0])
    const viewport = viewportOf(state.scroller)
    const shown = fresh.filter((el) => onScreen(el, viewport))
    if (shown.length === 0 || !shown.every((el) => effectiveOpacity(el) >= 0.99)) return
    state.visible = elapsed()
    state.anchors = shown.slice(-12).map((el) => ({ selector: anchorSelector(el), offset: el.getBoundingClientRect().top - viewport.top, last: null }))
    for (const anchor of state.anchors) anchor.last = anchor.offset
    state.scrollHeight = state.scroller?.scrollHeight ?? null
    state.scrollTop = state.scroller?.scrollTop ?? null
  }
  const trackShift = () => {
    const viewport = viewportOf(state.scroller)
    let movedThisFrame = false
    for (const anchor of state.anchors) {
      const el = document.querySelector(anchor.selector)
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
      trackPainted()
      if (state.content !== null && state.visible === null) checkVisible()
      else if (state.visible !== null && !state.shiftDone) trackShift()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.__openchamberSwitchProbe = {
    start() { before = new Set(messageIds()); state.t0 = performance.now(); performance.mark("switch:start"); noteReveal() },
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
        stale: { lastAt: stale.lastAt === null ? null : Math.round(stale.lastAt), frames: stale.frames, ids: [...stale.ids] },
        seen: [...seen].map(([id, entry]) => ({ id, first: Math.round(entry.first), last: Math.round(entry.last) })),
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

const STREAM_TYPES = new Set(["WebSocket", "EventSource"])

/**
 * The longest run of requests that ran one after another before the chat was
 * visible: each starts once the previous one has finished (2 ms slack), all
 * finished before `visible`. Under --rtt every such link costs at least one
 * round trip, so its depth times the RTT is a floor on the switch. "Serial"
 * says they did not overlap, not that the code awaited one before the next;
 * the code locations behind the chain say which waits are real. Streams and
 * requests still open at `visible` are left out.
 */
const serialChain = (requests, visibleMs) => {
  if (!Number.isFinite(visibleMs)) return null
  const spans = requests
    .filter((request) => !STREAM_TYPES.has(request.type) && Number.isFinite(request.endMs) && request.endMs <= visibleMs + 1)
    .sort((left, right) => left.endMs - right.endMs)
  const best = spans.map(() => ({ depth: 1, previous: -1 }))
  for (let index = 0; index < spans.length; index += 1) {
    for (let before = 0; before < index; before += 1) {
      if (spans[before].endMs <= spans[index].startMs + 2 && best[before].depth + 1 > best[index].depth) best[index] = { depth: best[before].depth + 1, previous: before }
    }
  }
  let tail = -1
  for (let index = 0; index < spans.length; index += 1) if (tail < 0 || best[index].depth > best[tail].depth) tail = index
  const chain = []
  for (let index = tail; index >= 0; index = best[index].previous) chain.unshift(spans[index])
  return {
    depth: chain.length,
    requestsBeforeVisible: spans.length,
    chain: chain.map((request) => ({ endpoint: request.endpoint, startMs: request.startMs, endMs: request.endMs })),
  }
}

// Metric columns reported per visit type and per session. `pick` reads the
// value from a switch entry; null values are left out of the statistics.
/**
 * The same-origin request that finished last before the new messages
 * rendered: the one the first paint waited for, if any. `queuedMs` is how
 * long it sat before going out; under --rtt a queued request costs a round
 * trip per request ahead of it.
 */
const contentGate = (requests, contentMs) => {
  if (!Number.isFinite(contentMs)) return null
  // endpointPattern keeps the origin only on cross-origin URLs.
  const candidates = requests.filter((request) => !STREAM_TYPES.has(request.type) && !/^[A-Z]+ https?:/.test(request.endpoint) && Number.isFinite(request.endMs) && request.endMs <= contentMs + 1)
  const gate = candidates.reduce((latest, request) => (latest === null || request.endMs > latest.endMs ? request : latest), null)
  return gate ? { endpoint: gate.endpoint, startMs: gate.startMs, queuedMs: gate.queuedMs, responseMs: gate.responseMs, endMs: gate.endMs } : null
}

const SWITCH_METRICS = {
  ack: (entry) => entry.ack,
  content: (entry) => entry.content,
  visible: (entry) => entry.visible,
  revealCleared: (entry) => entry.revealCleared,
  longestTask: (entry) => entry.longestTask,
  busyToVisible: (entry) => entry.busyToVisible ?? null,
  staleUntil: (entry) => entry.stale?.lastAt ?? null,
  accessibilityMs: (entry) => entry.accessibility?.ms ?? null,
  accessibilityLongestPassMs: (entry) => entry.accessibility?.longestPassMs ?? null,
  requests: (entry) => entry.requestCount,
  serialDepth: (entry) => entry.serialChain?.depth ?? null,
  gateQueuedMs: (entry) => entry.contentGate?.queuedMs ?? null,
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

const CLI_PATH = resolve(import.meta.dirname, "../packages/web/bin/cli.js")

const runSessionCli = (url, args) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [CLI_PATH, "session", ...args, "--port", new URL(url).port, "--json"], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.on("error", reject)
  child.on("close", (code) => {
    try { resolveRun(JSON.parse(stdout)) } catch { reject(new Error(`session ${args[0]} exited with ${code}: ${stdout.slice(0, 300)}`)) }
  })
})

/** Sends a prompt to each stream session unless it is already busy; resolves once all are busy. */
const ensureStreaming = async (options) => (await Promise.all(options.stream.map((sessionId) => ensureSessionStreaming(options, sessionId)))).every(Boolean)

const ensureSessionStreaming = async (options, sessionId) => {
  const base = ["--session", sessionId, "--dir", options.dir]
  const busy = async () => (await runSessionCli(options.url, ["status", ...base]))?.sessionStatus?.type === "busy"
  if (await busy()) return true
  const sent = await runSessionCli(options.url, ["send", ...base, "--prompt", "Keep going with the next part.", "--model", options.streamModel])
  if (sent?.status !== "ok") throw new Error(`Could not start the stream: ${JSON.stringify(sent).slice(0, 300)}`)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await busy()) { await wait(1500); return true }
    await wait(250)
  }
  return false
}

/** Which of the message ids painted after a click belong to `sessionId` (null: unknown). */
const classifySeen = async (options, sessionId, seen) => Promise.all(seen.map(async (entry) => {
  if (!options.dir) return { ...entry, own: null }
  const response = await fetch(`${options.url}/api/session/${sessionId}/message/${entry.id}?directory=${encodeURIComponent(options.dir)}`)
  return { ...entry, own: response.status === 200 ? true : response.status === 404 ? false : null }
}))

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `switch-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  await mkdir(output, { recursive: true })
  const profile = resolveProfileDir(options.profileDir, "switch")
  const chrome = resolveChrome(options.chrome)
  const baseline = options.baseline
    ? JSON.parse(await readFile(join(resolve(options.baseline), "switch-summary.json"), "utf8"))
    : null

  const port = await reservePort()
  const chromeProcess = launchChrome({ chrome, profileDir: profile.dir, port, headless: options.headless, extraArgs: options.forceAccessibility ? FORCE_ACCESSIBILITY_ARGS : [] })
  let client
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Performance.enable"),
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
    if (options.renderProbe) {
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: buildRenderProbeSource({ traceHook: options.renderProbeHook }) })
      console.log("ATTRIBUTION RUN — render probe on; switch timings from this run are inflated.")
    }
    if (options.cpuThrottle > 1) {
      await client.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle })
      console.log(`CPU throttled ${options.cpuThrottle}x.`)
    }
    const network = createNetworkRecorder(client)
    const kbpsToBytes = (kbps) => (kbps === null ? -1 : (kbps * 1000) / 8)
    const networkConditions = options.rtt > 0 || options.downKbps !== null || options.upKbps !== null
      ? { rttMs: options.rtt, downKbps: options.downKbps, upKbps: options.upKbps }
      : null
    if (networkConditions) {
      await client.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: options.rtt,
        downloadThroughput: kbpsToBytes(options.downKbps),
        uploadThroughput: kbpsToBytes(options.upKbps),
      })
      console.log(`Emulated network: ${options.rtt} ms per request${options.downKbps ? `, down ${options.downKbps} kbit/s` : ""}${options.upKbps ? `, up ${options.upKbps} kbit/s` : ""}. WebSocket messages and SSE events after the first are not delayed.`)
    }

    // Opens the app parked on `parkId`, so the session it restores is not one
    // of the plan and the first click on every planned session is cold.
    const loadPage = async (parkId) => {
      const url = new URL(options.url)
      if (parkId) url.searchParams.set("session", parkId)
      const loaded = client.once("Page.loadEventFired", 60_000)
      await client.send("Page.navigate", { url: url.toString() })
      await loaded
      console.log(`Loaded ${options.url}${parkId ? ` parked on ${parkId}` : ""}; settling for up to ${options.settle}s.`)
      const settle = await settlePage(client, options.settle)
      console.log(`Settled after ${settle.seconds}s.`)
      const expanded = options.expand ? await expandSessionLists(client) : 0
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
    if (!options.timing) {
      await client.send("Profiler.setSamplingInterval", { interval: 250 })
      await client.send("Profiler.start")
    }
    // A timing run keeps the marks that place each switch and the accessibility
    // work inside it, without `RunTask` on every thread.
    const categories = [...new Set([...(options.timing ? [] : ["devtools.timeline", "disabled-by-default-devtools.timeline"]), "blink.user_timing", ACCESSIBILITY_CATEGORY, ...options.extraCategories])]
    await client.send("Tracing.start", { transferMode: "ReportEvents", categories: categories.join(",") })

    const switches = []
    let index = 0
    // A reload starts a fresh page and probe, so the probe covers the switches
    // after the last load; without --cold-reload that is every switch.
    const startRenderProbe = () => (options.renderProbe ? evaluateValue(client, `globalThis[${JSON.stringify(RENDER_PROBE_GLOBAL)}]?.start()`) : null)
    await startRenderProbe()
    let probedSwitches = 0
    for (let cycle = 0; cycle < options.repeat; cycle += 1) {
      if (cycle > 0 && options.coldReload) {
        await loadPage(park)
        await startRenderProbe()
        probedSwitches = 0
      }
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
        const streaming = options.stream ? await ensureStreaming(options) : null
        if (options.stream && !streaming) console.warn(`Warning: ${options.stream.join(", ")} did not all become busy before switch #${index}.`)
        await wait(800)
        // Hovering a row prefetches it, so the switch's requests can start here.
        const hoveredAt = Date.now()
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y })
        await wait(options.hover)
        await evaluateValue(client, buildProbeSource(id, options.shiftWindow))
        await evaluateValue(client, `window.__openchamberStreamPerformance?.reset()`)
        // A streaming session moves its row up the sidebar, so the row may
        // have moved during the hover: press where it is now.
        const pressBox = await evaluateValue(client, `(() => {
          const rect = document.querySelector('[data-session-row="${id}"]')?.getBoundingClientRect()
          return rect ? { x: rect.x + 60, y: rect.y + rect.height / 2 } : null
        })()`) ?? box
        if (pressBox.x !== box.x || pressBox.y !== box.y) await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pressBox.x, y: pressBox.y })
        const clickedAt = Date.now()
        await evaluateValue(client, `window.__openchamberSwitchProbe.start()`)
        await pressAt(client, pressBox.x, pressBox.y)
        await wait(options.gap)
        const extendUntil = Date.now() + 10_000
        while (Date.now() < extendUntil && !(await evaluateValue(client, `window.__openchamberSwitchProbe.done()`))) await wait(200)
        const probe = await evaluateValue(client, `window.__openchamberSwitchProbe.finish()`)
        probe.activeAfter = await evaluateValue(client, `document.querySelector('[data-session-row][aria-current="page"]')?.getAttribute('data-session-row') ?? null`)
        if (probe.activeAfter !== id) console.warn(`Warning: switch #${index} left ${probe.activeAfter ?? "no session"} active instead of ${id}; the press missed the row.`)
        const windowEnd = Date.now()
        await evaluateValue(client, `performance.mark("switch:end")`)
        const renders = await readRenderCounters(client)
        const triggered = network.startedBetween(clickedAt - 5, windowEnd)
        const sinceClick = (wall) => (wall === null ? null : round(wall - clickedAt, 0))
        const describeRequest = (request) => ({
          at: round(request.wallTime - clickedAt, 0),
          endpoint: `${request.method} ${endpointPattern(request.url, options.url)}`,
          type: request.type,
          initiator: request.initiator,
          // Milliseconds after the click: sent, response headers, last byte.
          startMs: round(request.wallTime - clickedAt, 0),
          responseMs: sinceClick(request.responseAtWall),
          endMs: sinceClick(request.finishedAtWall),
          queuedMs: request.queuedMs === null ? null : round(request.queuedMs, 0),
          beforeVisible: probe.visible !== null && request.finishedAtWall !== null && request.finishedAtWall - clickedAt <= probe.visible + 1,
          encodedBytes: request.encoded ?? request.streamedEncoded,
          decodedBytes: request.decoded,
          finished: request.finishedAt !== null,
        })
        const requests = triggered.map(describeRequest)
        // Requests sent before the click and still open at it: a hover
        // prefetch the switch may wait for, or requests holding the browser's
        // connections to the host (six per host over HTTP/1.1), which a
        // switch request then queues behind. Event streams opened before the
        // last load are left out (one is open per page).
        const inFlightAtClick = [...network.requests.values()]
          .filter((request) => request.wallTime < clickedAt - 5 && request.wallTime >= hoveredAt - 60_000)
          .filter((request) => (request.finishedAtWall === null ? STREAM_TYPES.has(request.type) || request.wallTime >= hoveredAt - 5 : request.finishedAtWall >= clickedAt))
          .map(describeRequest)
        const chain = serialChain([...inFlightAtClick, ...requests], probe.visible)
        const gate = contentGate([...inFlightAtClick, ...requests], probe.content)
        const networkSummary = summarizeRequests(triggered, options.url)
        probe.seen = await classifySeen(options, id, probe.seen)
        // Messages of another session painted after the click: a stream of
        // the session left behind rendering into the one clicked.
        const foreign = probe.seen.filter((entry) => entry.own === false)
        const entry = { index, cycle, id, visit, streaming, from: switches.at(-1)?.id ?? park, foreign, ...probe, requestCount: triggered.length, requests, inFlightAtClick, serialChain: chain, contentGate: gate, network: networkSummary, renders, longestTask: null }
        switches.push(entry)
        probedSwitches += 1
        const renderSummary = Object.entries(renders).map(([metric, count]) => `${metric.replace(/\.render$/, "")}=${count}`).join(" ")
        console.log(`#${String(index).padStart(2)} ${visit.padEnd(4)} ${id.slice(0, 16)} ack=${fmt(probe.ack)} content=${fmt(probe.content)} visible=${fmt(probe.visible)} shift=${probe.shift ? `${probe.shift.maxPx}px` : "-"} (${probe.messageCount ?? "-"} msgs) longestFrameGap=${fmt(probe.longestFrameGap)} requests=${triggered.length} ${networkSummary.decodedKb}KB ${renderSummary}`)
        if (probe.stale.frames > 0 || foreign.length > 0) console.log(`    previous session painted until ${fmt(probe.stale.lastAt)} (${probe.stale.frames} frames after ack); foreign messages: ${foreign.map((entry) => `${entry.id.slice(0, 14)} ${entry.first}→${entry.last}ms`).join(", ") || "none"}`)
        if (networkConditions && chain) console.log(`    serial depth ${chain.depth} before visible: ${chain.chain.map((request) => `${request.endpoint} [${request.startMs}→${request.endMs}]`).join(" → ")}`)
        if (networkConditions) console.log(`    first paint waited for: ${gate ? `${gate.endpoint} sent ${gate.startMs}, queued ${gate.queuedMs ?? "?"}ms, done ${gate.endMs}` : "no request (rendered from memory)"}`)
        index += 1
      }
    }

    if (options.renderProbe) await evaluateValue(client, `globalThis[${JSON.stringify(RENDER_PROBE_GLOBAL)}]?.stop()`)
    const renderProbeRaw = options.renderProbe ? await readRenderProbe((expression) => evaluateValue(client, expression)) : null
    const tracingComplete = client.once("Tracing.tracingComplete", 120_000)
    await client.send("Tracing.end")
    await tracingComplete
    await wait(500)
    const profile = options.timing ? null : (await client.send("Profiler.stop")).profile

    // Attribute the longest task to each switch from the user-timing marks.
    const marks = traceEvents.filter((event) => event.cat?.includes("blink.user_timing") && (event.name === "switch:start" || event.name === "switch:end"))
      .sort((left, right) => left.ts - right.ts)
    const tasks = traceEvents.filter((event) => event.name === "RunTask" && event.ph === "X" && Number(event.dur) > 0)
    if (tasks.length === 0 && !options.timing) console.warn("Warning: the trace contains no RunTask events; longest-task metrics are unavailable, not zero.")
    if (marks.length !== switches.length * 2) console.warn(`Warning: ${marks.length} switch marks for ${switches.length} switches; longest-task attribution may be misaligned.`)
    let switchIndex = 0
    for (let markIndex = 0; markIndex + 1 < marks.length && switchIndex < switches.length; markIndex += 2) {
      const start = marks[markIndex].ts
      const end = marks[markIndex + 1].ts
      const longest = tasks.filter((event) => event.ts >= start && event.ts <= end).reduce((max, event) => Math.max(max, event.dur / 1000), 0)
      switches[switchIndex].longestTask = tasks.length === 0 ? null : round(longest)
      const { main } = rendererMainThread(traceEvents, { start, end })
      switches[switchIndex].accessibility = accessibilityInWindow(traceEvents, { main, start, end, recorded: true })
      // Main-thread time spent between the click and `visible`.
      const visibleAt = switches[switchIndex].visible
      switches[switchIndex].busyToVisible = tasks.length === 0 || visibleAt === null ? null : round(tasks
        .filter((event) => `${event.pid}:${event.tid}` === main && event.ts >= start && event.ts <= start + visibleAt * 1000)
        .reduce((total, event) => total + event.dur / 1000, 0))
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
      renderProbe: renderProbeRaw ? { ...summarizeRenderProbe(JSON.parse(renderProbeRaw)), switches: probedSwitches } : null,
      url: options.url,
      sessions: plan,
      park,
      repeat: options.repeat,
      coldReload: options.coldReload,
      shiftWindowMs: options.shiftWindow,
      networkConditions,
      cpuThrottle: options.cpuThrottle,
      stream: options.stream ? { session: options.stream, model: options.streamModel } : null,
      frameLiveness,
      accessibility: accessibilityState(traceEvents, { categories, forced: options.forceAccessibility }),
      ...summarizeSwitches(switches, titles),
      switches,
      timing: options.timing,
      cpuProfile: profile ? summarizeCpuProfile(profile) : null,
    }
    await writeFile(join(output, "switch-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents }))
    if (profile) await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))
    if (renderProbeRaw) await writeFile(join(output, "render-probe.json"), renderProbeRaw)

    console.log(`\n${describeAccessibility(summary.accessibility)}`)
    const line = (label, value, unit = "ms") => (value ? `${label} ${value.median}${unit} (p95 ${value.p95})` : `${label} -`)
    for (const visit of ["cold", "warm"]) {
      const visitStats = summary[visit]
      if (!visitStats) continue
      console.log(`${visit} (${visitStats.switches}): ${[
        line("ack", visitStats.ack), line("content", visitStats.content), line("visible", visitStats.visible),
        line("shift", visitStats.shiftMaxPx, "px"), line("longest task", visitStats.longestTask), line("busy to visible", visitStats.busyToVisible), line("old session painted until", visitStats.staleUntil), line("accessibility", visitStats.accessibilityMs),
        line("requests", visitStats.requests, ""), line("serial depth", visitStats.serialDepth, ""), line("decoded", visitStats.decodedKb, "KB"),
      ].join(" · ")}`)
      if (visitStats.notVisible > 0) console.log(`  ${visitStats.notVisible} switch(es) showed content that never became fully visible`)
    }
    for (const [id, session] of Object.entries(summary.bySession)) {
      const describe = (visitStats) => (visitStats ? `visible ${visitStats.visible?.median ?? "-"}ms, shift ${visitStats.shiftMaxPx?.median ?? "-"}px, ${visitStats.decodedKb?.median ?? "-"}KB` : "-")
      console.log(`  ${id.slice(0, 20)} ${String(session.messageCount).padStart(4)} msgs  cold: ${describe(session.cold)}  warm: ${describe(session.warm)}`)
    }
    if (summary.invalidSwitches > 0) console.warn(`Warning: ${summary.invalidSwitches} switch(es) never acknowledged or never showed content; they are excluded from the statistics.`)
    if (summary.renderProbe) printRenderProbe(summary.renderProbe, { perUnit: { label: "switch", count: probedSwitches } })
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
    profile.removeAfter(chromeProcess)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
