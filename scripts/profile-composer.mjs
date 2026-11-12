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
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from "./perf/cdp.mjs"
import { percentile, round } from "./perf/metrics.mjs"

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

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.`

const parseArgs = (argv) => {
  const options = { url: "http://localhost:3000", session: null, lines: 6, settle: 14, output: null, label: null, chrome: null, profileDir: null, headless: true }
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
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.lines) || options.lines < 1) throw new Error("--lines must be a positive integer")
  return options
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
