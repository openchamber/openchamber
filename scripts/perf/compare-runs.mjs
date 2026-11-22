#!/usr/bin/env node
/**
 * Before/after table over two result directories.
 *
 * Each directory holds run directories named `<scenario>-<n>` (or just
 * `<scenario>`), as `profile:compare` writes them; every run directory holds
 * one `*-summary.json` from a profile:* command. Runs are grouped by scenario
 * and compared per metric, pairing the runs of the two sides by their <n>:
 * median and p95 on each side, the paired change with its interval, and a
 * verdict. Each scenario has one primary metric, the one its verdict is about;
 * the others get verdict words only once the primary has one, Holm-corrected.
 *
 *   node scripts/perf/compare-runs.mjs <before dir> <after dir> [--output comparison.md]
 */

import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { percentile, round } from "./metrics.mjs"
import { comparePairs, DEFAULT_CONFIDENCE, EQUIVALENCE, holmPasses, medianOf } from "./paired-stats.mjs"
import { invalidReasons, modifications, readSummary } from "./run-summary.mjs"
import { measuredToggles, TOGGLE_METRICS } from "./toggle-analysis.mjs"
import { cachedPipelineMetrics } from "./trace-analysis.mjs"

const HELP = `Usage: node scripts/perf/compare-runs.mjs <before dir> <after dir> [options]

Groups the run directories in each side by scenario (the name without its
trailing -<n>) and prints a markdown table: median / p95 (n) per side, the
paired change with its interval, and a verdict. Runs pair up by <n>; a verdict
needs 6 pairs. Runs whose validity flags say they measured nothing are excluded
and listed.

Options:
  --scenario <name>        Compare only this scenario (repeatable)
  --confidence <level>     Interval level (default: 0.95). A profile:compare with
                           --pairs auto used 0.9842: pass it to reprint that table
  --output <file>          Also write the table to this file
  --help                   Show this help`

