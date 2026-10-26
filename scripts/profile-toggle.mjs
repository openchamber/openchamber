#!/usr/bin/env node
/**
 * What toggling the left session sidebar and the right context panel costs.
 *
 * Opens a session from the sidebar, then toggles each side the way a user
 * does (a real click on the toggle button, or the keyboard shortcut) and
 * records, per toggle:
 * - the input task and the time from the input to the next main-thread frame,
 *   plus the browser's Event Timing duration when it is over 16 ms;
 * - frame pacing over the animation: animation-frame gaps against the
 *   display's refresh interval (dropped frames, worst frame), and long
 *   animation frames with the scripts inside them;
 * - from the trace: style recalcs and layouts (count, time, elements,
 *   worst frame), and forced style/layout with the JS stacks that forced it;
 * - the accessibility tree's serialization inside the window, which Chrome
 *   does only while an accessibility client is on (`--force-accessibility`
 *   turns it on);
 * - React commits and renders inside the window with `--render-probe`;
 * - the transition the browser actually ran, and the target's width before
 *   and after.
 *
 * Validity: a toggle fails when the width did not change the expected way,
 * the page never saw the input, the width transition is declared but never
 * ran (or is not declared without reduced motion), the window produced no
 * frames, the trace has no renderer main thread for it, or, with --open-file,
 * the editor does not show the file after the panel opened. The run writes its
 * summary and exits non-zero.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

import { ACCESSIBILITY_CATEGORY, accessibilityInWindow, accessibilityState, describeAccessibility, FORCE_ACCESSIBILITY_ARGS } from "./perf/accessibility.mjs"
import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from "./perf/cdp.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { percentile, round } from "./perf/metrics.mjs"
import { buildRenderProbeSource, printRenderProbe, readRenderProbe, RENDER_PROBE_GLOBAL, summarizeRenderProbe } from "./perf/render-probe.mjs"
import { expandProjects, expandSessionLists } from "./perf/scenario.mjs"
import { analyzeToggleWindow, estimateRefreshMs, frameStats, measuredToggles, rendersInWindow, summarizeByType } from "./perf/toggle-analysis.mjs"
import { rendererMainThread, shortUrl } from "./perf/trace-analysis.mjs"

// Rail icon of each context surface (lib/surfaces/registry.ts; diff draws
// DiffViewIcon, whose glyph is layout-column). Icons, not labels, so the
// lookup does not depend on the UI language. Builds that carry the stable
// hooks are found by `data-context-surface` (the registry id) instead; the
// icons stay for older builds, so a baseline from before the hooks measures.
const SURFACE_ICONS = { file: "file-edit", diff: "layout-column", git: "git-branch", terminal: "terminal-box", context: "donut-chart-fill", notes: "book-marked" }
const SURFACE_IDS = { file: "editor", diff: "diff", git: "git", terminal: "terminal", context: "context", notes: "notes" }

// Page-side lookups shared by the recorder and the runner. The sidebar is
// `[data-left-sidebar]`; the right side is the slot `[data-right-slot]`, which
// holds the context panel and the work-status card and says whether the panel
// is open in `data-context-panel-open` (closed, it may still be as wide as the
// card). Older builds: the sidebar aside by class, the panel aside, open when
// wider than 1 px.
const PAGE_TARGETS = `{
  sidebar: () => document.querySelector("[data-left-sidebar]")
    ?? [...document.querySelectorAll("aside.bg-sidebar")].find((element) => !element.closest('[role="dialog"]')) ?? null,
  panel: () => document.querySelector("[data-right-slot]") ?? document.querySelector('aside[data-context-panel="true"]'),
}`
const PAGE_IS_OPEN = `(kind, element) => {
  if (!element) return null
  const flag = kind === "panel" ? element.getAttribute("data-context-panel-open") : null
  if (flag !== null) return flag === "true"
  return element.getBoundingClientRect().width > 1
}`

const PHASES = {
  sidebar: { kind: "sidebar", panelOpen: false, types: ["sidebar-close", "sidebar-open"] },
  panel: { kind: "panel", panelOpen: false, types: ["panel-open", "panel-close"] },
  "sidebar-with-panel": { kind: "sidebar", panelOpen: true, types: ["sidebar-close@panel", "sidebar-open@panel"] },
}

const HELP = `Usage: bun run profile:toggle -- [options]

Toggles the left session sidebar and the right context panel in an open
session and reports, per toggle type, the input task, input to next frame,
dropped and worst frames, style/layout work, forced layouts with their JS
stacks, and the transition the browser ran.

Scenario:
  --url <url>              OpenChamber URL (default: http://localhost:3000)
  --title <text>           Open the sidebar row containing this text
                           (default: "perf: long 120", from seed-long-session.mjs)
  --session <id>           Open this session's sidebar row instead of --title
  --phases <list>          Comma-separated, in order (default: all):
                           sidebar             left sidebar close/open, panel closed
                           panel               context panel open/close, sidebar open
                           sidebar-with-panel  left sidebar close/open, panel open
  --surface <mode>         Context surface the panel opens with (default: file).
                           One of: ${Object.keys(SURFACE_ICONS).join(", ")}
  --open-file <name>       With --surface file: before measuring, open this file
                           from the panel's file tree (a root-level entry of the
                           project, matched by name), so every panel toggle shows
                           the editor with it. A panel-open toggle whose editor
                           is not showing the file afterwards is invalid
  --method <click|key>     Click the real toggle button (default), or press the
                           shortcut: mod+b for the sidebar, mod+alt+<rail digit>
                           for the panel
  --mod <meta|ctrl>        Modifier for --method key (default: meta on macOS,
                           ctrl elsewhere, as the app reads it)
  --count <n>              Measured close/open pairs per phase (default: 5)
  --warmup <n>             Pairs per phase before measuring, recorded but left
                           out of the statistics (default: 1). The first panel
                           open loads its surface; the first click closes the
                           button's hover tooltip
  --hover <ms>             Rest the pointer on the button before a phase's first
                           click (default: 400)
  --pre <ms>               Frames sampled before each input, for the refresh
                           interval (default: 400)
  --window <ms>            Longest wait for the transition to end (default: 2000)
  --tail <ms>              Recorded after the transition ended (default: 250)
  --settle <ms>            Quiet time between toggles, unrecorded (default: 1000)
  --load-settle <seconds>  Wait after load before opening the session (default: 12)
  --reduced-motion         Emulate prefers-reduced-motion: reduce

Instruments:
  --render-probe           Count React commits and renders per toggle
                           (scripts/perf/render-probe.mjs). Attribution only:
                           the probe inflates timings
  --render-probe-hook <Component:index>
                           With --render-probe, record who dispatches to this hook
  --cpu-profile            Also record a CPU sampling profile for profile:analyze
                           (adds overhead to every timing)
  --inject-script <file>   Run a script in the page before it loads (ablations,
                           positive controls); the summary is marked modified
  --extra-categories <list>
                           Comma-separated trace categories to add (such as cc,gpu
                           to see the compositor behind a long main-thread Commit).
                           The accessibility category is always recorded
  --force-accessibility    Launch Chrome with its accessibility tree on, as an
                           accessibility client (a screen reader, or a macOS app
                           that reads other windows) turns it on, so every
                           machine and headless runs measure that case

Output:
  --output <directory>     Artifact directory (default: artifacts/toggle-profile-<time>)
  --label <text>           Human label stored in the summary
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Chrome profile to reuse (default: a fresh temporary
                           profile per run, removed afterwards)
  --headless               Run without a visible browser. Frame pacing then comes
                           from a software compositor; confirm frame claims headed
  --help                   Show this help

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.
Writes toggle-summary.json and trace.json (and cpu-profile.cpuprofile,
render-probe.json when asked).`

const positiveInteger = (value, name, { allowZero = false } = {}) => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`)
  return value
}

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000", title: "perf: long 120", session: null, phases: Object.keys(PHASES), surface: "file", openFile: null,
    method: "click", mod: null, count: 5, warmup: 1, hover: 400, pre: 400, window: 2000, tail: 250, settle: 1000,
    loadSettle: 12, reducedMotion: false, renderProbe: false, renderProbeHook: null, cpuProfile: false, injectScript: null, extraCategories: [], forceAccessibility: false,
    output: null, label: null, chrome: null, profileDir: null, headless: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") { console.log(HELP); process.exit(0) }
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--title") options.title = String(argv[++index])
    else if (value === "--session") options.session = argv[++index]
    else if (value === "--phases") options.phases = String(argv[++index]).split(",").map((name) => name.trim()).filter(Boolean)
    else if (value === "--surface") options.surface = argv[++index]
    else if (value === "--open-file") options.openFile = String(argv[++index])
    else if (value === "--method") options.method = argv[++index]
    else if (value === "--mod") options.mod = argv[++index]
    else if (value === "--count") options.count = Number(argv[++index])
    else if (value === "--warmup") options.warmup = Number(argv[++index])
    else if (value === "--hover") options.hover = Number(argv[++index])
    else if (value === "--pre") options.pre = Number(argv[++index])
    else if (value === "--window") options.window = Number(argv[++index])
    else if (value === "--tail") options.tail = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--load-settle") options.loadSettle = Number(argv[++index])
    else if (value === "--reduced-motion") options.reducedMotion = true
    else if (value === "--render-probe") options.renderProbe = true
    else if (value === "--render-probe-hook") options.renderProbeHook = argv[++index]
    else if (value === "--cpu-profile") options.cpuProfile = true
    else if (value === "--inject-script") options.injectScript = argv[++index]
    else if (value === "--extra-categories") options.extraCategories = String(argv[++index]).split(",").map((name) => name.trim()).filter(Boolean)
    else if (value === "--force-accessibility") options.forceAccessibility = true
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = resolve(argv[++index])
    else if (value === "--headless") options.headless = true
    else throw new Error(`Unknown option: ${value}`)
  }
  const unknownPhases = options.phases.filter((name) => !PHASES[name])
  if (unknownPhases.length || options.phases.length === 0) throw new Error(`--phases takes ${Object.keys(PHASES).join(", ")}`)
  if (!SURFACE_ICONS[options.surface]) throw new Error(`--surface takes ${Object.keys(SURFACE_ICONS).join(", ")}`)
  if (options.openFile !== null && options.surface !== "file") throw new Error("--open-file needs --surface file")
  if (!["click", "key"].includes(options.method)) throw new Error("--method is click or key")
  if (options.mod !== null && !["meta", "ctrl"].includes(options.mod)) throw new Error("--mod is meta or ctrl")
  positiveInteger(options.count, "--count")
  positiveInteger(options.warmup, "--warmup", { allowZero: true })
  for (const key of ["hover", "pre", "window", "tail", "settle", "loadSettle"]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a non-negative number`)
  }
  if (options.pre < 150) throw new Error("--pre must be at least 150 ms, or the refresh interval cannot be estimated")
  return options
}

/**
 * Page-side recorder, installed once after load. Must never change what the
 * app does: it reads geometry only before a toggle starts and after it ends
 * (outside the recorded window), takes widths during the animation from a
 * ResizeObserver (which runs after layout and forces none), and keeps an
 * animation-frame loop only while a toggle is armed.
 */
