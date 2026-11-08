#!/usr/bin/env node
/**
 * Reads a `profile:soak` run directory and writes `summary.md` and
 * `timeline.jsonl` (one line per second).
 *
 * Every source is bucketed by wall-clock second: CPU per process role,
 * requests the window sent, realtime frames it received, requests on loopback
 * (server to OpenCode), processes the app spawned, connections to the outside.
 * From those buckets it reports totals per hour, the seconds where CPU spiked
 * with what happened around them, and for each kind of event the CPU the app
 * spent in the seconds after it, above its quiet floor. That last figure is
 * an association, not proof: events that always arrive together share it.
 *
 *   node scripts/perf/soak-analyze.mjs <run dir>
 */

import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

import { summarizeCpuProfile } from "./cpu-profile.mjs"
import { endpointPattern } from "./network.mjs"
import { percentile, round } from "./metrics.mjs"

const readLines = async (path) => {
  if (!existsSync(path)) return []
  const text = await readFile(path, "utf8")
  const rows = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* a line cut by a stop */ }
  }
  return rows
}

const mb = (bytes) => round(bytes / 1024 / 1024, 1)
const kb = (bytes) => round(bytes / 1024, 1)
const mean = (values) => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length)
const median = (values) => percentile(values, 0.5)

/** Least-squares slope of `[x, y]` points, per unit of x. */
const slope = (points) => {
  if (points.length < 2) return 0
  const meanX = mean(points.map(([x]) => x))
  const meanY = mean(points.map(([, y]) => y))
  let covariance = 0
  let variance = 0
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY)
    variance += (x - meanX) ** 2
  }
  return variance === 0 ? 0 : covariance / variance
}

const table = (columns, rows) => {
  if (rows.length === 0) return "_none_\n"
  const escape = (value) => String(value ?? "").replace(/\|/g, "\\|")
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n") + "\n"
}

/** Short stable name for a spawned command: `git status`, `rg`, `node mcp-x`. */
export const commandGroup = (command) => {
  const parts = command.trim().split(/\s+/)
  const executable = parts[0]?.split("/").pop() ?? "?"
  if (executable === "git") {
    const rest = parts.slice(1)
    const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"])
    const sub = rest.find((part, index) => !part.startsWith("-") && !takesValue.has(rest[index - 1]))
    const snapshot = rest.some((part) => part.includes("/opencode/snapshot/"))
    return `git ${sub ?? "?"}${snapshot ? " (OpenCode snapshot)" : ""}`
  }
  if (["node", "bun", "python", "python3", "sh", "bash", "zsh", "npx", "uvx", "bunx"].includes(executable)) {
    const script = parts.slice(1).find((part) => !part.startsWith("-"))
    return `${executable} ${script ? script.split("/").slice(-2).join("/").slice(0, 60) : ""}`.trim()
  }
  return executable.slice(0, 60)
}

/** Collapses a directory query so one route does not split per project. */
const collapseQuery = (path) => path
  .replace(/([?&](?:directory|location%5Bdirectory%5D|location\[directory\]|cursor|path|file)=)[^&\s]*/g, "$1X")
  .replace(/([?&]_=)\d+/g, "$1X")

/** The project a request is about, from its `directory` query or header-less location query. */
const directoryOf = (url) => {
  const match = /[?&](?:directory|location%5Bdirectory%5D|location\[directory\])=([^&\s]*)/.exec(url)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return match[1] }
}

const loopbackPattern = (path) => {
  const [pathname, query = ""] = path.split("?")
  const route = endpointPattern(`http://x${pathname}`, "http://x")
  return query ? `${route}?${collapseQuery(`?${query}`).slice(1)}` : route
}

/** Request lines tcpdump printed in `-A` mode, with the port they went to. */
export const parseLoopback = (text, ports) => {
  const requests = []
  let header = null
  for (const line of text.split("\n")) {
    const head = /^(\d+\.\d+) IP6? [\d.:a-f]+\.(\d+) > [\d.:a-f]+\.(\d+):/.exec(line)
    if (head) {
      header = { t: Math.round(Number(head[1]) * 1000), to: Number(head[3]) === ports.opencodePort ? "opencode" : "server" }
      continue
    }
    if (!header) continue
    const request = /(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*) HTTP\/1\.[01]/.exec(line)
    if (request) requests.push({ t: header.t, to: header.to, method: request[1], path: request[2] })
    const agent = /user-agent: ?([^\r]*)/i.exec(line)
    if (agent && requests.length > 0 && requests.at(-1).t === header.t && !requests.at(-1).agent) {
      requests.at(-1).agent = /Electron|Chrome/.test(agent[1]) ? "renderer" : agent[1].trim().split("/")[0].slice(0, 20)
    }
  }
  return requests
}

