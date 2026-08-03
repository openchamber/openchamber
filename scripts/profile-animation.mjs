#!/usr/bin/env node
/**
 * Measures what a CSS animation costs, in isolation.
 *
 * A continuously running animation is one of the few things an idle interface
 * keeps paying for, and the price depends entirely on whether the compositor
 * can drive the animated property. Compositor-driven properties cost a small
 * constant; everything else recalculates style on every frame, roughly an order
 * of magnitude more.
 *
 * Rather than rebuilding the application and streaming a response to answer
 * that question, this command serves a fixture page and measures each variant
 * directly, so a whole comparison takes seconds. Add a variant to
 * `perf/animation-fixture.html` to measure a property or technique that is not
 * listed yet.
 *
 * The output answers two questions the fixture is designed for:
 * - which properties are cheap to animate;
 * - whether cost scales with the number of animated elements (`--count`).
 */

import { createReadStream } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { metricMap, round } from "./perf/metrics.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(scriptDirectory, "perf", "animation-fixture.html")

const DEFAULT_VARIANTS = [
  "none",
  "transform-rotate",
  "transform-rotate-willchange",
  "transform-rotate-steps",
  "transform-rotate-wrapper",
  "rotate-property",
  "opacity",
  "translate",
  "scale",
  "background-position",
  "border-color",
  "box-shadow",
  "filter",
  "width",
  "ctx-button",
  "ctx-sibling-translatez",
  "ctx-filter",
  "ctx-overflow",
  "ctx-backdrop",
  "ctx-opacity",
  "ctx-transformed-parent",
  "ctx-currentcolor",
]

const HELP = `Usage: bun run profile:animation -- [options]

Measures the idle cost of CSS animations using an isolated fixture page.

Options:
  --variant <name>     Measure only this variant (repeatable)
  --count <n>          Animated elements per variant (default: 2)
  --duration <seconds> Measurement window per variant (default: 10)
  --settle <seconds>   Wait before measuring each variant (default: 3)
  --filler <n>         Static elements added to the page, to measure a variant
                       against a realistically sized document (default: 0)
  --chrome <path>      Chrome/Chromium executable
  --profile-dir <path> Reusable isolated Chrome profile
  --headed             Show the browser (default: headless)
  --json               Print results as JSON
  --help               Show this help

Variants live in scripts/perf/animation-fixture.html. Add one there to measure
a property or technique that is not covered.`

const parseArgs = (argv) => {
  const options = {
    variants: [],
    count: 2,
    duration: 10,
    settle: 3,
    filler: 0,
    chrome: null,
    profileDir: join(homedir(), ".openchamber", "browser-profile-google-chrome"),
    headless: true,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") return { ...options, help: true }
    else if (value === "--headed") options.headless = false
    else if (value === "--json") options.json = true
    else if (value === "--variant") options.variants.push(argv[++index])
    else if (value === "--count") options.count = Number(argv[++index])
    else if (value === "--duration") options.duration = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--filler") options.filler = Number(argv[++index])
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = argv[++index]
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new Error("--duration must be a positive number")
  if (!Number.isFinite(options.count) || options.count < 1) throw new Error("--count must be at least 1")
  if (options.variants.length === 0) options.variants = DEFAULT_VARIANTS
  return options
}

/** Serves only the fixture, on an ephemeral loopback port. */
const startFixtureServer = () => new Promise((resolvePromise, reject) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    createReadStream(fixturePath).pipe(response)
  })
  server.on("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      reject(new Error("Could not bind the fixture server"))
      return
    }
    resolvePromise({ server, port: address.port })
  })
})

const measureVariant = async (client, url, options) => {
  const loaded = client.once("Page.loadEventFired", 30_000)
  await client.send("Page.navigate", { url })
  await loaded
  await wait(options.settle * 1000)

  const before = metricMap((await client.send("Performance.getMetrics")).metrics)
  const startedAt = Date.now()
  await wait(options.duration * 1000)
  const elapsedSeconds = (Date.now() - startedAt) / 1000
  const after = metricMap((await client.send("Performance.getMetrics")).metrics)

  const delta = (name) => Number(after[name] ?? 0) - Number(before[name] ?? 0)
  return {
    recalcStylePerSecond: round(delta("RecalcStyleCount") / elapsedSeconds),
    layoutsPerSecond: round(delta("LayoutCount") / elapsedSeconds),
    mainThreadBusyPercent: round((delta("TaskDuration") / elapsedSeconds) * 100),
    recalcStyleMsPerSecond: round((delta("RecalcStyleDuration") / elapsedSeconds) * 1000),
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const chrome = resolveChrome(options.chrome)
  const { server, port: fixturePort } = await startFixtureServer()
  const debuggingPort = await reservePort()
  const chromeProcess = launchChrome({
    chrome,
    profileDir: resolve(options.profileDir),
    port: debuggingPort,
    headless: options.headless,
  })

  let client
  const results = []
  try {
    const target = await createPageTarget(debuggingPort)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Performance.enable"),
    ])
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1200, height: 800, deviceScaleFactor: 1, mobile: false,
    })

    console.log(`Measuring ${options.variants.length} variants, ${options.count} element(s) each, ${options.duration}s per variant.\n`)
    for (const variant of options.variants) {
      const url = `http://127.0.0.1:${fixturePort}/?variant=${encodeURIComponent(variant)}&count=${options.count}&filler=${options.filler}`
      const measured = await measureVariant(client, url, options)
      results.push({ variant, ...measured })
      if (!options.json) {
        console.log(
          `${variant.padEnd(30)} recalc/s ${String(measured.recalcStylePerSecond).padStart(8)}`
          + `   layout/s ${String(measured.layoutsPerSecond).padStart(6)}`
          + `   busy% ${String(measured.mainThreadBusyPercent).padStart(6)}`,
        )
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ count: options.count, durationSeconds: options.duration, results }, null, 2))
      return
    }

    const baseline = results.find((entry) => entry.variant === "none")
    if (baseline) {
      console.log(
        `\nA still page costs ${baseline.recalcStylePerSecond} style recalculations per second.`
        + " Compositor-driven properties add a small constant; anything far above that recalculates every frame.",
      )
    }
  } finally {
    client?.close()
    if (!chromeProcess.killed) chromeProcess.kill("SIGTERM")
    server.close()
  }
}

main().catch((error) => {
  console.error(`Animation profiling failed: ${error.message}`)
  process.exitCode = 1
})
