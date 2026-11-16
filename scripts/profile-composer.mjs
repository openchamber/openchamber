#!/usr/bin/env node
/**
 * What a new line in the composer costs in style recalculation.
 *
 * Each line the composer grows can move the chat's bottom inset, and a value
 * written where the transcript inherits it restyles the whole transcript: tens
 * of thousands of elements per keystroke in a long session. This opens a
 * session, types `--lines` lines with Shift+Enter between them, and records
 * for each Shift+Enter (until 700 ms later, before the next line's text) the
 * style recalculations, the elements they touched and their time, plus what
 * invalidated them. The draft is cleared afterwards.
 *
 * Open a long session (`--session`), because the cost scales with the
 * transcript that is mounted, and compare per-line element counts: they are
 * deterministic for a given session, where milliseconds are not.
 */

import { mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from "./perf/cdp.mjs"
import { mainThreadTasks, percentile, round } from "./perf/metrics.mjs"

const HELP = `Usage: bun run profile:composer -- [options]

Types multi-line text into the composer and reports, per new line, the style
recalcs, elements restyled and recalc time, with the top invalidation reasons.

Options:
  --url <url>              OpenChamber URL (default: http://localhost:3000)
  --session <id>           Open this session (use a long one; default: whatever
                           the app restores)
  --lines <n>              Lines to type (default: 6)
  --settle <seconds>       Wait after load before typing (default: 14)
  --output <directory>     Writes composer-summary.json
                           (default: artifacts/composer-profile-<time>)
  --label <text>           Human label stored in the summary
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Chrome profile to reuse (default: a fresh temporary
                           profile per run, removed afterwards)
  --headed                 Show the browser (default: headless)
  --help                   Show this help

Typing mode (instead of new lines):
  --type <n>               Type this many characters one key at a time and
                           report what a keystroke costs: input to next paint
                           (Event Timing), main-thread time per keystroke over
                           an idle window of the same length, long tasks
  --interval <ms>          Time between keystrokes (default: 80, a fast typist)
  --prefill <n>            Insert a draft of about this many characters first,
                           in lines of prose, so the cost of a long draft shows
  --cpu-throttle <rate>    Slow the page's CPU down this many times
  --cpu-profile            Save cpu-profile.cpuprofile of the typing window
                           (attribution: the sampler adds load)
  --save-trace             Save trace.json of the idle and typing windows
  --inject-css <css>       Add a stylesheet before the page loads (ablation only;
                           the result describes a modified app)
  --inject-script <file>   Run a script before the page loads (ablation only)

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.`

const parseArgs = (argv) => {
  const options = { url: "http://localhost:3000", session: null, lines: 6, settle: 14, output: null, label: null, chrome: null, profileDir: null, headless: true, type: 0, interval: 80, prefill: 0, cpuThrottle: 1, cpuProfile: false, saveTrace: false, injectCss: null, injectScript: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--session") options.session = argv[++index]
    else if (value === "--lines") options.lines = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = resolve(argv[++index])
    else if (value === "--headed") options.headless = false
    else if (value === "--type") options.type = Number(argv[++index])
    else if (value === "--interval") options.interval = Number(argv[++index])
    else if (value === "--prefill") options.prefill = Number(argv[++index])
    else if (value === "--cpu-throttle") options.cpuThrottle = Number(argv[++index])
    else if (value === "--cpu-profile") options.cpuProfile = true
    else if (value === "--save-trace") options.saveTrace = true
    else if (value === "--inject-css") options.injectCss = argv[++index]
    else if (value === "--inject-script") options.injectScript = argv[++index]
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.lines) || options.lines < 1) throw new Error("--lines must be a positive integer")
  if (!Number.isInteger(options.type) || options.type < 0) throw new Error("--type must be a number of characters")
  if (!Number.isInteger(options.prefill) || options.prefill < 0) throw new Error("--prefill must be a number of characters")
  if (!Number.isFinite(options.interval) || options.interval < 10) throw new Error("--interval must be 10 ms or more")
  if (!Number.isFinite(options.cpuThrottle) || options.cpuThrottle < 1) throw new Error("--cpu-throttle must be 1 or more")
  return options
}

const PROSE = "The composer should keep up with a fast typist on a slow laptop while the agent streams. "

/** Busy main-thread milliseconds of the renderer between two trace marks. */
const busyBetween = (events, from, until) => {
  const { tasks } = mainThreadTasks(events)
  let total = 0
  for (const task of tasks) {
    const start = Math.max(task.ts, from)
    const end = Math.min(task.ts + Number(task.dur), until)
    if (end > start) total += (end - start) / 1000
  }
  return total
}