/** Connection openings and DNS answers from the pktap capture. */
export const parseExternal = (text) => {
  const names = new Map()
  // A response line carries the query id but not the question; the query
  // line carries both.
  const questions = new Map()
  const connections = []
  for (const line of text.split("\n")) {
    const time = /^(\d+\.\d+)/.exec(line)
    if (!time) continue
    const query = /: (\d+)\+? (?:\[[^\]]*\] )?(?:A|AAAA|HTTPS)\? ([^ ]+?)\.? \(/.exec(line)
    if (query) questions.set(query[1], query[2])
    const response = /\.53 > [^:]+: (\d+)[*|$-]* \d+\/\d+\/\d+ (.*)$/.exec(line)
    if (response && questions.has(response[1])) {
      for (const answer of response[2].matchAll(/(?:^|, )(?:A|AAAA) ([0-9a-f.:]+)/g)) names.set(answer[1], questions.get(response[1]))
    }
    const syn = /proc ([^:,)]+):(\d+).*?IP6? ([\d.:a-f]+)\.\d+ > ([\d.:a-f]+)\.(\d+): Flags \[S[EW]*\]/.exec(line)
    if (syn) connections.push({ t: Math.round(Number(time[1]) * 1000), process: syn[1], pid: Number(syn[2]), ip: syn[4], port: Number(syn[5]) })
  }
  return connections.map((entry) => ({ ...entry, host: names.get(entry.ip) ?? entry.ip }))
}

/** Exec events from eslogger whose parent belongs to the app's tree. */
const parseExec = async (path, treePids, excludedPids) => {
  const events = await readLines(path)
  const spawned = []
  for (const event of events) {
    const exec = event.event?.exec
    if (!exec) continue
    const parent = event.process?.ppid ?? event.process?.original_ppid
    const pid = event.process?.audit_token?.pid
    if (excludedPids.has(parent) || excludedPids.has(pid)) {
      if (pid) excludedPids.add(pid)
      continue
    }
    if (!treePids.has(parent) && !treePids.has(pid)) continue
    if (pid) treePids.add(pid)
    const args = exec.args ?? []
    spawned.push({ t: Date.parse(event.time) || null, pid, ppid: parent, command: args.join(" ").slice(0, 400), cwd: exec.cwd?.path ?? null })
  }
  return spawned
}

/**
 * Time each script file was on the stack. Self time lands in Node and V8
 * internals (timers, streams, JSON); the application file that called them is
 * what an inclusive figure names.
 */
const inclusiveByFile = (profile, busyMs) => {
  const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of nodes.values()) for (const child of node.children ?? []) parent.set(child, node.id)
  const fileOf = (node) => {
    const url = node.callFrame?.url ?? ""
    if (!url) return null
    const short = url.replace(/^.*\/app\.asar\//, "asar/").replace(/^file:\/\//, "").replace(/^.*\/node_modules\//, "node_modules/")
    return short.length > 90 ? `…${short.slice(-89)}` : short
  }
  const totals = new Map()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let index = 0; index < samples.length; index += 1) {
    let node = nodes.get(samples[index])
    if (!node || node.callFrame?.functionName === "(idle)") continue
    const delta = Math.max(0, Number(deltas[index] ?? 0)) / 1000
    const seen = new Set()
    while (node) {
      const file = fileOf(node)
      if (file && !seen.has(file)) {
        seen.add(file)
        totals.set(file, (totals.get(file) ?? 0) + delta)
      }
      node = nodes.get(parent.get(node.id))
    }
  }
  return [...totals.entries()].sort((left, right) => right[1] - left[1]).map(([file, ms]) => [file, round(ms, 1), busyMs > 0 ? round((ms / busyMs) * 100, 1) : 0])
}

const roleOrder = ["main", "renderer", "gpu", "network", "utility", "opencode", "git", "child"]

