#!/usr/bin/env node
/**
 * Before/after table over two result directories.
 *
 * Each directory holds run directories named `<scenario>-<n>` (or just
 * `<scenario>`), as `profile:compare` writes them; every run directory holds
 * one `*-summary.json` from a profile:* command. Runs are grouped by scenario
 * and compared per metric: median and p95 on each side, the change of the
 * median, and a verdict that calls a change noise when the after median lies
 * inside the range the before runs spread over.
 *
 *   node scripts/perf/compare-runs.mjs <before dir> <after dir> [--output comparison.md]
 */

import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { percentile, round } from "./metrics.mjs"
import { invalidReasons, modifications, readSummary } from "./run-summary.mjs"
import { measuredToggles, TOGGLE_METRICS } from "./toggle-analysis.mjs"
import { cachedPipelineMetrics } from "./trace-analysis.mjs"

const HELP = `Usage: node scripts/perf/compare-runs.mjs <before dir> <after dir> [options]

Groups the run directories in each side by scenario (the name without its
trailing -<n>) and prints a markdown table: median / p95 (n) per side, the
change of the median, and a verdict. Runs whose validity flags say they
measured nothing are excluded and listed.

Options:
  --scenario <name>        Compare only this scenario (repeatable)
  --output <file>          Also write the table to this file
  --help                   Show this help`