/**
 * Typing mode: an idle window with the composer focused, then `--type` keys
 * at `--interval`, the same length of time. What a keystroke costs is the
 * typing window's busy time minus the idle window's, per key; Event Timing
 * gives what the user waits from key to the frame that shows it.
 */
const runTyping = async (client, options, output, page) => {
  // A session can hold an unsent draft; the run gives it back afterwards.
  // The editor's innerText ends every line with a newline; an empty editor reads "\n".
  const originalDraft = String(await evaluateValue(client, `${EDITOR}?.innerText ?? ""`)).replace(/\n$/, "")
  try {
    await measureTyping(client, options, output, page)
  } finally {
    await client.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined)
    await evaluateValue(client, `(() => { const editor = ${EDITOR}; editor?.focus(); document.execCommand("selectAll"); document.execCommand("delete") })()`).catch(() => undefined)
    if (originalDraft) await client.send("Input.insertText", { text: originalDraft }).catch(() => undefined)
    await wait(500)
  }
}

const measureTyping = async (client, options, output, page) => {
  if (options.cpuThrottle > 1) await client.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle })
  if (options.prefill > 0) {
    const lines = []
    let size = 0
    while (size < options.prefill) { lines.push(PROSE.repeat(2).trim()); size += PROSE.length * 2 + 1 }
    await client.send("Input.insertText", { text: lines.join("\n") })
    await wait(1500)
  }
  const draftBefore = await evaluateValue(client, `${EDITOR}?.innerText.length ?? 0`)
  await evaluateValue(client, `(() => {
    globalThis.__composerEvents = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) globalThis.__composerEvents.push({ name: entry.name, duration: entry.duration, processing: entry.processingEnd - entry.processingStart, delay: entry.processingStart - entry.startTime })
    }).observe({ type: "event", durationThreshold: 16 })
    globalThis.__composerLongTasks = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) globalThis.__composerLongTasks.push(entry.duration)
    }).observe({ type: "longtask" })
  })()`)

  const events = []
  client.on("Tracing.dataCollected", ({ value }) => { for (const event of value ?? []) events.push(event) })
  await client.send("Tracing.start", { transferMode: "ReportEvents", categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing" })
  await wait(500)
  const windowMs = options.type * options.interval
  await evaluateValue(client, `performance.mark("composer:idle-start")`)
  await wait(windowMs)
  await evaluateValue(client, `performance.mark("composer:idle-end")`)
  if (options.cpuProfile) { await client.send("Profiler.enable"); await client.send("Profiler.setSamplingInterval", { interval: 200 }); await client.send("Profiler.start") }
  await evaluateValue(client, `globalThis.__composerEvents.length = 0; globalThis.__composerLongTasks.length = 0; performance.mark("composer:type-start")`)
  const text = PROSE.repeat(Math.ceil(options.type / PROSE.length)).slice(0, options.type)
  const started = Date.now()
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character, unmodifiedText: character })
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: character })
    const due = started + (index + 1) * options.interval
    const left = due - Date.now()
    if (left > 0) await wait(left)
  }
  await wait(300)
  await evaluateValue(client, `performance.mark("composer:type-end")`)
  const profile = options.cpuProfile ? (await client.send("Profiler.stop")).profile : null
  const done = client.once("Tracing.tracingComplete", 60_000)
  await client.send("Tracing.end")
  await done
  if (options.cpuThrottle > 1) await client.send("Emulation.setCPUThrottlingRate", { rate: 1 })

  const typedChars = (await evaluateValue(client, `${EDITOR}?.innerText.length ?? 0`)) - draftBefore
  const pageEvents = JSON.parse(await evaluateValue(client, `JSON.stringify(globalThis.__composerEvents)`))
  const longTasks = JSON.parse(await evaluateValue(client, `JSON.stringify(globalThis.__composerLongTasks)`))

  const mark = (name) => events.find((event) => event.name === name)?.ts ?? null
  const [idleStart, idleEnd, typeStart, typeEnd] = ["idle-start", "idle-end", "type-start", "type-end"].map((name) => mark(`composer:${name}`))
  if ([idleStart, idleEnd, typeStart, typeEnd].some((value) => value === null)) throw new Error("The trace is missing the window marks; nothing was measured.")
  // The typing window runs longer than the idle one (the tail after the last
  // key, a renderer that falls behind the cadence): the idle floor is scaled
  // to its length, the typing work is not.
  const typingDurationMs = (typeEnd - typeStart) / 1000
  const idleBusy = busyBetween(events, idleStart, idleEnd) * ((typeEnd - typeStart) / (idleEnd - idleStart))
  const typeBusy = busyBetween(events, typeStart, typeEnd)
  const { tasks } = mainThreadTasks(events)
  const typingTasks = tasks.filter((task) => task.ts >= typeStart && task.ts < typeEnd).map((task) => Number(task.dur) / 1000)
  const keyEvents = pageEvents.filter((entry) => /^key|input|beforeinput/.test(entry.name))
  const durations = keyEvents.map((entry) => entry.duration)
  const summary = {
    recordedAt: new Date().toISOString(),
    label: options.label,
    mode: "typing",
    injectedCss: options.injectCss,
    injectedScript: options.injectScript,
    page,
    cpuThrottle: options.cpuThrottle,
    intervalMs: options.interval,
    prefillChars: draftBefore,
    keys: options.type,
    typedChars,
    idleBusyMs: round(idleBusy, 1),
    typingBusyMs: round(typeBusy, 1),
    busyMsPerKey: round((typeBusy - idleBusy) / options.type, 2),
    busyPercentTyping: round((typeBusy / typingDurationMs) * 100, 1),
    tasksOver16ms: typingTasks.filter((ms) => ms > 16.7).length,
    tasksOver8ms: typingTasks.filter((ms) => ms > 8.33).length,
    longestTaskMs: round(Math.max(0, ...typingTasks), 1),
    longTasks: longTasks.length,
    slowKeyEvents: keyEvents.length,
    keyEventP50Ms: durations.length ? percentile(durations, 0.5) : null,
    keyEventMaxMs: durations.length ? Math.max(...durations) : null,
    slowKeyEventsByName: Object.fromEntries([...new Set(keyEvents.map((entry) => entry.name))].map((name) => [name, keyEvents.filter((entry) => entry.name === name).length])),
  }
  await writeFile(join(output, "composer-summary.json"), JSON.stringify(summary, null, 2))
  if (profile) await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))
  if (options.saveTrace) await writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents: events }))
  if (typedChars < options.type * 0.9) console.warn(`WARNING: the editor gained ${typedChars} characters for ${options.type} keys; keys may not have reached it.`)
  console.log(`\nTyping ${options.type} keys every ${options.interval} ms, CPU throttle ${options.cpuThrottle}x, draft ${draftBefore} chars before:`)
  console.log(`  main thread per key: ${summary.busyMsPerKey} ms (typing ${summary.busyPercentTyping}% busy; idle window ${summary.idleBusyMs} ms, typing ${summary.typingBusyMs} ms)`)
  console.log(`  tasks over 8.3 ms: ${summary.tasksOver8ms}, over 16.7 ms: ${summary.tasksOver16ms}, longest ${summary.longestTaskMs} ms, long tasks ${summary.longTasks}`)
  console.log(`  key events slower than 16 ms to paint: ${summary.slowKeyEvents} (${JSON.stringify(summary.slowKeyEventsByName)}), p50 ${summary.keyEventP50Ms} ms, max ${summary.keyEventMaxMs} ms`)
  console.log(`\nSaved to ${output}`)
}

