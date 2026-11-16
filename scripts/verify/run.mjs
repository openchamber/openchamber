#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { startBrowser } from "./browser.mjs"
import { DEFAULT_MODEL, attachKeptStand, startStand } from "./stand.mjs"
import { ACTION_NAMES, StepFailure, runStep } from "./steps.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "../..")

const HELP = `Usage: bun run verify -- [selection...] [options]

Starts an isolated dev instance on free ports, runs the selected scenarios in
headless Chrome, and exits non-zero when any of them fails.

Selection: a zone (composer), a feature (composer.send) or one scenario
(composer.send.enter). Nothing selected runs every scenario.

Options:
  --list            Print the feature map for the selection and exit
  --repeat <n>      Run the selection n times in the same stand
  --out <dir>       Artifacts directory (default: tmp/verify/<time>)
  --keep            Keep the stand running after the run; prints how to attach
  --attach <file>   Reuse a stand kept by --keep (its stand.json)
  --headed          Show the browser window
  --chrome <path>   Chrome executable
  --help            Show this help`

const parseArgs = (argv) => {
  const options = { selection: [], list: false, repeat: 1, out: null, keep: false, attach: null, headed: false, chrome: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--list") options.list = true
    else if (value === "--repeat") options.repeat = Math.max(1, Number(argv[++index]))
    else if (value === "--out") options.out = resolve(argv[++index])
    else if (value === "--keep") options.keep = true
    else if (value === "--attach") options.attach = resolve(argv[++index])
    else if (value === "--headed") options.headed = true
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`)
    else options.selection.push(value)
  }
  return options
}

const loadMap = () => {
  const vocabulary = JSON.parse(readFileSync(join(HERE, "vocabulary.json"), "utf8"))
  const zones = readdirSync(join(HERE, "zones")).filter((file) => file.endsWith(".json")).sort()
    .map((file) => JSON.parse(readFileSync(join(HERE, "zones", file), "utf8")))
  const scenarios = []
  const problems = []
  for (const zone of zones) {
    for (const feature of zone.features) {
      for (const scenario of feature.scenarios) {
        const id = `${zone.zone}.${feature.id}.${scenario.id}`
        scenarios.push({ ...scenario, id, zone, feature })
        for (const [index, step] of scenario.steps.entries()) {
          if (!ACTION_NAMES.includes(step.do)) problems.push(`${id} step ${index + 1}: unknown step "${step.do}"`)
          if (step.on && !vocabulary[step.on]) problems.push(`${id} step ${index + 1}: "${step.on}" is not in the vocabulary`)
          if (step.to?.on && !vocabulary[step.to.on]) problems.push(`${id} step ${index + 1}: "${step.to.on}" is not in the vocabulary`)
        }
      }
    }
  }
  if (problems.length) throw new Error(`The feature map has errors:\n  ${problems.join("\n  ")}`)
  return { vocabulary, zones, scenarios }
}

const select = (scenarios, selection) => {
  if (selection.length === 0) return scenarios
  const chosen = scenarios.filter((scenario) => selection.some((name) => scenario.id === name || scenario.id.startsWith(`${name}.`)))
  const unknown = selection.filter((name) => !scenarios.some((scenario) => scenario.id === name || scenario.id.startsWith(`${name}.`)))
  if (unknown.length) throw new Error(`No scenario matches: ${unknown.join(", ")}. Run with --list to see the map.`)
  return chosen
}

const printMap = (zones, chosen) => {
  const ids = new Set(chosen.map((scenario) => scenario.id))
  for (const zone of zones) {
    const features = zone.features.filter((feature) => feature.scenarios.some((scenario) => ids.has(`${zone.zone}.${feature.id}.${scenario.id}`)))
    if (!features.length) continue
    console.log(`\n${zone.zone}: ${zone.name}\n  code: ${zone.sources.join(", ")}`)
    for (const feature of features) {
      console.log(`\n  ${zone.zone}.${feature.id}: ${feature.name}\n    what:  ${feature.what}\n    reach: ${feature.reach}\n    proof: ${feature.proof}`)
      for (const scenario of feature.scenarios) console.log(`    - ${scenario.id} [${scenario.kind}] ${scenario.title}`)
    }
  }
}

const WARMUP = [
  { do: "session.create", as: "s", title: "Warm-up" },
  { do: "session.send", session: "s", prompt: "Так, виправ у retry.ts." },
  { do: "open", session: "s" },
  { do: "see", on: "chat.answer", text: "Змінені файли", timeout: 90 },
  { do: "click", on: "panel.surface", surface: "diff" },
  { do: "click", on: "diff.file", text: "retry.ts", timeout: 60 },
  { do: "see", on: "diff.added", timeout: 60 },
  { do: "click", on: "panel.surface", surface: "editor" },
  { do: "see", on: "files.row", path: "src", timeout: 60 },
]

const warmUp = async ({ stand, browser, vocabulary }) => {
  const page = await browser.newPage()
  const ctx = { page, stand, vocabulary, vars: { project: stand.project }, background: [], defaultModel: DEFAULT_MODEL }
  try {
    for (const step of WARMUP) await runStep(step, ctx)
  } finally {
    await page.dispose()
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)

const runScenario = async ({ scenario, stand, browser, vocabulary, outDir, round }) => {
  const dir = join(outDir, round > 1 ? `round-${round}` : "", scenario.id)
  mkdirSync(dir, { recursive: true })
  await stand.reset()
  const page = await browser.newPage()
  await page.client.send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('pwa-install-toast-dismissed', 'true') } catch {}" })
  await page.client.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: stand.uiUrl, browserContextId: page.browserContextId }).catch(() => undefined)
  const downloadDir = join(dir, "downloads")
  await page.allowDownloads(downloadDir)
  const ctx = { page, stand, vocabulary, vars: { project: stand.project }, background: [], dir, downloadDir, shots: 0, artifacts: [], defaultModel: DEFAULT_MODEL }
  const startedAt = Date.now()
  const result = { id: scenario.id, title: scenario.title, ok: true, seconds: 0, failure: null, artifacts: ctx.artifacts, dir: relative(REPO_ROOT, dir) }
  for (const [index, step] of scenario.steps.entries()) {
    try {
      await runStep(step, ctx)
    } catch (error) {
      result.ok = false
      result.failure = { step: index + 1, do: step.do, on: step.on ?? null, message: error instanceof StepFailure ? error.message : `${error.message}` }
      break
    }
  }
  try {
    const name = result.ok ? "end.png" : "failure.png"
    await page.screenshot(join(dir, name))
    ctx.artifacts.push(name)
  } catch {
    result.artifacts.push("no screenshot: the page did not answer")
  }
  for (const task of ctx.background) task.stop()
  await Promise.all(ctx.background.map((task) => task.done))
  result.pageErrors = [...new Set(page.consoleErrors)].slice(0, 5)
  result.sourceUpdates = [...new Set(page.sourceUpdates)]
  if (result.ok && result.sourceUpdates.length) {
    result.ok = false
    result.failure = { step: null, do: "page", on: null, message: "the page reloaded or hot-updated during the scenario, so its result does not count; rerun it with the source unchanged" }
  }
  result.seconds = Math.round((Date.now() - startedAt) / 100) / 10
  await page.dispose()
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2))
  return result
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const { vocabulary, zones, scenarios } = loadMap()
  const chosen = select(scenarios, options.selection)
  if (options.list) {
    printMap(zones, chosen)
    console.log(`\n${chosen.length} scenarios`)
    return 0
  }
  const outDir = options.out ?? join(REPO_ROOT, "tmp/verify", stamp())
  mkdirSync(outDir, { recursive: true })
  const log = (message) => console.log(`[verify] ${message}`)
  const startedAt = Date.now()
  let browser = null
  let browserStarting = null
  let stopStand = async () => undefined
  const stopAll = async () => {
    const running = browser ?? await browserStarting?.catch(() => null)
    browser = null
    browserStarting = null
    await running?.stop()
    await stopStand()
  }
  let starting = null
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      void stopAll().then(() => starting?.catch(() => undefined)).then(() => process.exit(code))
    })
  }
  const results = []
  try {
    starting = options.attach
      ? attachKeptStand(JSON.parse(readFileSync(options.attach, "utf8")))
      : startStand({ log, logsDir: join(outDir, "logs"), onStop: (stop) => { stopStand = stop } })
    const stand = await starting
    const standFile = join(outDir, "stand.json")
    if (!options.attach) writeFileSync(standFile, JSON.stringify(stand.describe(), null, 2))
    log(`stand ready after ${Math.round((Date.now() - startedAt) / 1000)}s; ${chosen.length} scenarios × ${options.repeat}; warming up`)
    browserStarting = startBrowser({ chrome: options.chrome, headed: options.headed })
    browser = await browserStarting
    await stand.reset()
    await warmUp({ stand, browser, vocabulary })
    log(`warmed up after ${Math.round((Date.now() - startedAt) / 1000)}s`)
    for (let round = 1; round <= options.repeat; round += 1) {
      for (const scenario of chosen) {
        const result = await runScenario({ scenario, stand, browser, vocabulary, outDir, round: options.repeat > 1 ? round : 1 })
        result.round = round
        results.push(result)
        const line = `${result.ok ? "PASS" : "FAIL"} ${scenario.id} (${result.seconds}s)`
        const changed = result.sourceUpdates.length ? `\n     the source changed during this scenario: ${result.sourceUpdates.join(", ")}` : ""
        console.log(result.ok ? line : `${line}\n     ${result.failure.step ? `step ${result.failure.step} ` : ""}${result.failure.do}${result.failure.on ? ` ${result.failure.on}` : ""}: ${result.failure.message}\n     ${result.dir}/${result.artifacts.at(-1)}${changed}`)
      }
    }
    await browser.stop()
    browser = null
    browserStarting = null
    const failedCount = results.filter((result) => !result.ok).length
    const totalSeconds = Math.round((Date.now() - startedAt) / 1000)
    writeFileSync(join(outDir, "summary.json"), JSON.stringify({ passed: results.length - failedCount, failed: failedCount, seconds: totalSeconds, results }, null, 2))
    log(`${results.length - failedCount} passed, ${failedCount} failed in ${totalSeconds}s; artifacts in ${relative(REPO_ROOT, outDir)}`)
    if (options.keep && !options.attach) {
      log(`the stand keeps running at ${stand.uiUrl}; run more with --attach ${relative(REPO_ROOT, standFile)}; Ctrl-C stops it`)
      await new Promise(() => undefined)
    }
  } finally {
    await stopAll()
  }
  return results.some((result) => !result.ok) ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(`[verify] ${error.message}`)
  process.exitCode = 2
})
