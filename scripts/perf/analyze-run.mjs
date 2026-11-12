#!/usr/bin/env node
/**
 * Attribution report for one run directory of profile:session, profile:idle
 * or profile:switch: where the CPU went by function, source file and
 * component, who called a suspect, which call sites scheduled the work, what
 * the rendering pipeline did per second, which tasks were long and why, and
 * the render probe when the run had one.
 *
 * Every section reads an artifact the run already wrote and is skipped when
 * that artifact is missing. With `--dist` pointing at the build the run
 * served, chunk positions are mapped to source files; that needs the
 * diagnostic build's source maps (`bun run build:web:diag`).
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"

import { printRenderProbe, summarizeRenderProbe } from "./render-probe.mjs"
import { readSummary } from "./run-summary.mjs"
import { createSourceMapper } from "./source-map.mjs"
import { classifyTasks, largeRecalcs, loadTrace, pipelineMetrics, shortUrl, traceWindow } from "./trace-analysis.mjs"

const HELP = `Usage: bun run profile:analyze -- <run directory> [options]

Prints an attribution report from the artifacts of one profile:session,
profile:idle or profile:switch run.

Options:
  --dist <directory>       The packages/web/dist the run served. Maps chunk
                           positions to source files when it holds source maps
                           (the diagnostic build, dist-diag)
  --top <n>                Rows per table (default: 25)
  --callers <regex>        Group the CPU time of functions matching <regex>
                           (outermost match) by their caller chain
  --depth <n>              Caller chain depth for --callers (default: 4)
  --tasks-over <ms>        Classify main-thread tasks longer than this
                           (default: 16.7)
  --recalcs-over <n>       List style recalcs touching at least n elements
                           (default: 3000)
  --help                   Show this help`

const parseArgs = (argv) => {
  const options = { directory: null, dist: null, top: 25, callers: null, depth: 4, tasksOver: 16.7, recalcsOver: 3000 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--dist") options.dist = resolve(argv[++index])
    else if (value === "--top") options.top = Number(argv[++index])
    else if (value === "--callers") options.callers = new RegExp(argv[++index])
    else if (value === "--depth") options.depth = Number(argv[++index])
    else if (value === "--tasks-over") options.tasksOver = Number(argv[++index])
    else if (value === "--recalcs-over") options.recalcsOver = Number(argv[++index])
    else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`)
    else options.directory = resolve(value)
  }
  if (!options.directory) throw new Error("Pass a run directory.")
  return options
}

const fixed = (value, digits = 1) => String(Math.round(value * 10 ** digits) / 10 ** digits)

const cpuAttribution = (profile, mapper) => {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const frames = new Map()
  const frameOf = (id) => {
    if (frames.has(id)) return frames.get(id)
    const { callFrame } = nodes.get(id)
    const position = callFrame.url.includes("/assets/") ? mapper.mapPosition(callFrame.url, callFrame.lineNumber + 1, callFrame.columnNumber) : null
    const where = position ? `${position.source}:${position.line}` : callFrame.url ? `${callFrame.url.split("/").pop()}:${callFrame.lineNumber + 1}` : ""
    const frame = { name: callFrame.functionName || "(anonymous)", where, source: position?.source ?? null, key: `${callFrame.functionName || "(anonymous)"} ${where}`.trim() }
    frames.set(id, frame)
    return frame
  }
  const self = new Map()
  const inclusive = new Map()
  const files = new Map()
  const componentBodies = new Map()
  const add = (map, key, ms) => map.set(key, (map.get(key) ?? 0) + ms)
  let busyMs = 0
  let programMs = 0
  let gcMs = 0
  for (let index = 0; index < profile.samples.length; index += 1) {
    const ms = (profile.timeDeltas[index + 1] ?? 0) / 1000
    const leaf = profile.samples[index]
    const leafName = nodes.get(leaf).callFrame.functionName
    if (leafName === "(idle)") continue
    if (leafName === "(program)") { programMs += ms; continue }
    if (leafName === "(garbage collector)") gcMs += ms
    busyMs += ms
    add(self, frameOf(leaf).key, ms)
    const seen = new Set()
    for (let id = leaf; id !== undefined; id = parents.get(id)) {
      const frame = frameOf(id)
      if (!seen.has(frame.key)) { seen.add(frame.key); add(inclusive, frame.key, ms) }
      const file = frame.source && !frame.source.startsWith("nm:") ? frame.source : null
      if (file && !seen.has(`file ${file}`)) { seen.add(`file ${file}`); add(files, file, ms) }
      // A component's render body: an app function named like a component.
      if (file && /^[A-Z]/.test(frame.name) && !seen.has(`component ${frame.name}`)) { seen.add(`component ${frame.name}`); add(componentBodies, frame.key, ms) }
    }
  }
  const sorted = (map) => [...map].sort((left, right) => right[1] - left[1])
  return { seconds: (profile.endTime - profile.startTime) / 1e6, busyMs, programMs, gcMs, self: sorted(self), inclusive: sorted(inclusive), files: sorted(files), componentBodies: sorted(componentBodies), nodes, parents, frameOf }
}

const callerChains = (profile, cpu, pattern, depth) => {
  const chains = new Map()
  for (let index = 0; index < profile.samples.length; index += 1) {
    const ms = (profile.timeDeltas[index + 1] ?? 0) / 1000
    let hit = null
    for (let id = profile.samples[index]; id !== undefined; id = cpu.parents.get(id)) if (pattern.test(cpu.frameOf(id).key)) hit = id
    if (hit === null) continue
    const chain = [cpu.frameOf(hit).key]
    for (let id = cpu.parents.get(hit), step = 0; id !== undefined && step < depth; id = cpu.parents.get(id), step += 1) chain.push(cpu.frameOf(id).key)
    const key = chain.join("  <-  ")
    chains.set(key, (chains.get(key) ?? 0) + ms)
  }
  return [...chains].sort((left, right) => right[1] - left[1])
}

const printRows = (title, rows, top, seconds) => {
  console.log(`\n${title}`)
  for (const [key, ms] of rows.slice(0, top)) console.log(`${fixed(ms).padStart(9)} ms ${seconds ? `${fixed(ms / seconds).padStart(7)} ms/s` : ""}  ${key}`)
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const { directory, top } = options
  const mapper = createSourceMapper(options.dist)
  // Mapped to source when the build has maps, else shortened to the chunk name.
  const mapFrame = (frame) => {
    const mapped = mapper.mapFrame(frame)
    return mapped === String(frame) ? shortUrl(frame) : mapped
  }
  const summary = readSummary(directory)
  console.log(`Run: ${directory}${summary ? ` (${summary.kind})` : ""}`)
  if (options.dist && !existsSync(join(options.dist, "assets"))) console.warn(`WARNING: ${options.dist} has no assets directory; positions stay unmapped.`)

  const profilePath = join(directory, "cpu-profile.cpuprofile")
  if (existsSync(profilePath)) {
    const profile = JSON.parse(readFileSync(profilePath, "utf8"))
    const cpu = cpuAttribution(profile, mapper)
    console.log(`\nCPU profile: ${fixed(cpu.seconds)} s, ${fixed(cpu.busyMs)} ms in JavaScript and GC (${fixed(cpu.gcMs)} ms GC), ${fixed(cpu.programMs)} ms (program), which is native work the trace names`)
    printRows("Self time by function:", cpu.self, top, cpu.seconds)
    printRows("Inclusive time by function:", cpu.inclusive, top, cpu.seconds)
    if (cpu.files.length) printRows("Inclusive time by app source file:", cpu.files, top, cpu.seconds)
    if (cpu.componentBodies.length) printRows("Component render bodies, inclusive (hooks and children rendered inline):", cpu.componentBodies, top, cpu.seconds)
    if (!mapper.available) console.log("\n(Pass --dist with the diagnostic build to group by source file and component.)")
    if (options.callers) printRows(`Callers of ${options.callers}:`, callerChains(profile, cpu, options.callers, options.depth), 15, null)
  } else console.log("\nNo cpu-profile.cpuprofile; CPU sections skipped.")

  const sites = summary?.data.scheduledWork?.sites ?? []
  if (sites.length) {
    const seconds = summary.data.metrics?.recordedSeconds ?? summary.data.durationSeconds ?? null
    console.log("\nScheduled work by call site (total ms, calls):")
    for (const entry of sites.slice(0, top)) {
      // Sites read "<kind> <function> @ <url:line:col>".
      const [kind, ...rest] = entry.site.split(" ")
      const [name, location = ""] = rest.join(" ").split(" @ ")
      const frame = `${name.includes("://") ? "(anonymous)" : name} (${location})`
      console.log(`${fixed(entry.totalMs).padStart(9)} ms ${String(entry.calls).padStart(7)}x${seconds ? ` ${fixed(entry.calls / seconds).padStart(6)}/s` : ""}  ${kind} ${mapFrame(frame)}`)
    }
  }

  const events = loadTrace(directory)
  if (events) {
    const window = traceWindow(events)
    const pipeline = pipelineMetrics(events, window)
    console.log(`\nRendering pipeline per second over ${pipeline.windowSeconds} s (${window.marked ? "stream window" : "whole trace"}):`)
    for (const [key, value] of Object.entries(pipeline)) if (Number.isFinite(value) && key !== "windowSeconds") console.log(`  ${key.padEnd(28)} ${value}`)
    if (!pipeline.mainThreadFound) console.log("  WARNING: no CrRendererMain thread in the window; main-thread figures are missing, not zero.")
    const tasks = classifyTasks(events, { minMs: options.tasksOver, window })
    console.log(`\nMain-thread tasks over ${options.tasksOver} ms: ${tasks.tasks}, grouped by trigger and outermost call (avg ms: total / script / style / layout / paint):`)
    for (const group of tasks.groups.slice(0, top)) {
      const avg = (value) => fixed(value / group.count).padStart(6)
      console.log(`  ${String(group.count).padStart(4)}x ${avg(group.totalMs)} ${avg(group.scriptMs)} ${avg(group.styleMs)} ${avg(group.layoutMs)} ${avg(group.paintMs)}  ${group.trigger} ${mapFrame(group.frame)}  at ${group.atSeconds.slice(0, 6).join(", ")}${group.atSeconds.length > 6 ? ", …" : ""} s`)
    }
    const recalcs = largeRecalcs(events, { minElements: options.recalcsOver, window })
    console.log(`\nStyle recalcs touching ≥${recalcs.minElements} elements: ${recalcs.count}, ${recalcs.ms} of ${recalcs.totalMs} ms recalc time, ${recalcs.elementShare}% of restyled elements`)
    for (const entry of recalcs.recalcs.slice(0, top)) console.log(`  at ${String(entry.atMs).padStart(7)} ms  ${String(entry.elements).padStart(7)} elements  ${entry.ms} ms`)
  } else console.log("\nNo trace.json; trace sections skipped (profile:session writes it with --save-trace).")

  const probePath = join(directory, "render-probe.json")
  if (existsSync(probePath)) {
    // A switch run's probe covers the switches after its last page load.
    const switches = summary?.data.renderProbe?.switches
    printRenderProbe(summarizeRenderProbe(JSON.parse(readFileSync(probePath, "utf8"))), {
      top,
      perUnit: switches ? { label: "switch", count: switches } : null,
      mapFrame,
    })
  }
}

try {
  main()
} catch (error) {
  console.error(`Analysis failed: ${error.message}`)
  process.exitCode = 1
}