const parseArgs = (argv) => {
  const options = { before: null, after: null, scenarios: [], output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--scenario") options.scenarios.push(argv[++index])
    else if (value === "--output") options.output = resolve(argv[++index])
    else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`)
    else if (!options.before) options.before = resolve(value)
    else if (!options.after) options.after = resolve(value)
    else throw new Error(`Unexpected argument: ${value}`)
  }
  if (!options.before || !options.after) throw new Error("Pass a before and an after directory.")
  return options
}

const LOWER = true
const HIGHER = false
// A workload metric is not better or worse; a difference means the two sides
// did not measure the same thing.
const WORKLOAD = null

const processCpu = (data, label) => {
  const entries = data.processCpu?.processes?.filter((entry) => entry.label === label) ?? []
  return entries.length ? entries.reduce((total, entry) => total + entry.averagePercent, 0) : null
}

const metric = (key) => (data) => data.metrics?.[key]
// Read from the timeline trace, which an uninstrumented run (`--process-cpu-only`)
// never records: its summary holds placeholder zeros, so they read as missing.
const traceMetric = (key) => (data) => (data.instrumented === false ? null : data.metrics?.[key])

/** Per-run values: one number per run directory and metric, as [read(summary), label, lowerIsBetter]. */
const RUN_METRICS = {
  session: [
    [traceMetric("longestTaskMs"), "longest task ms", LOWER],
    [traceMetric("longTaskCount"), "tasks >50 ms", LOWER],
    [traceMetric("tasksOver16msCount"), "main tasks >16.7 ms", LOWER],
    [traceMetric("tasksOver8msCount"), "main tasks >8.33 ms", LOWER],
    [traceMetric("finalizeLongestTaskMs"), "longest task ≤1 s after idle ms", LOWER],
    [traceMetric("accessibilityMs"), "accessibility ms", LOWER],
    [traceMetric("taskP99Ms"), "task p99 ms", LOWER],
    [metric("mainThreadBusyPercent"), "main-thread busy %", LOWER],
    [metric("busyMsPerKilochar"), "busy ms per 1k chars", LOWER],
    [metric("recalcStylePerSecond"), "style recalcs/s", LOWER],
    [metric("layoutsPerSecond"), "layouts/s", LOWER],
    [metric("framesPerSecond"), "rAF callbacks/s", LOWER],
    [metric("heapMaxMb"), "heap max MB", LOWER],
    [(data) => processCpu(data, "chrome renderer"), "renderer process CPU %", LOWER],
    [(data) => processCpu(data, "chrome GPU"), "GPU process CPU %", LOWER],
    [(data) => data.processCpu?.totalAveragePercent ?? null, "all processes CPU %", LOWER],
    [metric("renderedCharacters"), "rendered characters (workload)", WORKLOAD],
  ],
  idle: [
    [metric("framesPerSecond"), "frames drawn/s", LOWER],
    [metric("mainThreadBusyPercent"), "main-thread busy %", LOWER],
    [metric("scriptPercent"), "script %", LOWER],
    [metric("recalcStylePerSecond"), "style recalcs/s", LOWER],
    [metric("layoutsPerSecond"), "layouts/s", LOWER],
    [metric("tasksPerSecond"), "tasks/s", LOWER],
    [metric("listenerGrowth"), "listener growth", LOWER],
    [metric("nodeGrowth"), "DOM node growth", LOWER],
    [metric("heapGrowthMbPerSecond"), "heap growth MB/s", LOWER],
  ],
  heap: [
    [(data) => data.readings?.loaded?.usedMb, "heap loaded MB", LOWER],
    [(data) => data.readings?.afterHover?.usedMb, "heap after hovering MB", LOWER],
    [(data) => data.readings?.afterClicks?.usedMb, "heap after opening MB", LOWER],
    [(data) => data.readings?.afterClicks?.domNodes, "DOM nodes after opening", LOWER],
    [(data) => data.rows, "sidebar rows visited (workload)", WORKLOAD],
  ],
  composer: [
    [(data) => data.medianPerLine?.recalcs, "style recalcs per line", LOWER],
    [(data) => data.medianPerLine?.elements, "elements restyled per line", LOWER],
    [(data) => data.medianPerLine?.ms, "recalc ms per line", LOWER],
  ],
  toggle: [
    [(data) => data.session?.mountedMessages, "mounted messages (workload)", WORKLOAD],
  ],
}

const PIPELINE_METRICS = [
  ["framesSubmittedPerSecond", "frames submitted/s", LOWER],
  ["mainCommitsPerSecond", "main-thread frame commits/s", LOWER],
  ["paintsPerSecond", "paints/s", LOWER],
  ["recalcElementsPerSecond", "elements restyled/s", LOWER],
  ["layerizeMsPerSecond", "layerize ms/s", LOWER],
  ["gpuCompositorMsPerSecond", "GPU compositor ms/s", LOWER],
  ["rasterMsPerSecond", "raster ms/s", LOWER],
]

const RENDER_METRICS = [
  ["commitsPerSecond", "React commits/s", LOWER],
  ["rendersPerSecond", "component renders/s", LOWER],
  ["rendersWithoutDomChangePerSecond", "renders with no DOM change/s", LOWER],
]

/** Pooled values: every switch or launch of every run is one sample. */
const SWITCH_METRICS = [
  [(entry) => entry.ack, "ack ms"],
  [(entry) => entry.content, "content ms"],
  [(entry) => entry.visible, "visible ms"],
  [(entry) => entry.longestTask, "longest task ms"],
  [(entry) => entry.accessibility?.ms, "accessibility ms"],
  [(entry) => entry.shift?.maxPx, "shift after reveal px"],
  [(entry) => entry.requestCount, "requests"],
  [(entry) => entry.network?.decodedKb, "decoded KB"],
]

const STARTUP_MILESTONES = [
  ["firstContentfulPaint", "first contentful paint ms"],
  ["reactMounted", "React mounted ms"],
  ["composerEditable", "composer editable ms"],
  ["usable", "usable ms"],
  ["modelPickerReady", "model picker ready ms"],
  ["sessionRows", "session rows visible ms"],
  ["rendererIdle", "renderer idle ms"],
]

const finite = (values) => values.filter((value) => Number.isFinite(value))

const stats = (values) => {
  const series = finite(values)
  if (series.length === 0) return null
  return { n: series.length, median: percentile(series, 0.5), p95: percentile(series, 0.95), min: round(Math.min(...series)), max: round(Math.max(...series)) }
}

const scenarioOf = (name) => name.replace(/-\d+$/, "")

/** Run directories of one side, grouped by scenario. */
const loadSide = (root) => {
  const groups = new Map()
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name)
    if (!statSync(directory).isDirectory()) continue
    const summary = readSummary(directory)
    if (!summary) continue
    const scenario = scenarioOf(name)
    if (!groups.has(scenario)) groups.set(scenario, [])
    groups.get(scenario).push({ directory, name, ...summary, invalid: invalidReasons(summary.data), modified: modifications(summary.data) })
  }
  return groups
}

/** Metric series for one scenario's runs, keyed by label. */
const seriesFor = (runs) => {
  const valid = runs.filter((run) => run.invalid.length === 0)
  const kind = runs[0]?.kind
  const series = new Map()
  const push = (label, lowerIsBetter, values) => {
    const entry = series.get(label) ?? { label, lowerIsBetter, values: [] }
    entry.values.push(...finite(values))
    series.set(label, entry)
  }
  for (const [read, label, lowerIsBetter] of RUN_METRICS[kind] ?? []) {
    push(label, lowerIsBetter, valid.map((run) => read(run.data)))
  }
  if (kind === "session") {
    for (const run of valid) {
      const pipeline = cachedPipelineMetrics(run.directory)
      if (pipeline) for (const [key, label, lowerIsBetter] of PIPELINE_METRICS) push(label, lowerIsBetter, [pipeline[key]])
    }
  }
  if (kind === "switch") {
    for (const visit of ["cold", "warm"]) {
      const entries = valid.flatMap((run) => run.data.switches ?? []).filter((entry) => entry.visit === visit && entry.ack !== null && entry.content !== null)
      for (const [read, label] of SWITCH_METRICS) push(`${visit} ${label}`, LOWER, entries.map(read))
    }
  }
  if (kind === "toggle") {
    // Pooled per toggle type: every measured toggle of every run is one sample.
    const toggles = valid.flatMap((run) => measuredToggles(run.data.toggles ?? []))
    for (const type of new Set(toggles.map((toggle) => toggle.type))) {
      const ofType = toggles.filter((toggle) => toggle.type === type)
      for (const [, label, read, shown] of TOGGLE_METRICS) if (shown) push(`${type} ${label}`, LOWER, ofType.map(read))
    }
  }
  if (kind === "startup") {
    const samples = valid.flatMap((run) => run.data.samples ?? []).filter((sample) => !sample.error)
    for (const [key, label] of STARTUP_MILESTONES) push(label, LOWER, samples.map((sample) => sample.msSinceSpawn?.[key]))
    push("requests until usable", LOWER, samples.map((sample) => sample.network?.count))
    push("decoded KB until usable", LOWER, samples.map((sample) => sample.network?.decodedKb))
  }
  for (const run of valid) {
    if (!run.data.renderProbe) continue
    for (const [key, label, lowerIsBetter] of RENDER_METRICS) push(label, lowerIsBetter, [run.data.renderProbe[key]])
  }
  return series
}

const formatNumber = (value) => (value === null || value === undefined ? "–" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 }))
const formatSide = (side) => (side ? `${formatNumber(side.median)} / ${formatNumber(side.p95)} (${side.n})` : "–")
const formatDelta = (before, after) => {
  if (!before || !after) return "–"
  const change = after.median - before.median
  if (change === 0) return "0"
  const percent = before.median === 0 ? "" : ` (${change > 0 ? "+" : ""}${Math.round((change / Math.abs(before.median)) * 100)}%)`
  return `${change > 0 ? "+" : ""}${formatNumber(round(change))}${percent}`
}
const verdictOf = (before, after, lowerIsBetter) => {
  if (!before || !after || before.median === after.median) return ""
  if (lowerIsBetter === WORKLOAD) return "WORKLOAD DIFFERS"
  if (after.median >= before.min && after.median <= before.max) return "noise"
  return (after.median < before.median) === lowerIsBetter ? "better" : "WORSE"
}

/** Renders/s per component, for scenarios that ran with the render probe. */
const componentTable = (beforeRuns, afterRuns) => {
  const rates = (runs) => {
    const perComponent = new Map()
    for (const run of runs.filter((entry) => entry.invalid.length === 0 && entry.data.renderProbe)) {
      for (const component of run.data.renderProbe.components ?? []) {
        if (!perComponent.has(component.name)) perComponent.set(component.name, [])
        perComponent.get(component.name).push(component.perSecond)
      }
    }
    return perComponent
  }
  const before = rates(beforeRuns)
  const after = rates(afterRuns)
  if (before.size === 0 && after.size === 0) return []
  const median = (map, name) => (map.has(name) ? percentile(map.get(name), 0.5) : 0)
  const names = [...new Set([...before.keys(), ...after.keys()])]
    .sort((left, right) => Math.max(median(before, right), median(after, right)) - Math.max(median(before, left), median(after, left)))
    .slice(0, 25)
  return [
    "",
    "| component | before renders/s | after renders/s |",
    "|---|---|---|",
    ...names.map((name) => `| ${name} | ${formatNumber(median(before, name))} | ${formatNumber(median(after, name))} |`),
  ]
}

/**
 * Whether the runs built an accessibility tree. Chrome builds one only while a
 * client asks (a screen reader, a macOS app that reads other windows, or
 * `--force-accessibility`), and it adds a serialization pass to frames that
 * change what it exposes, so runs with and without one do not compare.
 */
const accessibilityOf = (run) => {
  const state = run.data.accessibility
  if (!state?.recorded) return "not recorded"
  if (!state.active) return "off"
  return state.forced ? "on (forced)" : "on (client)"
}

const accessibilityLines = (beforeRuns, afterRuns) => {
  const describe = (runs) => {
    const counts = new Map()
    for (const run of runs) counts.set(accessibilityOf(run), (counts.get(accessibilityOf(run)) ?? 0) + 1)
    return counts
  }
  const before = describe(beforeRuns)
  const after = describe(afterRuns)
  if (before.size === 1 && after.size === 1 && before.has("not recorded") && after.has("not recorded")) return []
  const text = (counts) => [...counts].map(([state, count]) => `${state} in ${count}`).join(", ")
  const states = new Set([...before.keys(), ...after.keys()])
  const differs = states.size > 1 && !(states.size === 2 && states.has("not recorded"))
  return [`${differs ? "ACCESSIBILITY DIFFERS, timings do not compare: " : ""}accessibility tree before: ${text(before)}; after: ${text(after)}`]
}

/** Validity notes per side for one scenario. */
const validityLines = (side, runs) => {
  const lines = []
  const excluded = runs.filter((run) => run.invalid.length > 0)
  if (excluded.length) lines.push(`${side}: excluded ${excluded.length} of ${runs.length} runs: ${excluded.map((run) => `${run.name} (${run.invalid.join(", ")})`).join("; ")}`)
  const modified = [...new Set(runs.flatMap((run) => run.modified))]
  if (modified.length) lines.push(`${side}: ${modified.join(", ")}`)
  const liveness = finite(runs.map((run) => Number(run.data.frameLiveness?.framesPerSecond ?? run.data.frameLiveness)))
  if (liveness.length && Math.min(...liveness) < 20) lines.push(`${side}: lowest frame liveness ${Math.min(...liveness)} frames/s`)
  const notPlaced = runs.filter((run) => run.kind === "session" && !run.data.quiet && run.data.instrumented !== false && run.data.sessionIdle?.inTrace === false)
  if (notPlaced.length) lines.push(`${side}: end of reply not placed on the trace in ${notPlaced.map((run) => run.name).join(", ")}; the after-idle metric is missing there`)
  const characters = finite(runs.filter((run) => run.invalid.length === 0).map((run) => run.data.metrics?.renderedCharacters))
  if (characters.length > 1 && Math.max(...characters) > Math.min(...characters) * 1.02) lines.push(`${side}: rendered characters vary ${Math.min(...characters)}…${Math.max(...characters)} between runs; normalise before comparing totals`)
  const invalidSwitches = runs.reduce((total, run) => total + (run.data.invalidSwitches ?? 0), 0)
  if (invalidSwitches) lines.push(`${side}: ${invalidSwitches} switches never acknowledged or showed content`)
  return lines
}

/** The markdown comparison of two result directories. */
export const compareResultDirs = (beforeRoot, afterRoot, { scenarios = [] } = {}) => {
  const before = loadSide(beforeRoot)
  const after = loadSide(afterRoot)
  const names = [...new Set([...before.keys(), ...after.keys()])].filter((name) => scenarios.length === 0 || scenarios.includes(name))
  const lines = [
    `Before: ${beforeRoot}`,
    `After: ${afterRoot}`,
    "",
    "median / p95 (n) per side. \"noise\": the after median lies inside the before runs' min…max. Lower is better except workload rows, which must match.",
  ]
  for (const name of names) {
    const beforeRuns = before.get(name) ?? []
    const afterRuns = after.get(name) ?? []
    lines.push("", `### ${name}`, "")
    if (!beforeRuns.length || !afterRuns.length) {
      lines.push(`Only measured on the ${beforeRuns.length ? "before" : "after"} side.`)
      continue
    }
    const beforeSeries = seriesFor(beforeRuns)
    const afterSeries = seriesFor(afterRuns)
    lines.push("| metric | before | after | Δ median | |", "|---|---|---|---|---|")
    for (const label of new Set([...beforeSeries.keys(), ...afterSeries.keys()])) {
      const entry = beforeSeries.get(label) ?? afterSeries.get(label)
      const beforeStats = stats(beforeSeries.get(label)?.values ?? [])
      const afterStats = stats(afterSeries.get(label)?.values ?? [])
      if (!beforeStats && !afterStats) continue
      lines.push(`| ${label} | ${formatSide(beforeStats)} | ${formatSide(afterStats)} | ${formatDelta(beforeStats, afterStats)} | ${verdictOf(beforeStats, afterStats, entry.lowerIsBetter)} |`)
    }
    lines.push(...componentTable(beforeRuns, afterRuns))
    const validity = [...validityLines("before", beforeRuns), ...validityLines("after", afterRuns), ...accessibilityLines(beforeRuns, afterRuns)]
    if (validity.length) lines.push("", ...validity.map((line) => `- ${line}`))
  }
  return lines.join("\n")
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const table = compareResultDirs(options.before, options.after, { scenarios: options.scenarios })
  console.log(table)
  if (options.output) writeFileSync(options.output, `${table}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`Comparison failed: ${error.message}`)
    process.exitCode = 1
  }
}
