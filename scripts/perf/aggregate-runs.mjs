#!/usr/bin/env node
/**
 * Median and p95 over repeated single-run captures.
 *
 * `profile:session` and `profile:idle` record one run per invocation, and one
 * run is never a result. Point this at the artifact directories of repeated
 * runs of one scenario and it reports, per metric, the median, p95, min, max
 * and how many runs carried the metric. A metric missing from a run (null,
 * an instrument that did not fire) is left out of its statistics and shows in
 * `n`, never as zero.
 *
 *   node scripts/perf/aggregate-runs.mjs results/baseline/session-stream-300cps-* --output results/baseline/session-stream-300cps.json
 */

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

import { percentile, round } from "./metrics.mjs"
import { invalidReasons, readSummary } from "./run-summary.mjs"

const HELP = `Usage: node scripts/perf/aggregate-runs.mjs <run directory>... [--output <file.json>]

Reads the *-summary.json in each directory and prints median, p95, min, max
and n for every numeric field under "metrics" (or the top level when there is
no "metrics" object). Also checks the validity flags the profilers record and
lists runs that measured nothing.`

const parseArgs = (argv) => {
  const options = { directories: [], output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--output") options.output = argv[++index]
    else options.directories.push(resolve(value))
  }
  if (options.directories.length === 0) throw new Error("Pass at least one run directory.")
  return options
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const runs = []
  for (const directory of options.directories) {
    const summary = readSummary(directory)
    if (!summary) { console.warn(`No summary in ${directory}; skipped.`); continue }
    runs.push({ directory, ...summary, invalid: invalidReasons(summary.data) })
  }
  const valid = runs.filter((run) => run.invalid.length === 0)
  for (const run of runs.filter((entry) => entry.invalid.length > 0)) console.warn(`Excluded ${run.directory}: ${run.invalid.join(", ")}`)

  const values = new Map()
  for (const run of valid) {
    const source = run.data.metrics && typeof run.data.metrics === "object" ? run.data.metrics : run.data
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue
      if (!values.has(key)) values.set(key, [])
      values.get(key).push(value)
    }
  }
  const metrics = Object.fromEntries([...values.entries()].map(([key, series]) => [key, {
    n: series.length,
    median: percentile(series, 0.5),
    p95: percentile(series, 0.95),
    min: round(series.reduce((min, value) => Math.min(min, value), Infinity)),
    max: round(series.reduce((max, value) => Math.max(max, value), -Infinity)),
  }]))

  console.log(`${valid.length} valid of ${runs.length} runs\n`)
  console.log(`${"metric".padEnd(34)} ${"median".padStart(10)} ${"p95".padStart(10)} ${"min".padStart(10)} ${"max".padStart(10)}  n`)
  for (const [key, stats] of Object.entries(metrics)) {
    console.log(`${key.padEnd(34)} ${String(stats.median).padStart(10)} ${String(stats.p95).padStart(10)} ${String(stats.min).padStart(10)} ${String(stats.max).padStart(10)}  ${stats.n}`)
  }
  if (options.output) {
    writeFileSync(resolve(options.output), JSON.stringify({ runs: runs.map(({ directory, invalid }) => ({ directory, invalid })), validRuns: valid.length, metrics }, null, 2))
    console.log(`\nWritten to ${resolve(options.output)}`)
  }
  if (valid.length === 0) process.exitCode = 1
}

main()
