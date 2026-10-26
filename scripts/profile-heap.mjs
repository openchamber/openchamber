#!/usr/bin/env node
/**
 * JS heap and DOM size after hovering, then opening, N sidebar sessions.
 *
 * Memory regressions in the sidebar and session cache show up as what the page
 * retains once the user has moved through several sessions, not in any single
 * switch. Three readings, each after two forced garbage collections and a
 * settle: the app loaded, after resting the pointer on each of the first N
 * rows (the hover-prefetch path), and after clicking through the same rows.
 *
 * The rows are the first N in sidebar order, so two builds visit the same
 * sessions only when they serve the same server state.
 */

import { mkdirSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { metricMap, round } from "./perf/metrics.mjs"
import { expandProjects, expandSessionLists } from "./perf/scenario.mjs"

const HELP = `Usage: bun run profile:heap -- [options]

Reads the JS heap, DOM nodes and listeners after GC: loaded, after hovering
the first N sidebar session rows, and after opening each of them.

Options:
  --url <url>              OpenChamber URL (default: http://localhost:3000)
  --count <n>              Sidebar rows to visit (default: 20)
  --hover <ms>             Pointer rest per row (default: 600)
  --dwell <ms>             Time on each opened session (default: 2000)
  --settle <seconds>       Wait after load (default: 12)
  --output <directory>     Writes heap-summary.json (default: artifacts/heap-profile-<time>)
  --label <text>           Human label stored in the summary
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Chrome profile; emptied before and removed after the
                           run (default: a fresh one under the OS temp directory)
  --headed                 Show the browser (default: headless)
  --help                   Show this help

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.`

const parseArgs = (argv) => {
  const options = { url: "http://localhost:3000", count: 20, hover: 600, dwell: 2000, settle: 12, output: null, label: null, chrome: null, profileDir: null, headless: true }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--count") options.count = Number(argv[++index])
    else if (value === "--hover") options.hover = Number(argv[++index])
    else if (value === "--dwell") options.dwell = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = resolve(argv[++index])
    else if (value === "--headed") options.headless = false
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("--count must be a positive integer")
  return options
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `heap-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  const profileDir = options.profileDir ?? join(tmpdir(), `openchamber-perf-heap-${process.pid}`)
  // Retained documents in a reused profile inflate the heap of later runs.
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(output, { recursive: true })
  const port = await reservePort()
  const chrome = launchChrome({ chrome: resolveChrome(options.chrome), profileDir, port, headless: options.headless })
  const summary = { recordedAt: new Date().toISOString(), label: options.label, url: options.url, count: options.count, rows: 0, readings: {} }
  let client
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("HeapProfiler.enable"), client.send("Performance.enable")])
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    let loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: options.url })
    await loaded
    await expandProjects(client)
    loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.reload")
    await loaded
    console.log(`Loaded ${options.url}; settling for ${options.settle}s.`)
    await wait(options.settle * 1000)
    await expandSessionLists(client)
    await wait(2000)

    const reading = async (name) => {
      await client.send("HeapProfiler.collectGarbage")
      await wait(2000)
      await client.send("HeapProfiler.collectGarbage")
      const usage = await client.send("Runtime.getHeapUsage")
      const metrics = metricMap((await client.send("Performance.getMetrics")).metrics)
      summary.readings[name] = {
        usedMb: round(usage.usedSize / 1048576, 1),
        totalMb: round(usage.totalSize / 1048576, 1),
        domNodes: metrics.Nodes,
        listeners: metrics.JSEventListeners,
      }
      const entry = summary.readings[name]
      console.log(`${name.padEnd(12)} heap ${entry.usedMb} MB  DOM nodes ${entry.domNodes}  listeners ${entry.listeners}`)
    }
    const rows = (await evaluateValue(client, `[...document.querySelectorAll('[data-session-row]')].map((el) => el.getAttribute('data-session-row'))`)) ?? []
    const plan = rows.slice(0, options.count)
    summary.rows = plan.length
    if (plan.length === 0) throw new Error("The sidebar rendered no session rows; the scenario never ran.")
    if (plan.length < options.count) console.warn(`WARNING: only ${plan.length} sidebar rows; asked for ${options.count}. Compare only runs with the same row count.`)
    const pointAt = async (id) => {
      const box = await evaluateValue(client, `(() => {
        const el = document.querySelector('[data-session-row="${id}"]')
        if (!el) return null
        el.scrollIntoView({ block: "center" })
        const rect = el.getBoundingClientRect()
        return { x: rect.x + 60, y: rect.y + rect.height / 2 }
      })()`)
      if (box) await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y })
      return box
    }

    await reading("loaded")
    for (const id of plan) {
      await pointAt(id)
      await wait(options.hover)
    }
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1200, y: 500 })
    await reading("afterHover")
    let opened = 0
    for (const id of plan) {
      const box = await pointAt(id)
      if (!box) continue
      await wait(300)
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 })
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 })
      opened += 1
      await wait(options.dwell)
    }
    summary.opened = opened
    if (opened < plan.length) console.warn(`WARNING: ${plan.length - opened} rows disappeared before they could be opened.`)
    await reading("afterClicks")
  } finally {
    client?.close()
    chrome.kill()
    await wait(500)
    rmSync(profileDir, { recursive: true, force: true })
  }
  await writeFile(join(output, "heap-summary.json"), JSON.stringify(summary, null, 2))
  console.log(`Saved to ${output}`)
}

main().catch((error) => {
  console.error(`Heap profiling failed: ${error.message}`)
  process.exitCode = 1
})