const EDITOR = `document.querySelector('[data-composer-slot] [contenteditable="true"]')`
const SHIFT = 8

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `composer-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  mkdirSync(output, { recursive: true })
  const profile = resolveProfileDir(options.profileDir, "composer")
  mkdirSync(profile.dir, { recursive: true })
  const url = new URL(options.url)
  if (options.session) url.searchParams.set("session", options.session)
  const port = await reservePort()
  const chrome = launchChrome({ chrome: resolveChrome(options.chrome), profileDir: profile.dir, port, headless: options.headless })
  const events = []
  let client
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable")])
    await client.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => undefined)
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    if (options.injectScript) {
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: await readFile(resolve(options.injectScript), "utf8") })
    }
    if (options.injectCss) {
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `document.addEventListener("DOMContentLoaded", () => { const style = document.createElement("style"); style.textContent = ${JSON.stringify(options.injectCss)}; document.head.appendChild(style) })`,
      })
    }
    const loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: url.toString() })
    await loaded
    console.log(`Loaded ${url}; settling for ${options.settle}s.`)
    await wait(options.settle * 1000)

    const page = await evaluateValue(client, `(() => {
      const editor = ${EDITOR}
      if (!editor) return null
      editor.focus()
      return { elements: document.querySelectorAll("*").length, messages: document.querySelectorAll("[data-message-id]").length }
    })()`)
    if (!page) {
      const summary = { recordedAt: new Date().toISOString(), label: options.label, url: url.toString(), editorFound: false }
      await writeFile(join(output, "composer-summary.json"), JSON.stringify(summary, null, 2))
      throw new Error("No editable composer on the page; the scenario never ran.")
    }
    console.log(`Composer focused; ${page.elements} elements, ${page.messages} messages mounted.`)
    if (options.type > 0) {
      await runTyping(client, options, output, page)
      return
    }

    client.on("Tracing.dataCollected", ({ value }) => { for (const event of value ?? []) events.push(event) })
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.invalidationTracking",
    })
    await wait(1000)
    const key = (type, extra = {}) => client.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: SHIFT, ...extra })
    for (let line = 1; line <= options.lines; line += 1) {
      await client.send("Input.insertText", { text: `line ${line} of a multi-line draft` })
      await wait(500)
      await evaluateValue(client, `performance.mark("composer:newline-${line}")`)
      await key("rawKeyDown")
      await key("char", { text: "\r" })
      await key("keyUp")
      await wait(700)
      // The window ends here, before the next line's text is typed.
      await evaluateValue(client, `performance.mark("composer:settled-${line}")`)
    }
    const done = client.once("Tracing.tracingComplete", 60_000)
    await client.send("Tracing.end")
    await done

    const editorLines = await evaluateValue(client, `${EDITOR}?.innerText.split("\\n").length ?? 0`)
    // The draft persists per session; leave the session as it was found.
    await evaluateValue(client, `(() => { const editor = ${EDITOR}; editor?.focus(); document.execCommand("selectAll"); document.execCommand("delete") })()`)
    await wait(500)

    const marks = events.filter((event) => String(event.name).startsWith("composer:")).sort((left, right) => left.ts - right.ts)
    const recalcs = events.filter((event) => event.name === "UpdateLayoutTree")
    const markAt = (name) => marks.find((mark) => mark.name === name)?.ts ?? null
    const perLine = Array.from({ length: options.lines }, (_, index) => index + 1).flatMap((line) => {
      const from = markAt(`composer:newline-${line}`)
      const until = markAt(`composer:settled-${line}`)
      if (from === null || until === null) return []
      const window = recalcs.filter((event) => event.ts >= from && event.ts < until)
      return [{
        line,
        recalcs: window.length,
        maxElements: Math.max(0, ...window.map((event) => event.args?.elementCount ?? 0)),
        elements: window.reduce((total, event) => total + (event.args?.elementCount ?? 0), 0),
        ms: round(window.reduce((total, event) => total + (event.dur ?? 0) / 1000, 0), 1),
      }]
    })
    const invalidations = new Map()
    for (const event of events) {
      if (!/StyleInvalidator|ScheduleStyle|StyleRecalcInvalidation/.test(event.name)) continue
      const data = event.args?.data ?? {}
      const reason = `${event.name} ${data.reason ?? ""} ${data.changedAttribute ?? ""}${data.changedPseudo ?? ""} ${data.nodeName ?? ""}`.replace(/\s+/g, " ").trim()
      invalidations.set(reason, (invalidations.get(reason) ?? 0) + 1)
    }
    const summary = {
      recordedAt: new Date().toISOString(),
      label: options.label,
      url: url.toString(),
      editorFound: true,
      page,
      linesTyped: options.lines,
      editorLines,
      medianPerLine: {
        recalcs: percentile(perLine.map((entry) => entry.recalcs), 0.5),
        elements: percentile(perLine.map((entry) => entry.elements), 0.5),
        maxElements: percentile(perLine.map((entry) => entry.maxElements), 0.5),
        ms: percentile(perLine.map((entry) => entry.ms), 0.5),
      },
      perLine,
      topInvalidations: [...invalidations].sort((left, right) => right[1] - left[1]).slice(0, 25),
    }
    await writeFile(join(output, "composer-summary.json"), JSON.stringify(summary, null, 2))

    if (perLine.length !== options.lines) console.warn(`WARNING: ${perLine.length} line marks for ${options.lines} lines; the trace may be incomplete.`)
    if (editorLines < options.lines) console.warn(`WARNING: the editor holds ${editorLines} lines after ${options.lines} Shift+Enter presses; new lines may not have been inserted.`)
    console.log(`\n${"line".padStart(4)} ${"recalcs".padStart(8)} ${"elements".padStart(9)} ${"max".padStart(7)} ${"ms".padStart(7)}`)
    for (const entry of perLine) console.log(`${String(entry.line).padStart(4)} ${String(entry.recalcs).padStart(8)} ${String(entry.elements).padStart(9)} ${String(entry.maxElements).padStart(7)} ${String(entry.ms).padStart(7)}`)
    console.log(`median per line: ${summary.medianPerLine.recalcs} recalcs, ${summary.medianPerLine.elements} elements, ${summary.medianPerLine.ms} ms (page has ${page.elements} elements)`)
    console.log("\nTop invalidations:")
    for (const [reason, count] of summary.topInvalidations.slice(0, 10)) console.log(`  ${String(count).padStart(6)}  ${reason}`)
    console.log(`\nSaved to ${output}`)
  } finally {
    client?.close()
    chrome.kill("SIGTERM")
    profile.removeAfter(chrome)
  }
}

main().catch((error) => {
  console.error(`Composer profiling failed: ${error.message}`)
  process.exitCode = 1
})