function installToggleProbe(targets, isOpenOf) {
  if (window.__openchamberToggleProbe) return true
  const workStatus = () => document.querySelector('aside[aria-label="Work status"]')
  const widthOf = (element) => (element ? Math.round(element.getBoundingClientRect().width * 10) / 10 : null)
  const supports = (type) => globalThis.PerformanceObserver?.supportedEntryTypes?.includes(type) === true
  const MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift"])
  const INPUT_EVENTS = new Set(["click", "pointerdown", "pointerup", "keydown", "keyup"])
  let state = null

  // Longest transition-duration among the properties that animate width.
  const declaredTransitionMs = (style) => {
    const properties = style.transitionProperty.split(",").map((value) => value.trim())
    const durations = style.transitionDuration.split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000))
    let longest = 0
    properties.forEach((property, index) => {
      if (property === "width" || property === "all") longest = Math.max(longest, durations[index % durations.length] || 0)
    })
    return longest
  }

  const settle = (current, timedOut) => {
    if (current.settled) return
    current.settled = true
    current.timedOut = timedOut
    clearTimeout(current.quietTimer)
    clearTimeout(current.windowTimer)
    setTimeout(() => current.resolveDone(), timedOut ? 0 : current.tailMs)
  }

  const onInput = (event) => {
    const current = state
    if (!current || current.t0 === null || current.inputAt !== null) return
    if (event.type === "keydown" && MODIFIERS.has(event.key)) return
    current.inputAt = event.timeStamp
    current.inputType = event.type
    // The frame after the input: its animation-frame callbacks, then style,
    // layout and paint, then this message task.
    requestAnimationFrame(() => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => { current.nextFrameAt = performance.now() }
      channel.port2.postMessage(null)
    })
  }

  const onTransition = (event) => {
    const current = state
    if (!current || event.target !== current.element || event.propertyName !== "width") return
    if (event.type === "transitionrun") current.transition.runAt ??= event.timeStamp
    else if (event.type === "transitionstart") current.transition.startAt ??= event.timeStamp
    else {
      current.transition.endAt = event.timeStamp
      current.transition.ended = event.type
      settle(current, false)
    }
  }

  window.__openchamberToggleProbe = {
    /** Prepares one toggle and starts sampling frames; returns the state before it. */
    arm({ kind, index, windowMs, tailMs }) {
      const element = targets[kind]()
      if (!element) return { error: `the ${kind} element was not found` }
      const style = getComputedStyle(element)
      const current = {
        kind, index, element, tailMs, t0: null, inputAt: null, inputType: null, nextFrameAt: null, frames: [],
        finished: false, settled: false, timedOut: false, quietTimer: null, windowTimer: null, windowMs,
        widthBefore: widthOf(element), openBefore: isOpenOf(kind, element), workStatusBefore: widthOf(workStatus()),
        declaredMs: declaredTransitionMs(style), transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        visibility: document.visibilityState, focused: document.hasFocus(),
        transition: { runAt: null, startAt: null, endAt: null, ended: null },
        resize: { last: null, changes: 0, firstAt: null, lastAt: null },
        loaf: [], events: [], resizeObserver: null, loafObserver: null, eventObserver: null,
      }
      current.done = new Promise((resolveDone) => { current.resolveDone = resolveDone })
      const tick = (at) => {
        if (current.finished) return
        current.frames.push(at)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
          if (current.resize.last !== null && Math.abs(width - current.resize.last) > 0.5 && current.t0 !== null) {
            const now = performance.now()
            current.resize.changes += 1
            current.resize.firstAt ??= now
            current.resize.lastAt = now
            // Without a declared transition there is no transitionend: the
            // toggle ends once the width stopped changing.
            if (!(current.declaredMs > 0)) {
              clearTimeout(current.quietTimer)
              current.quietTimer = setTimeout(() => settle(current, false), 150)
            }
          }
          current.resize.last = width
        }
      })
      resizeObserver.observe(element)
      current.resizeObserver = resizeObserver
      current.loafSupported = supports("long-animation-frame")
      if (current.loafSupported) {
        current.loafObserver = new PerformanceObserver((list) => current.loaf.push(...list.getEntries()))
        current.loafObserver.observe({ type: "long-animation-frame", buffered: false })
      }
      current.eventTimingSupported = supports("event")
      if (current.eventTimingSupported) {
        current.eventObserver = new PerformanceObserver((list) => current.events.push(...list.getEntries().filter((entry) => INPUT_EVENTS.has(entry.name))))
        current.eventObserver.observe({ type: "event", durationThreshold: 16, buffered: false })
      }
      for (const type of ["transitionrun", "transitionstart", "transitionend", "transitioncancel"]) element.addEventListener(type, onTransition)
      state = current
      return {
        widthBefore: current.widthBefore, declaredMs: current.declaredMs, transitionProperty: current.transitionProperty,
        reducedMotion: current.reducedMotion, visibility: current.visibility, focused: current.focused,
      }
    },
    /** Marks the start of the recorded window; the input follows. */
    begin() {
      state.t0 = performance.now()
      performance.mark(`toggle:start:${state.index}`)
      const current = state
      current.windowTimer = setTimeout(() => settle(current, true), current.windowMs)
      return true
    },
    whenDone() {
      return state.done.then(() => true)
    },
    /** Ends the window, then reads the result. */
    finish() {
      const current = state
      current.finished = true
      performance.mark(`toggle:end:${current.index}`)
      const endAt = performance.now()
      clearTimeout(current.quietTimer)
      clearTimeout(current.windowTimer)
      current.resizeObserver.disconnect()
      // Entries are delivered asynchronously; take the ones still queued.
      if (current.loafObserver) { current.loaf.push(...current.loafObserver.takeRecords()); current.loafObserver.disconnect() }
      if (current.eventObserver) { current.events.push(...current.eventObserver.takeRecords().filter((entry) => INPUT_EVENTS.has(entry.name))); current.eventObserver.disconnect() }
      for (const type of ["transitionrun", "transitionstart", "transitionend", "transitioncancel"]) current.element.removeEventListener(type, onTransition)
      state = null
      const origin = current.inputAt ?? current.t0
      const since = (at) => (at === null || at === undefined ? null : Math.round((at - origin) * 10) / 10)
      const loaf = current.loaf.filter((entry) => entry.startTime + entry.duration >= current.t0)
      const inputEntry = current.events
        .filter((entry) => entry.name === current.inputType && entry.startTime >= current.t0 - 1)
        .sort((left, right) => right.duration - left.duration)[0]
      const { transition } = current
      return {
        t0: current.t0, inputAt: current.inputAt, inputType: current.inputType, nextFrameAt: current.nextFrameAt, endAt,
        frames: current.frames,
        widthBefore: current.widthBefore, widthAfter: widthOf(current.element),
        openBefore: current.openBefore, openAfter: isOpenOf(current.kind, current.element),
        workStatusBefore: current.workStatusBefore, workStatusAfter: widthOf(workStatus()),
        reducedMotion: current.reducedMotion, visibility: current.visibility, focused: current.focused, timedOut: current.timedOut,
        transition: {
          declaredMs: current.declaredMs, property: current.transitionProperty, duration: current.transitionDuration,
          ran: transition.runAt !== null, ended: transition.ended,
          runAt: since(transition.runAt), startAt: since(transition.startAt), endAt: since(transition.endAt),
          observedMs: transition.endAt !== null && (transition.startAt ?? transition.runAt) !== null
            ? Math.round((transition.endAt - (transition.startAt ?? transition.runAt)) * 10) / 10
            : null,
        },
        resize: { changes: current.resize.changes, firstAt: since(current.resize.firstAt), lastAt: since(current.resize.lastAt) },
        loafSupported: current.loafSupported,
        loaf: loaf.map((entry) => ({
          at: since(entry.startTime), durationMs: Math.round(entry.duration), blockingMs: Math.round(entry.blockingDuration ?? 0),
          scripts: (entry.scripts ?? []).map((script) => ({
            invoker: script.invoker, invokerType: script.invokerType, sourceURL: script.sourceURL, sourceFunctionName: script.sourceFunctionName,
            sourceCharPosition: script.sourceCharPosition, durationMs: Math.round(script.duration), forcedStyleAndLayoutMs: Math.round(script.forcedStyleAndLayoutDuration ?? 0),
          })),
        })),
        eventTimingSupported: current.eventTimingSupported,
        eventTiming: inputEntry ? {
          durationMs: inputEntry.duration,
          inputDelayMs: Math.round(inputEntry.processingStart - inputEntry.startTime),
          processingMs: Math.round(inputEntry.processingEnd - inputEntry.processingStart),
          presentationDelayMs: Math.round(inputEntry.startTime + inputEntry.duration - inputEntry.processingEnd),
        } : null,
      }
    },
  }
  for (const type of ["click", "keydown"]) window.addEventListener(type, onInput, true)
  return true
}