export const analyzeSoak = async (runDir) => {
  const dir = resolve(runDir)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
  const files = await readdir(dir)
  const cpu = await readLines(join(dir, "cpu.jsonl"))
  const processes = await readLines(join(dir, "processes.jsonl"))
  const footprints = await readLines(join(dir, "footprint.jsonl"))
  const netLoopback = await readLines(join(dir, "net-loopback.jsonl"))
  const netExternal = await readLines(join(dir, "net-external.jsonl"))
  const capture = existsSync(join(dir, "capture.json")) ? JSON.parse(await readFile(join(dir, "capture.json"), "utf8")) : null
  const pageLabels = files.filter((name) => /^requests-page\d+\.jsonl$/.test(name)).map((name) => name.slice("requests-".length, -".jsonl".length))

  const start = meta.startedAt
  const end = meta.endedAt ?? cpu.at(-1)?.t ?? start
  const seconds = Math.max(1, Math.round((end - start) / 1000))
  const hours = seconds / 3600
  const perHour = (count) => round(count / hours, 0)
  const secondOf = (t) => Math.floor((t - start) / 1000)
  const inWindow = (t) => t >= start && t <= end

  const roleOf = new Map()
  const commandOf = new Map()
  for (const entry of processes) {
    roleOf.set(entry.pid, entry.role)
    commandOf.set(entry.pid, entry.command)
  }

  // Per-second CPU by role, in percent of one core.
  const buckets = Array.from({ length: seconds }, () => ({ cpu: {}, events: [] }))
  const cpuByPid = new Map()
  // A sample holds the CPU used over the `dt` ms before it; a late sample
  // spreads its share over every second it covers instead of spiking one.
  for (const sample of cpu) {
    const from = sample.t - (sample.dt ?? 0)
    const span = Math.max(1, sample.t - from)
    for (const [pid, used] of Object.entries(sample.cpu)) {
      const role = roleOf.get(Number(pid)) ?? "child"
      if (inWindow(sample.t)) cpuByPid.set(Number(pid), (cpuByPid.get(Number(pid)) ?? 0) + used)
      for (let second = secondOf(from); second <= secondOf(sample.t - 1); second += 1) {
        if (second < 0 || second >= seconds) continue
        const overlap = Math.min(sample.t, start + (second + 1) * 1000) - Math.max(from, start + second * 1000)
        if (overlap <= 0) continue
        buckets[second].cpu[role] = (buckets[second].cpu[role] ?? 0) + used * 100 * (overlap / span)
      }
    }
  }
  const totalOf = (bucket) => Object.values(bucket.cpu).reduce((total, value) => total + value, 0)
  const totals = buckets.map(totalOf)
  const sampledSeconds = new Set(cpu.map((sample) => secondOf(sample.t))).size

  let report = `# Idle soak: ${meta.label ?? dir.split("/").pop()}\n\n`
  report += `${round(seconds / 60, 1)} min recorded from ${new Date(start).toISOString()}, app pid ${meta.appPid}`
  report += meta.cdpPort ? `, ${meta.pages.length} window(s) over CDP${meta.cpuProfile ? " with a CPU profile (adds load)" : ""}` : ", no CDP"
  report += capture ? ", privileged capture present" : ", no privileged capture"
  const sourceErrors = []
  for (const name of files.filter((file) => file.startsWith("errors-"))) {
    const count = (await readLines(join(dir, name))).length
    if (count > 0) sourceErrors.push(`${name.slice("errors-".length, -".jsonl".length)} failed ${count} times`)
  }
  report += `.\n\nValidity: ${sampledSeconds} of ${seconds} seconds have a CPU sample${sourceErrors.length ? `; ${sourceErrors.join(", ")}` : ""}${meta.failure ? `; the run stopped early: ${meta.failure}` : ""}.`
  if (meta.excludePids?.length) report += ` Excluded process trees: ${meta.excludePids.join(", ")}.`
  report += "\n\n"

  // CPU per role.
  report += "## CPU by process role (% of one core)\n\n"
  report += "Short-lived children (git, other) are a lower bound: CPU a process uses after its last 250 ms sample is not seen.\n\n"
  const roleRows = []
  for (const role of roleOrder) {
    const series = buckets.map((bucket) => bucket.cpu[role] ?? 0)
    const seconds_ = series.reduce((total, value) => total + value, 0) / 100
    if (seconds_ === 0) continue
    const pids = [...cpuByPid.keys()].filter((pid) => roleOf.get(pid) === role)
    roleRows.push([role, round(mean(series), 2), percentile(series, 0.5), percentile(series, 0.95), round(Math.max(...series), 1), round(seconds_, 1), round(seconds_ / hours / 60, 2), pids.length])
  }
  roleRows.push(["**all**", round(mean(totals), 2), percentile(totals, 0.5), percentile(totals, 0.95), round(Math.max(...totals), 1), round(totals.reduce((a, b) => a + b, 0) / 100, 1), round(totals.reduce((a, b) => a + b, 0) / 100 / hours / 60, 2), cpuByPid.size])
  report += table(["role", "mean", "p50", "p95", "max", "CPU s", "CPU min/hour", "processes"], roleRows)

  const heavyPids = [...cpuByPid.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)
  report += "\nHeaviest processes:\n\n"
  report += table(["pid", "role", "CPU s", "mean %", "command"], heavyPids.map(([pid, used]) => [pid, roleOf.get(pid) ?? "?", round(used, 1), round((used / seconds) * 100, 2), (commandOf.get(pid) ?? "").slice(0, 110)]))

  // Spawned processes.
  const treePids = new Set(processes.map((entry) => entry.pid))
  const execEvents = await parseExec(join(dir, "exec.jsonl"), treePids, new Set(meta.excludePids ?? []))
  const execAvailable = execEvents.length > 0
  const spawnSource = execAvailable
    ? execEvents.filter((entry) => entry.t === null || inWindow(entry.t))
    : processes.filter((entry) => inWindow(entry.t) && entry.t > start + 1500)
  const spawnGroups = new Map()
  for (const entry of spawnSource) {
    const group = commandGroup(entry.command)
    const record = spawnGroups.get(group) ?? { count: 0, cpu: 0, cwds: new Map(), example: entry.command }
    record.count += 1
    record.cpu += execAvailable ? 0 : (cpuByPid.get(entry.pid) ?? 0)
    if (entry.cwd) record.cwds.set(entry.cwd, (record.cwds.get(entry.cwd) ?? 0) + 1)
    spawnGroups.set(group, record)
    if (entry.t) buckets[secondOf(entry.t)]?.events.push(`spawn ${group}`)
  }
  report += `\n## Processes the app started (${execAvailable ? "eslogger, complete" : "ps every 250 ms, misses short ones"})\n\n`
  report += table(["command", "count", "per hour", execAvailable ? "folders" : "CPU s", "example"], [...spawnGroups.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 30)
    .map(([group, record]) => [group, record.count, perHour(record.count), execAvailable ? record.cwds.size : round(record.cpu, 2), record.example.slice(0, 90)]))

  // Memory.
  report += "\n## Memory (physical footprint)\n\n"
  const memoryRows = []
  const byPid = new Map()
  for (const sample of footprints) {
    for (const entry of sample.processes) {
      const list = byPid.get(entry.pid) ?? []
      list.push({ t: sample.t, footprint: entry.footprint, top: entry.top, name: entry.name })
      byPid.set(entry.pid, list)
    }
  }
  for (const [pid, list] of byPid) {
    const first = list[0]
    const last = list.at(-1)
    const perHourGrowth = slope(list.map((entry) => [(entry.t - start) / 3_600_000, entry.footprint]))
    const top = last.top.slice(0, 3).map((category) => `${category.name.replace("App-Specific ", "")} ${mb(category.dirty)}`).join(", ")
    memoryRows.push([pid, roleOf.get(pid) ?? last.name, mb(first.footprint), mb(last.footprint), mb(Math.max(...list.map((entry) => entry.footprint))), round(perHourGrowth / 1024 / 1024, 1), top])
  }
  memoryRows.sort((left, right) => right[3] - left[3])
  report += table(["pid", "role", "start MB", "end MB", "max MB", "trend MB/hour", "largest categories at end"], memoryRows)
  report += "\nIn a renderer, Tag 16 is V8 (JS heap) and Tag 14 PartitionAlloc (DOM, strings).\n"

  // Bytes per process.
  // Each block holds the bytes moved during one `nettop` call (`dt` ms).
  const netRows = (blocks, kind) => {
    const inside = blocks.filter((block) => inWindow(block.t))
    const minutes = inside.reduce((total, block) => total + (block.dt ?? 0), 0) / 60_000
    if (minutes === 0) return []
    const sums = new Map()
    for (const block of inside) {
      for (const [pid, [bytesIn, bytesOut]] of Object.entries(block.bytes)) {
        if (!treePids.has(Number(pid))) continue
        const sum = sums.get(pid) ?? [0, 0]
        sums.set(pid, [sum[0] + bytesIn, sum[1] + bytesOut])
      }
    }
    return [...sums.entries()].map(([pid, [bytesIn, bytesOut]]) => [kind, pid, roleOf.get(Number(pid)) ?? "?", kb(bytesIn / minutes), kb(bytesOut / minutes), round((bytesIn + bytesOut) / 1024 / 1024 / minutes * 60, 1)])
  }
  report += "\n## Bytes per process (nettop)\n\n"
  report += table(["kind", "pid", "role", "in KB/min", "out KB/min", "MB/hour total"], [...netRows(netLoopback, "loopback"), ...netRows(netExternal, "external")])
  report += "\nLoopback counts each byte on both ends: the server's out is OpenCode's in.\n"

  // Renderer requests and realtime frames.
  const requests = []
  const frames = []
  const rendererMetrics = []
  for (const label of pageLabels) {
    for (const entry of await readLines(join(dir, `requests-${label}.jsonl`))) if (inWindow(entry.t)) requests.push({ ...entry, page: label })
    for (const entry of await readLines(join(dir, `ws-${label}.jsonl`))) if (inWindow(entry.t)) frames.push({ ...entry, page: label })
    rendererMetrics.push({ label, rows: await readLines(join(dir, `renderer-${label}.jsonl`)) })
  }
  if (meta.cdpPort) {
    const groups = new Map()
    for (const entry of requests) {
      const route = `${entry.method} ${endpointPattern(entry.url, entry.url)}`
      const group = groups.get(route) ?? { count: 0, encoded: 0, decoded: 0, times: [], failed: 0, initiators: new Map(), ms: [], directories: new Set() }
      const directory = directoryOf(entry.url)
      if (directory) group.directories.add(directory)
      group.count += 1
      group.encoded += entry.encoded ?? 0
      group.decoded += entry.decoded ?? 0
      group.times.push(entry.t)
      if (entry.failed) group.failed += 1
      if (entry.ms !== undefined) group.ms.push(entry.ms)
      const initiator = entry.initiator?.frames?.[0] ?? entry.initiator?.type ?? "?"
      group.initiators.set(initiator, (group.initiators.get(initiator) ?? 0) + 1)
      groups.set(route, group)
      buckets[secondOf(entry.t)]?.events.push(`req ${route}`)
    }
    report += `\n## Requests the window sent (${requests.length}, ${perHour(requests.length)}/hour)\n\n`
    report += table(["route", "count", "per hour", "median gap s", "folders", "KB wire", "KB decoded", "median ms", "failed", "sent by"], [...groups.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .map(([route, group]) => {
        const sorted = [...group.times].sort((left, right) => left - right)
        const gaps = sorted.slice(1).map((time, index) => (time - sorted[index]) / 1000)
        const initiator = [...group.initiators.entries()].sort((left, right) => right[1] - left[1])[0][0]
        return [route.slice(0, 90), group.count, perHour(group.count), gaps.length ? median(gaps) : "", group.directories.size || "", kb(group.encoded), kb(group.decoded), group.ms.length ? median(group.ms) : "", group.failed, initiator.slice(0, 70)]
      }))

    const kinds = new Map()
    for (const frame of frames) {
      if (frame.event) continue
      const key = `${frame.dir} ${frame.kind}`
      const record = kinds.get(key) ?? { count: 0, bytes: 0 }
      record.count += 1
      record.bytes += frame.bytes
      kinds.set(key, record)
      if (frame.dir === "in" || frame.dir === "sse") buckets[secondOf(frame.t)]?.events.push(`ws ${frame.kind}`)
    }
    const socketEvents = frames.filter((frame) => frame.event)
    report += `\n## Realtime frames (${frames.length - socketEvents.length}, ${socketEvents.length} socket opens/closes)\n\n`
    report += table(["direction and event", "count", "per hour", "KB"], [...kinds.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, 40)
      .map(([key, record]) => [key.slice(0, 90), record.count, perHour(record.count), kb(record.bytes)]))
    if (socketEvents.length) report += `\nSocket opens and closes: ${socketEvents.map((entry) => `${new Date(entry.t).toISOString().slice(11, 19)} ${entry.event} ${String(entry.url).split("?")[0].slice(-50)}`).join("; ")}\n`

    report += "\n## Window main thread\n\n"
    const rows = []
    for (const { label, rows: series } of rendererMetrics) {
      const inside = series.filter((entry) => inWindow(entry.t) && entry.task !== undefined)
      if (inside.length < 2) continue
      const first = inside[0]
      const last = inside.at(-1)
      const span = (last.t - first.t) / 1000
      rows.push([
        label,
        round(((last.task - first.task) / span) * 100, 2),
        round(((last.script - first.script) / span) * 100, 2),
        round(((last.styleCount - first.styleCount) / span) * 60, 1),
        round(((last.layoutCount - first.layoutCount) / span) * 60, 1),
        `${mb(first.heapUsed)} → ${mb(last.heapUsed)}`,
        round(slope(inside.map((entry) => [(entry.t - start) / 3_600_000, entry.heapUsed])) / 1024 / 1024, 1),
        `${first.nodes} → ${last.nodes}`,
        `${first.listeners} → ${last.listeners}`,
      ])
      // Main-thread task time per second, for the timeline.
      for (let index = 1; index < inside.length; index += 1) {
        const bucket = buckets[secondOf(inside[index].t)]
        if (bucket) bucket.mainThreadMs = (bucket.mainThreadMs ?? 0) + round((inside[index].task - inside[index - 1].task) * 1000, 1)
      }
    }
    report += table(["window", "busy %", "script %", "style recalcs/min", "layouts/min", "JS heap MB", "heap trend MB/hour", "DOM nodes", "listeners"], rows)

    for (const label of pageLabels) {
      const path = join(dir, `mutations-${label}.json`)
      if (!existsSync(path)) continue
      const mutations = JSON.parse(await readFile(path, "utf8"))
      const minutes = Math.max(1 / 60, (mutations.endedAt - mutations.startedAt) / 60_000)
      report += `\n### DOM mutations in ${label} (per minute, top 25)\n\n`
      report += table(["per minute", "mutation and where"], mutations.top.slice(0, 25).map(([key, count]) => [round(count / minutes, 1), key.slice(0, 160)]))
    }

  }
  {
    for (const name of files.filter((file) => file.endsWith(".cpuprofile"))) {
      const profile = JSON.parse(await readFile(join(dir, name), "utf8"))
      const summary = summarizeCpuProfile(profile, 25)
      report += `\n### CPU profile ${name}: busy ${summary.busyPercent}%, GC ${summary.garbageCollectorMs} ms\n\n`
      report += table(["function", "self ms", "% of busy"], summary.topSelfTime.map((entry) => [entry.function.slice(0, 100), entry.selfMs, entry.percentOfBusy]))
      report += `\nInclusive time by source file (time a file's code was on the stack, excluding idle):\n\n`
      report += table(["file", "ms", "% of busy"], inclusiveByFile(profile, summary.busyMs).slice(0, 25))
    }
  }

  // Privileged capture: loopback requests and outside connections.
  if (capture) {
    const loopbackText = existsSync(join(dir, "lo0.txt")) ? await readFile(join(dir, "lo0.txt"), "utf8") : ""
    const loopback = parseLoopback(loopbackText, capture).filter((entry) => inWindow(entry.t))
    const groups = new Map()
    for (const entry of loopback) {
      const key = `${entry.to} ${entry.agent ?? "?"} ${entry.method} ${loopbackPattern(entry.path)}`
      const record = groups.get(key) ?? { count: 0, times: [], directories: new Set() }
      record.count += 1
      const directory = directoryOf(entry.path)
      if (directory) record.directories.add(directory)
      record.times.push(entry.t)
      groups.set(key, record)
      if (entry.to === "opencode") buckets[secondOf(entry.t)]?.events.push(`oc ${entry.method} ${loopbackPattern(entry.path).split("?")[0]}`)
    }
    report += `\n## Loopback requests (${loopback.length}, ${perHour(loopback.length)}/hour)\n\n`
    report += "`to` is the receiving side; `from` is the user agent (`renderer` is the window, `node`/`Bun` the server).\n\n"
    report += table(["to", "from", "request", "count", "per hour", "median gap s", "folders"], [...groups.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, 50)
      .map(([key, record]) => {
        const [to, from, method, ...path] = key.split(" ")
        const sorted = [...record.times].sort((left, right) => left - right)
        const gaps = sorted.slice(1).map((time, index) => (time - sorted[index]) / 1000)
        return [to, from, `${method} ${path.join(" ")}`.slice(0, 110), record.count, perHour(record.count), gaps.length ? median(gaps) : "", record.directories.size || ""]
      }))

    const externalText = existsSync(join(dir, "external.txt")) ? await readFile(join(dir, "external.txt"), "utf8") : ""
    const connections = parseExternal(externalText).filter((entry) => inWindow(entry.t) && (treePids.has(entry.pid) || /OpenChamber|opencode|git/.test(entry.process)))
    const hosts = new Map()
    for (const entry of connections) {
      const key = `${entry.process} ${entry.host}:${entry.port}`
      hosts.set(key, (hosts.get(key) ?? 0) + 1)
      buckets[secondOf(entry.t)]?.events.push(`conn ${entry.host}`)
    }
    report += `\n## Connections to the outside (${connections.length})\n\n`
    report += table(["process and host", "count", "per hour"], [...hosts.entries()].sort((left, right) => right[1] - left[1]).map(([key, count]) => [key, count, perHour(count)]))
  }

  // Spikes and the events around them.
  const floor = median(totals)
  const threshold = Math.max(percentile(totals, 0.97), floor + 10)
  const spikes = totals
    .map((value, second) => ({ second, value }))
    .filter((entry) => entry.value >= threshold)
    .sort((left, right) => right.value - left.value)
    .slice(0, 25)
  report += `\n## CPU spikes (seconds at or above ${round(threshold, 1)}% across the tree; median second ${round(floor, 1)}%)\n\n`
  report += table(["at", "total %", "by role", "events in the 3 s before and the second itself"], spikes.map(({ second, value }) => {
    const roles = Object.entries(buckets[second].cpu).sort((left, right) => right[1] - left[1]).slice(0, 3).map(([role, used]) => `${role} ${round(used, 0)}`).join(", ")
    const events = new Map()
    for (let offset = -3; offset <= 0; offset += 1) for (const event of buckets[second + offset]?.events ?? []) events.set(event, (events.get(event) ?? 0) + 1)
    const list = [...events.entries()].map(([event, count]) => (count > 1 ? `${event} ×${count}` : event)).join("; ")
    return [`+${second}s ${new Date(start + second * 1000).toISOString().slice(11, 19)}`, round(value, 1), roles, list.slice(0, 300) || "—"]
  }))

  // CPU in the seconds after each kind of event, above the floor.
  const eventKinds = new Map()
  buckets.forEach((bucket, second) => {
    for (const event of new Set(bucket.events)) {
      const list = eventKinds.get(event) ?? []
      list.push(second)
      eventKinds.set(event, list)
    }
  })
  const associations = [...eventKinds.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([event, list]) => {
      const excess = list.map((second) => [0, 1, 2].reduce((total, offset) => total + Math.max(0, (totals[second + offset] ?? floor) - floor), 0))
      return [event.slice(0, 90), list.length, perHour(list.length), round(mean(excess), 1), round((mean(excess) * list.length) / 100 / hours / 60, 3)]
    })
    .sort((left, right) => right[4] - left[4])
    .slice(0, 30)
  report += "\n## CPU after each kind of event\n\n"
  report += "CPU above the median second, summed over the event's second and the two after it (percent-seconds of one core). Events that arrive together share the figure.\n\n"
  report += table(["event", "seconds with it", "per hour", "excess per occurrence", "CPU min/hour attributed"], associations)

  const timeline = buckets.map((bucket, second) => JSON.stringify({ s: second, t: start + second * 1000, total: round(totals[second], 1), cpu: Object.fromEntries(Object.entries(bucket.cpu).map(([role, used]) => [role, round(used, 1)])), mainThreadMs: bucket.mainThreadMs, events: bucket.events }))
  await writeFile(join(dir, "timeline.jsonl"), `${timeline.join("\n")}\n`)
  await writeFile(join(dir, "summary.md"), report)
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const runDir = process.argv[2]
  if (!runDir) {
    console.error("Usage: node scripts/perf/soak-analyze.mjs <run dir>")
    process.exit(1)
  }
  console.log(await analyzeSoak(runDir))
}