const parseArgs = (argv) => {
  const options = { before: null, after: null, scenarios: [], output: null, confidence: DEFAULT_CONFIDENCE }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--scenario") options.scenarios.push(argv[++index])
    else if (value === "--output") options.output = resolve(argv[++index])
    else if (value === "--confidence") options.confidence = Number(argv[++index])
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

const processWakes = (data, label) => {
  const entries = data.processCpu?.processes?.filter((entry) => entry.label === label && entry.contextSwitchesPerSecond !== undefined) ?? []
  return entries.length ? entries.reduce((total, entry) => total + entry.contextSwitchesPerSecond, 0) : null
}

const metric = (key) => (data) => data.metrics?.[key]
const signal = (key) => (data) => data.pageSignals?.[key]
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
    [(data) => processWakes(data, "chrome renderer"), "renderer wakes/s", LOWER],
    [(data) => processWakes(data, "chrome GPU"), "GPU process wakes/s", LOWER],
    [signal("longestTaskMs"), "longest task ≥50 ms, observed", LOWER],
    [signal("longTaskCount"), "tasks ≥50 ms, observed", LOWER],
    [signal("layoutShift"), "layout shift", LOWER],
    [signal("requests"), "requests", LOWER],
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
    [(data) => processCpu(data, "chrome renderer"), "renderer process CPU %", LOWER],
    [(data) => processCpu(data, "chrome GPU"), "GPU process CPU %", LOWER],
    [(data) => processWakes(data, "chrome renderer"), "renderer wakes/s", LOWER],
    [(data) => processWakes(data, "chrome GPU"), "GPU process wakes/s", LOWER],
    [signal("requests"), "requests", LOWER],
    [signal("longTaskCount"), "tasks ≥50 ms, observed", LOWER],
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

/** The metric each scenario's verdict is about, by scenario name, then by kind. */
const PRIMARY = {
  quiet: "main-thread busy %",
  cpu: "renderer process CPU %",
  session: "busy ms per 1k chars",
  idle: "main-thread busy %",
  switch: "cold visible ms",
  startup: "usable ms",
  heap: "heap after opening MB",
  composer: "recalc ms per line",
}
const primaryLabel = (scenario, kind, labels) => PRIMARY[scenario] ?? PRIMARY[kind] ?? labels.find((label) => label.endsWith(" worst frame ms")) ?? labels[0]

/** Rows that count something: a value that holds in every pair is then the answer. */
const isCount = (label) => /\brequests\b|tasks ≥50 ms|dropped frames|forced style\/layouts/.test(label)

const finite = (values) => values.filter((value) => Number.isFinite(value))

const stats = (values) => {
  const series = finite(values)
  if (series.length === 0) return null
  return { n: series.length, median: percentile(series, 0.5), p95: percentile(series, 0.95), min: round(Math.min(...series)), max: round(Math.max(...series)) }
}

const scenarioOf = (name) => name.replace(/-\d+$/, "")
const pairNumber = (name) => Number(/-(\d+)$/.exec(name)?.[1] ?? 1)

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
const signed = (value, unit) => `${value > 0 ? "+" : ""}${formatNumber(round(value, 1))}${unit}`
const formatChange = (comparison) => {
  if (!comparison) return "–"
  const unit = comparison.ratio ? "%" : ""
  if (comparison.exact) return `${signed(comparison.change, unit)} exact`
  return `${signed(comparison.change, unit)} [${signed(comparison.lower, unit)} … ${signed(comparison.upper, unit)}]`
}
const directionWord = (comparison, lowerIsBetter) => {
  if (comparison.direction === "same") return comparison.exact ? "same (exact)" : "same"
  return (comparison.direction === "lower") === lowerIsBetter ? "better" : "WORSE"
}

/** The values of one metric per pair of runs that both have it. */
const pairedValues = (label, beforeRuns, afterRuns) => {
  const values = (runs) => new Map(runs.flatMap((run) => {
    const series = run.invalid.length ? null : seriesFor([run]).get(label)
    return series?.values.length ? [[pairNumber(run.name), medianOf(series.values)]] : []
  }))
  const before = values(beforeRuns)
  const after = values(afterRuns)
  return [...before.keys()].filter((key) => after.has(key)).map((key) => ({ before: before.get(key), after: after.get(key) }))
}

/** The comparison of a scenario's primary metric, what a planned look decides on. */
export const comparePrimary = (beforeRoot, afterRoot, scenario, { confidence = DEFAULT_CONFIDENCE, throughPair = Infinity } = {}) => {
  // A resumed compare holds later pairs too; a look reads only the ones it planned.
  const runsOf = (root) => (loadSide(root).get(scenario) ?? []).filter((run) => pairNumber(run.name) <= throughPair)
  const beforeRuns = runsOf(beforeRoot)
  const afterRuns = runsOf(afterRoot)
  if (!beforeRuns.length || !afterRuns.length) return null
  const label = primaryLabel(scenario, beforeRuns[0].kind, [...seriesFor(beforeRuns).keys()])
  const pairs = pairedValues(label, beforeRuns, afterRuns)
  return { label, comparison: comparePairs(pairs, { confidence, count: isCount(label) }) }
}

/**
 * Rows of one scenario. Workload rows must match. Exact counts always read,
 * and the rest need the primary's verdict and Holm across the secondaries, so
 * a table of twenty metrics does not cry wolf on one of them every run.
 */
const metricRows = (scenario, beforeRuns, afterRuns, confidence) => {
  const beforeSeries = seriesFor(beforeRuns)
  const afterSeries = seriesFor(afterRuns)
  const labels = [...new Set([...beforeSeries.keys(), ...afterSeries.keys()])]
    .filter((label) => (beforeSeries.get(label)?.values.length ?? 0) + (afterSeries.get(label)?.values.length ?? 0) > 0)
  const primary = primaryLabel(scenario, beforeRuns[0].kind, labels)
  const rows = labels.map((label) => {
    const entry = beforeSeries.get(label) ?? afterSeries.get(label)
    const beforeStats = stats(beforeSeries.get(label)?.values ?? [])
    const afterStats = stats(afterSeries.get(label)?.values ?? [])
    const workload = entry.lowerIsBetter === WORKLOAD
    const comparison = workload ? null : comparePairs(pairedValues(label, beforeRuns, afterRuns), { confidence, count: isCount(label) })
    return { label, lowerIsBetter: entry.lowerIsBetter, beforeStats, afterStats, comparison, workload, verdict: workload && beforeStats && afterStats && beforeStats.median !== afterStats.median ? "WORKLOAD DIFFERS" : "" }
  })
  const primaryRow = rows.find((row) => row.label === primary)
  if (primaryRow?.comparison?.direction) primaryRow.verdict = directionWord(primaryRow.comparison, primaryRow.lowerIsBetter)
  const secondaries = rows.filter((row) => row !== primaryRow && !row.workload && row.comparison)
  for (const row of secondaries) if (row.comparison.exact) row.verdict = directionWord(row.comparison, row.lowerIsBetter)
  const tested = secondaries.filter((row) => !row.comparison.exact)
  if (primaryRow?.verdict) {
    const passes = holmPasses(tested.map((row) => row.comparison.p))
    tested.forEach((row, index) => {
      const { direction } = row.comparison
      if (passes[index] && (direction === "lower" || direction === "higher")) row.verdict = directionWord(row.comparison, row.lowerIsBetter)
    })
  }
  return rows.map((row) => `| ${row === primaryRow ? `**${row.label}**` : row.label} | ${formatSide(row.beforeStats)} | ${formatSide(row.afterStats)} | ${row.workload ? "" : formatChange(row.comparison)} | ${row.comparison?.n ?? ""} | ${row.verdict} |`)
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
export const compareResultDirs = (beforeRoot, afterRoot, { scenarios = [], confidence = DEFAULT_CONFIDENCE } = {}) => {
  const before = loadSide(beforeRoot)
  const after = loadSide(afterRoot)
  const names = [...new Set([...before.keys(), ...after.keys()])].filter((name) => scenarios.length === 0 || scenarios.includes(name))
  const lines = [
    `Before: ${beforeRoot}`,
    `After: ${afterRoot}`,
    "",
    `median / p95 (n) per side; change per pair with its ${Math.round(confidence * 1000) / 10}% interval. The bold row is the primary. "same": the interval lies inside ±${EQUIVALENCE * 100}%. No word: no verdict yet, or a secondary before the primary has one. Lower is better except workload rows, which must match.`,
  ]
  for (const name of names) {
    const beforeRuns = before.get(name) ?? []
    const afterRuns = after.get(name) ?? []
    lines.push("", `### ${name}`, "")
    if (!beforeRuns.length || !afterRuns.length) {
      lines.push(`Only measured on the ${beforeRuns.length ? "before" : "after"} side.`)
      continue
    }
    lines.push("| metric | before | after | change [interval] | pairs | |", "|---|---|---|---|---|---|")
    lines.push(...metricRows(name, beforeRuns, afterRuns, confidence))
    lines.push(...componentTable(beforeRuns, afterRuns))
    const validity = [...validityLines("before", beforeRuns), ...validityLines("after", afterRuns), ...accessibilityLines(beforeRuns, afterRuns)]
    if (validity.length) lines.push("", ...validity.map((line) => `- ${line}`))
  }
  return lines.join("\n")
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const table = compareResultDirs(options.before, options.after, { scenarios: options.scenarios, confidence: options.confidence })
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