const MODIFIER_KEYS = {
  meta: { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, bit: 4 },
  ctrl: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, bit: 2 },
  alt: { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, bit: 1 },
}

/** Presses modifiers, the key, and releases them in reverse, as a hand does. */
const pressChord = async (client, modifiers, key) => {
  let bits = 0
  const send = (type, { key: name, code, windowsVirtualKeyCode }) => client.send("Input.dispatchKeyEvent", { type, key: name, code, windowsVirtualKeyCode, modifiers: bits })
  for (const modifier of modifiers) { bits |= modifier.bit; await send("rawKeyDown", modifier) }
  await send("rawKeyDown", key)
  await send("keyUp", key)
  for (const modifier of [...modifiers].reverse()) { bits &= ~modifier.bit; await send("keyUp", modifier) }
}

const clickAt = async (client, { x, y }) => {
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
}

/** The toggle button for `kind`, located by its icon, with its rail position. */
const locateControl = (client, kind, surface) => evaluateValue(client, `(() => {
  const button = ${kind === "sidebar"
    ? `document.querySelector("[data-sidebar-toggle]") ?? [...document.querySelectorAll("button")].find((element) => element.querySelector('use[href="#oc-layout-left"]') && !element.closest("[data-context-panel]"))`
    : `document.querySelector('[data-context-surface="${SURFACE_IDS[surface]}"]') ?? document.querySelector('nav button[aria-pressed]:has(use[href="#oc-${SURFACE_ICONS[surface]}"])')`}
  if (!button) return null
  const rect = button.getBoundingClientRect()
  const nav = button.closest("nav")
  const rail = nav ? [...nav.querySelectorAll("button[aria-pressed]")] : []
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), railIndex: rail.indexOf(button) + 1 }
})()`)

/**
 * Whether the context panel's editor shows `name`: a CodeMirror content with
 * text, laid out, in the right slot whose tab strip names the file. Read
 * outside a recorded window only, since it reads geometry.
 */
const readEditorShown = (client, name) => evaluateValue(client, `(() => {
  const slot = document.querySelector("[data-right-slot]")
  const content = slot?.querySelector(".cm-content")
  if (!content) return { shown: false, reason: "no editor in the panel" }
  const rect = content.getBoundingClientRect()
  const chars = (content.textContent ?? "").length
  const named = (slot.textContent ?? "").includes(${JSON.stringify(name)})
  return { shown: rect.width > 0 && rect.height > 0 && chars > 0 && named, chars, width: Math.round(rect.width), named }
})()`)

const readIsOpen = (client, kind) => evaluateValue(client, `(${PAGE_IS_OPEN})(${JSON.stringify(kind)}, (${PAGE_TARGETS})[${JSON.stringify(kind)}]())`)

const fmt = (value, unit = "ms") => (value === null || value === undefined ? "-" : `${round(value, 1)}${unit}`)

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `toggle-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  await mkdir(output, { recursive: true })
  const port = await reservePort()
  const profile = resolveProfileDir(options.profileDir, "toggle")
  const chromeProcess = launchChrome({ chrome: resolveChrome(options.chrome), profileDir: profile.dir, port, headless: options.headless, extraArgs: options.forceAccessibility ? FORCE_ACCESSIBILITY_ARGS : [] })
  let client
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable")])
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    // A window the OS considers unfocused or covered may throttle frames and
    // drop focus-dependent behaviour; the launch flags cover throttling, this
    // keeps the page focused, and every toggle records both anyway.
    await client.send("Page.bringToFront")
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    if (options.reducedMotion) await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
    if (options.injectScript) {
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: await readFile(resolve(options.injectScript), "utf8") })
      console.log(`MODIFIED APP: injected script ${options.injectScript}`)
    }
    if (options.renderProbe) {
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: buildRenderProbeSource({ traceHook: options.renderProbeHook }) })
      console.log("ATTRIBUTION RUN: render probe on; timings from this run are inflated.")
    }

    const navigate = async () => {
      const loaded = client.once("Page.loadEventFired", 60_000)
      await client.send("Page.navigate", { url: options.url })
      await loaded
    }
    await navigate()
    await expandProjects(client)
    await navigate()
    console.log(`Loaded ${options.url}; settling for ${options.loadSettle}s.`)
    await wait(options.loadSettle * 1000)

    const isMac = await evaluateValue(client, `/Macintosh|Mac OS X/.test(navigator.userAgent)`)
    const mod = MODIFIER_KEYS[options.mod ?? (isMac ? "meta" : "ctrl")]

    /**
     * One input on the user's path. `control` is located beforehand, so the
     * lookup stays outside a recorded window.
     */
    const pressToggle = async (kind, control) => {
      if (options.method === "click") {
        if (!control) throw new Error(`The ${kind === "sidebar" ? "sidebar toggle button" : `${options.surface} rail button`} was not found.`)
        await clickAt(client, control)
      } else if (kind === "sidebar") {
        await pressChord(client, [mod], { key: "b", code: "KeyB", windowsVirtualKeyCode: 66 })
      } else {
        if (!control || control.railIndex < 1 || control.railIndex > 10) throw new Error(`The ${options.surface} surface has no rail digit (position ${control?.railIndex ?? "none"}).`)
        const digit = control.railIndex % 10
        await pressChord(client, [mod, MODIFIER_KEYS.alt], { key: String(digit), code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit })
      }
    }

    /** Brings `kind` to the open or closed state without recording it. */
    const ensure = async (kind, open) => {
      const isOpen = async () => (await readIsOpen(client, kind)) === true
      if ((await isOpen()) === open) return
      if (kind === "panel" && !open) {
        // Another surface may be showing; its pressed rail button closes it.
        const pressed = await evaluateValue(client, `(() => {
          const button = document.querySelector('nav button[aria-pressed="true"]')
          if (!button) return null
          const rect = button.getBoundingClientRect()
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
        })()`)
        if (!pressed) throw new Error("The context panel is open but no rail button is pressed.")
        await clickAt(client, pressed)
      } else {
        await pressToggle(kind, await locateControl(client, kind, options.surface))
      }
      await wait(800)
      if ((await isOpen()) !== open) throw new Error(`Could not ${open ? "open" : "close"} the ${kind} before measuring; the toggle path did nothing.`)
    }

    await ensure("sidebar", true)
    await expandSessionLists(client)
    const row = await evaluateValue(client, `(() => {
      const rows = [...document.querySelectorAll('[data-session-row]')]
      const match = ${options.session
        ? `rows.find((element) => element.getAttribute('data-session-row') === ${JSON.stringify(options.session)})`
        : `rows.find((element) => (element.textContent ?? '').includes(${JSON.stringify(options.title)}))`}
      if (!match) return null
      match.scrollIntoView({ block: "center" })
      const rect = match.getBoundingClientRect()
      return {
        id: match.getAttribute('data-session-row'),
        title: (match.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        active: match.getAttribute('aria-current') === 'page',
        x: Math.round(rect.x + 60), y: Math.round(rect.y + rect.height / 2),
      }
    })()`)
    if (!row) throw new Error(`No sidebar row ${options.session ? `for session ${options.session}` : `contains "${options.title}"`}; the scenario never ran.`)
    if (!row.active) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: row.x, y: row.y })
      await wait(300)
      await clickAt(client, row)
    }
    const deadline = Date.now() + 20_000
    let opened = false
    while (!opened && Date.now() < deadline) {
      const mounted = await evaluateValue(client, `document.querySelectorAll('[data-message-id]').length`)
      const active = await evaluateValue(client, `document.querySelector('[data-session-row="${row.id}"]')?.getAttribute('aria-current') === 'page'`)
      opened = Boolean(active && mounted > 0)
      if (!opened) await wait(250)
    }
    if (!opened) throw new Error(`Session ${row.id} did not become active with messages within 20 s; the scenario never ran.`)
    await wait(3000)
    const session = {
      id: row.id,
      title: row.title,
      mountedMessages: await evaluateValue(client, `document.querySelectorAll('[data-message-id]').length`),
      domElements: await evaluateValue(client, `document.getElementsByTagName('*').length`),
    }
    console.log(`Session ${session.id} (${session.title}): ${session.mountedMessages} messages mounted, ${session.domElements} elements in the document.`)

    if ((await evaluateValue(client, `(${installToggleProbe.toString()})(${PAGE_TARGETS}, ${PAGE_IS_OPEN})`)) !== true) throw new Error("The toggle recorder did not install in the page.")

    // A file open in the panel's editor, so a panel toggle shows it.
    let openedFile = null
    if (options.openFile) {
      await ensure("sidebar", true)
      await ensure("panel", true)
      const fileRow = await evaluateValue(client, `(() => {
        const item = [...document.querySelectorAll("[data-right-slot] [data-file-tree-path]")]
          .find((element) => element.getAttribute("data-file-tree-path").replace(/\\\\/g, "/").split("/").pop() === ${JSON.stringify(options.openFile)})
        const row = item?.firstElementChild
        if (!row) return null
        const rect = row.getBoundingClientRect()
        return { path: item.getAttribute("data-file-tree-path"), x: Math.round(rect.x + Math.min(60, rect.width / 2)), y: Math.round(rect.y + rect.height / 2) }
      })()`)
      if (!fileRow) throw new Error(`No root-level entry "${options.openFile}" in the panel's file tree; the scenario never ran.`)
      await clickAt(client, fileRow)
      const fileDeadline = Date.now() + 20_000
      let shown = null
      while (Date.now() < fileDeadline) {
        shown = await readEditorShown(client, options.openFile)
        if (shown?.shown) break
        await wait(250)
      }
      if (!shown?.shown) throw new Error(`The editor did not show ${options.openFile} within 20 s (${JSON.stringify(shown)}); the scenario never ran.`)
      openedFile = { name: options.openFile, path: fileRow.path, chars: shown.chars, panelWidth: await evaluateValue(client, `Math.round(document.querySelector("[data-right-slot]").getBoundingClientRect().width)`) }
      console.log(`Opened ${fileRow.path} in the panel editor (${shown.chars} characters rendered, panel ${openedFile.panelWidth} px).`)
      await wait(1500)
    }

    const traceEvents = []
    client.on("Tracing.dataCollected", ({ value }) => { for (const event of value ?? []) traceEvents.push(event) })
    if (options.cpuProfile) {
      await client.send("Profiler.enable")
      await client.send("Profiler.setSamplingInterval", { interval: 250 })
      await client.send("Profiler.start")
    }
    // `RunTask` needs the disabled-by-default timeline category; `.stack`
    // records the JS stack on forced style recalcs and layouts; the
    // accessibility category says whether a tree was built and what it cost.
    const categories = [...new Set([
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "disabled-by-default-devtools.timeline.stack",
      "blink.user_timing",
      ACCESSIBILITY_CATEGORY,
      ...options.extraCategories,
    ])]
    await client.send("Tracing.start", { transferMode: "ReportEvents", categories: categories.join(",") })
    const probeStartedAt = options.renderProbe
      ? await evaluateValue(client, `(() => { globalThis[${JSON.stringify(RENDER_PROBE_GLOBAL)}]?.start(); return performance.now() })()`)
      : null

    const toggles = []
    for (const phaseName of options.phases) {
      const phase = PHASES[phaseName]
      await ensure("sidebar", true)
      await ensure("panel", phase.panelOpen)
      if (options.method === "click") {
        const control = await locateControl(client, phase.kind, options.surface)
        if (!control) throw new Error(`No toggle control for ${phase.kind}.`)
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: control.x, y: control.y })
        await wait(options.hover)
      }
      const expectOpenFirst = phase.kind === "panel"
      console.log(`\nPhase ${phaseName}: ${options.warmup} warm-up and ${options.count} measured pairs.`)
      for (let pair = 0; pair < options.warmup + options.count; pair += 1) {
        for (const [step, type] of phase.types.entries()) {
          const expectOpen = step === 0 ? expectOpenFirst : !expectOpenFirst
          const index = toggles.length
          const control = await locateControl(client, phase.kind, options.surface)
          const pre = await evaluateValue(client, `window.__openchamberToggleProbe.arm(${JSON.stringify({ kind: phase.kind, index, windowMs: options.window, tailMs: options.tail })})`)
          // evaluateValue reads a script that threw as null.
          if (!pre || pre.error) throw new Error(`Toggle ${index} (${type}): ${pre?.error ?? "the recorder failed to arm"}`)
          await wait(options.pre)
          if ((await evaluateValue(client, `window.__openchamberToggleProbe.begin()`)) !== true) throw new Error(`Toggle ${index} (${type}): the recorder failed to start`)
          await pressToggle(phase.kind, control)
          await evaluateValue(client, `window.__openchamberToggleProbe.whenDone()`)
          const raw = await evaluateValue(client, `window.__openchamberToggleProbe.finish()`)
          if (!raw) throw new Error(`Toggle ${index} (${type}): the recorder returned nothing`)
          // After the window, so its geometry read forces nothing inside it.
          const editor = options.openFile && phase.kind === "panel" && expectOpen ? await readEditorShown(client, options.openFile) : null
          const refreshMs = estimateRefreshMs(raw.frames.filter((at) => at < raw.t0))
          const from = raw.inputAt ?? raw.t0
          const frames = frameStats(raw.frames, { from, to: raw.endAt, refreshMs })
          const frameDeltas = []
          for (let frame = 1; frame < raw.frames.length; frame += 1) if (raw.frames[frame] > from && raw.frames[frame] <= raw.endAt) frameDeltas.push(round(raw.frames[frame] - raw.frames[frame - 1], 1))
          const toggle = {
            index, phase: phaseName, type, kind: phase.kind, expectOpen, warmup: pair < options.warmup, method: options.method,
            inputType: raw.inputType,
            inputToNextFrameMs: raw.inputAt !== null && raw.nextFrameAt !== null ? round(raw.nextFrameAt - raw.inputAt) : null,
            windowMs: round(raw.endAt - raw.t0),
            width: { before: raw.widthBefore, after: raw.widthAfter },
            open: { before: raw.openBefore, after: raw.openAfter },
            workStatusWidth: { before: raw.workStatusBefore, after: raw.workStatusAfter },
            transition: raw.transition,
            resize: raw.resize,
            frames,
            frameDeltas,
            loaf: raw.loafSupported ? {
              count: raw.loaf.length,
              worstMs: raw.loaf.reduce((max, entry) => Math.max(max, entry.durationMs), 0),
              forcedStyleAndLayoutMs: raw.loaf.reduce((total, entry) => total + entry.scripts.reduce((sum, script) => sum + script.forcedStyleAndLayoutMs, 0), 0),
              entries: raw.loaf,
            } : null,
            eventTiming: raw.eventTimingSupported ? (raw.eventTiming ?? { durationMs: null, belowThreshold: true }) : null,
            editor,
            reducedMotion: raw.reducedMotion,
            visibility: raw.visibility,
            focused: raw.focused,
            timedOut: raw.timedOut,
            renders: probeStartedAt === null ? null : { fromMs: raw.t0 - probeStartedAt, toMs: raw.endAt - probeStartedAt },
            trace: null,
            accessibility: null,
            failures: [],
            warnings: [],
            valid: false,
          }
          const failures = toggle.failures
          const { before, after } = toggle.width
          if (raw.openBefore !== !expectOpen || raw.openAfter !== expectOpen) failures.push(`expected to ${expectOpen ? "open" : "close"}: open ${raw.openBefore} -> ${raw.openAfter}, width ${before} -> ${after}`)
          if (before === after) failures.push(`the width did not change (${before})`)
          if (raw.inputAt === null) failures.push("the page never received the input")
          if (!raw.reducedMotion && !(raw.transition.declaredMs > 0)) failures.push(`no width transition declared (transition-property ${raw.transition.property}, duration ${raw.transition.duration})`)
          if (raw.transition.declaredMs > 0 && !raw.transition.ran) failures.push(`a ${raw.transition.declaredMs} ms width transition is declared but never ran`)
          if (frames.frames < 2) failures.push(`${frames.frames} animation frames in the window: the renderer was not producing frames`)
          if (refreshMs === null || refreshMs > 50) failures.push(`refresh interval ${refreshMs ?? "unknown"} ms before the input: the renderer was throttled`)
          if (raw.visibility !== "visible") failures.push(`document was ${raw.visibility}`)
          if (editor && !editor.shown) failures.push(`the editor does not show ${options.openFile} after opening (${editor.reason ?? `${editor.chars} characters, named ${editor.named}`})`)
          if (raw.timedOut) toggle.warnings.push(`the transition had not ended after ${options.window} ms`)
          if (raw.reducedMotion && raw.transition.declaredMs > 0) toggle.warnings.push("animates although prefers-reduced-motion is set")
          if (!raw.focused) toggle.warnings.push("document did not have focus")
          toggles.push(toggle)
          console.log(`#${String(index).padStart(2)} ${type.padEnd(20)}${toggle.warmup ? " warm-up" : "        "} next frame ${fmt(toggle.inputToNextFrameMs)}  worst frame ${fmt(frames.worstFrameMs)}  dropped ${frames.droppedFrames ?? "-"}  transition ${fmt(raw.transition.observedMs)}  width ${before} -> ${after}${failures.length ? `  INVALID: ${failures.join("; ")}` : ""}`)
          await wait(options.settle)
        }
      }
    }

    if (options.renderProbe) await evaluateValue(client, `globalThis[${JSON.stringify(RENDER_PROBE_GLOBAL)}]?.stop()`)
    const renderProbeRaw = options.renderProbe ? await readRenderProbe((expression) => evaluateValue(client, expression)) : null
    const tracingComplete = client.once("Tracing.tracingComplete", 120_000)
    await client.send("Tracing.end")
    await tracingComplete
    const profile = options.cpuProfile ? (await client.send("Profiler.stop")).profile : null

    const frameLiveness = await evaluateValue(client, `new Promise((resolveFrames) => {
      let frames = 0
      const startedAt = performance.now()
      const tick = () => {
        frames += 1
        if (performance.now() - startedAt < 1000) requestAnimationFrame(tick)
        else resolveFrames({ framesPerSecond: frames, visibilityState: document.visibilityState })
      }
      requestAnimationFrame(tick)
      setTimeout(() => resolveFrames({ framesPerSecond: frames, visibilityState: document.visibilityState }), 2000)
    })`)

    // Each toggle's window on the trace, from its own named marks.
    const marks = new Map()
    for (const event of traceEvents) if (event.cat?.includes("blink.user_timing") && String(event.name).startsWith("toggle:")) marks.set(event.name, event.ts)
    const taskCount = traceEvents.filter((event) => event.name === "RunTask" && event.ph === "X").length
    const renderSnapshot = renderProbeRaw ? JSON.parse(renderProbeRaw) : null
    for (const toggle of toggles) {
      const start = marks.get(`toggle:start:${toggle.index}`)
      const end = marks.get(`toggle:end:${toggle.index}`)
      if (start === undefined || end === undefined) toggle.failures.push("its marks are missing from the trace")
      else {
        toggle.trace = analyzeToggleWindow(traceEvents, { start, end, inputTypes: [toggle.inputType ?? (options.method === "key" ? "keydown" : "click")] })
        toggle.accessibility = accessibilityInWindow(traceEvents, { main: rendererMainThread(traceEvents, { start, end }).main, start, end, recorded: true })
        if (!toggle.trace.mainThreadFound) toggle.failures.push("the trace has no renderer main thread in its window")
        else if (toggle.trace.inputTaskMs === null) toggle.warnings.push("no input task found on the trace")
      }
      if (renderSnapshot && toggle.renders) toggle.renders = { ...toggle.renders, ...rendersInWindow(renderSnapshot.commits, toggle.renders.fromMs, toggle.renders.toMs) }
      toggle.valid = toggle.failures.length === 0
    }

    const failures = []
    if (taskCount === 0) failures.push("the trace has no RunTask events: long-task and frame metrics would read zero")
    if (Number(frameLiveness?.framesPerSecond) < 20) failures.push(`the renderer produced ${frameLiveness?.framesPerSecond} frames/s after the run`)
    const invalid = toggles.filter((toggle) => !toggle.valid)
    if (invalid.length) failures.push(`${invalid.length} of ${toggles.length} toggles invalid: ${invalid.slice(0, 5).map((toggle) => `#${toggle.index} ${toggle.type} (${toggle.failures.join("; ")})`).join(", ")}`)

    // Forced style/layout across measured toggles, by the JS that forced it.
    const stacks = new Map()
    for (const toggle of measuredToggles(toggles)) {
      for (const entry of toggle.trace?.forced?.top ?? []) {
        const total = stacks.get(entry.stack) ?? { stack: entry.stack, count: 0, ms: 0, types: new Set() }
        total.count += entry.count
        total.ms += entry.ms
        total.types.add(toggle.type)
        stacks.set(entry.stack, total)
      }
    }
    const forcedStacks = [...stacks.values()].sort((left, right) => right.ms - left.ms).slice(0, 10).map((entry) => ({ ...entry, ms: round(entry.ms), types: [...entry.types] }))
    const refreshValues = toggles.map((toggle) => toggle.frames.refreshMs).filter(Number.isFinite)

    const summary = {
      recordedAt: new Date().toISOString(),
      label: options.label,
      url: options.url,
      session,
      method: options.method,
      mod: options.method === "key" ? mod.key : null,
      surface: options.surface,
      openedFile,
      phases: options.phases,
      count: options.count,
      warmup: options.warmup,
      settleMs: options.settle,
      reducedMotion: options.reducedMotion,
      headless: options.headless,
      viewport: { width: 1600, height: 1000 },
      injectedScript: options.injectScript,
      renderProbe: renderSnapshot ? { ...summarizeRenderProbe(renderSnapshot), toggles: toggles.length } : null,
      frameLiveness,
      refreshMs: refreshValues.length ? round(percentile(refreshValues, 0.5)) : null,
      metrics: { taskCount },
      accessibility: accessibilityState(traceEvents, { categories, forced: options.forceAccessibility }),
      toggleValidity: { ok: failures.length === 0, failures },
      byType: summarizeByType(toggles),
      forcedStacks,
      toggles,
      cpuProfile: profile ? summarizeCpuProfile(profile) : null,
    }
    await writeFile(join(output, "toggle-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents }))
    if (profile) await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))
    if (renderProbeRaw) await writeFile(join(output, "render-probe.json"), renderProbeRaw)

    console.log(`\nPer toggle type, median / p95 over ${options.count} measured toggles each (refresh ${summary.refreshMs ?? "?"} ms; ${describeAccessibility(summary.accessibility)}):`)
    const cell = (entry, unit = "ms") => (entry ? `${round(entry.median, 1)}/${round(entry.p95, 1)}${unit}` : "-")
    for (const [type, stats] of Object.entries(summary.byType)) {
      console.log(`  ${type.padEnd(20)} n=${stats.n}  next frame ${cell(stats.inputToNextFrameMs)}  input task ${cell(stats.inputTaskMs)}  worst frame ${cell(stats.worstFrameMs)}  dropped ${cell(stats.droppedFrames, "")}  style+layout ${cell(stats.styleLayoutMs)} (${cell(stats.elementsRestyled, "")} elements)  forced ${cell(stats.forcedLayouts, "")}  accessibility ${cell(stats.accessibilityMs)}  transition ${cell(stats.observedTransitionMs)}${stats.commits ? `  commits ${cell(stats.commits, "")}` : ""}`)
    }
    if (forcedStacks.length) {
      console.log("\nForced style/layout by stack (measured toggles):")
      for (const entry of forcedStacks) console.log(`  ${String(entry.count).padStart(4)}x ${String(entry.ms).padStart(7)} ms  ${shortUrl(entry.stack)}  [${entry.types.join(", ")}]`)
    }
    if (summary.renderProbe) printRenderProbe(summary.renderProbe, { perUnit: { label: "toggle", count: toggles.length } })
    const warned = toggles.filter((toggle) => toggle.warnings.length)
    for (const toggle of warned.slice(0, 10)) console.warn(`Warning: #${toggle.index} ${toggle.type}: ${toggle.warnings.join("; ")}`)
    console.log(`Artifacts written to ${output}`)
    if (failures.length) {
      for (const failure of failures) console.error(`INVALID RUN: ${failure}`)
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
