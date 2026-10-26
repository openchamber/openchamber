/**
 * Per-process CPU accounting for a capture.
 *
 * `Performance.getMetrics` and the timeline trace describe one thread: the
 * renderer's main thread. A user reporting "CPU jumps to 30%" is reading a
 * process monitor, which also counts the renderer's raster, compositor and
 * garbage-collection threads, Chrome's GPU and network processes, the
 * OpenChamber server relaying the event stream, and OpenCode itself. A capture
 * that only reports main-thread busy time can therefore sit at 5% while the
 * number the user sees is several times higher.
 *
 * Chrome's processes are read through the browser-level `SystemInfo` domain,
 * which reports cumulative CPU seconds per process. Server-side processes are
 * read from `ps`. Both are cumulative counters, so sampling them costs nothing
 * inside the measured processes and a delta between two samples is exact.
 *
 * Percentages are of one core, matching Activity Monitor and `top`.
 */

import { execFile } from "node:child_process"
import { platform } from "node:os"

import { CdpClient } from "./cdp.mjs"
import { percentile, round } from "./metrics.mjs"

const run = (command, args) => new Promise((resolveRun) => {
  execFile(command, args, { timeout: 5_000 }, (error, stdout) => resolveRun(error ? "" : String(stdout)))
})

/** Browser-level CDP connection; `SystemInfo` is not exposed on page targets. */
export const openBrowserClient = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`)
  const { webSocketDebuggerUrl } = await response.json()
  if (!webSocketDebuggerUrl) throw new Error("Chrome did not expose a browser-level debugging endpoint")
  const client = new CdpClient(webSocketDebuggerUrl)
  await client.connect()
  return client
}

/** Parses the `ps` cumulative time format `[[dd-]hh:]mm:ss[.cc]` into seconds. */
const parsePsTime = (text) => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return null
  const [, days = "0", hours = "0", minutes, seconds] = match
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/**
 * Resolves the OpenChamber server listening on `port` and the processes it
 * spawned (the managed OpenCode instance). Returns an empty list where the
 * platform has no `lsof`/`pgrep`, which the report states explicitly instead
 * of showing a zero.
 */
export const resolveServerProcesses = async (port) => {
  if (platform() === "win32") return []
  const listening = (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]))
    .split("\n").map((line) => line.trim()).filter(Boolean)
  const serverPid = listening[0]
  if (!serverPid) return []
  const children = (await run("pgrep", ["-P", serverPid])).split("\n").map((line) => line.trim()).filter(Boolean)
  const processes = [{ pid: Number(serverPid), label: "openchamber server" }]
  for (const pid of children) {
    const command = (await run("ps", ["-o", "comm=", "-p", pid])).trim()
    if (!command) continue
    processes.push({ pid: Number(pid), label: `server child: ${command.split("/").at(-1)}` })
  }
  return processes
}

const readServerCpuSeconds = async (processes) => {
  const result = new Map()
  if (processes.length === 0) return result
  const output = await run("ps", ["-o", "pid=,time=", "-p", processes.map((entry) => entry.pid).join(",")])
  for (const line of output.split("\n")) {
    const [pid, time] = line.trim().split(/\s+/)
    const seconds = time ? parsePsTime(time) : null
    if (pid && seconds !== null) result.set(Number(pid), seconds)
  }
  return result
}

/**
 * Samples cumulative CPU seconds for every Chrome process and the given
 * server-side processes. Call `sample()` on a fixed cadence and `summarize()`
 * once at the end.
 */
export const createProcessCpuSampler = ({ browserClient, serverProcesses }) => {
  const samples = []
  const labels = new Map(serverProcesses.map((entry) => [`server:${entry.pid}`, entry.label]))

  const sample = async () => {
    const at = Date.now()
    const [chrome, server] = await Promise.all([
      browserClient.send("SystemInfo.getProcessInfo").catch(() => ({ processInfo: [] })),
      readServerCpuSeconds(serverProcesses),
    ])
    const cpuSeconds = new Map()
    for (const info of chrome.processInfo ?? []) {
      const key = `chrome:${info.id}`
      labels.set(key, `chrome ${info.type}`)
      cpuSeconds.set(key, Number(info.cpuTime ?? 0))
    }
    for (const [pid, seconds] of server) cpuSeconds.set(`server:${pid}`, seconds)
    samples.push({ at, cpuSeconds })
  }

  const summarize = () => {
    const first = samples.at(0)
    const last = samples.at(-1)
    if (!first || !last || last.at <= first.at) return { processes: [], totalAveragePercent: null, sampleCount: samples.length }
    const windowSeconds = (last.at - first.at) / 1000

    const processes = []
    for (const [key, label] of labels) {
      // A process that started or exited mid-capture has no exact delta.
      if (!first.cpuSeconds.has(key) || !last.cpuSeconds.has(key)) continue
      const perInterval = []
      for (let index = 1; index < samples.length; index += 1) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous.cpuSeconds.has(key) || !current.cpuSeconds.has(key)) continue
        const seconds = (current.at - previous.at) / 1000
        if (seconds <= 0) continue
        perInterval.push(((current.cpuSeconds.get(key) - previous.cpuSeconds.get(key)) / seconds) * 100)
      }
      const cpuSeconds = last.cpuSeconds.get(key) - first.cpuSeconds.get(key)
      processes.push({
        key,
        label,
        cpuSeconds: round(cpuSeconds, 3),
        averagePercent: round((cpuSeconds / windowSeconds) * 100),
        p90Percent: percentile(perInterval, 0.9),
        maxPercent: round(perInterval.reduce((max, value) => Math.max(max, value), 0)),
      })
    }
    processes.sort((left, right) => right.cpuSeconds - left.cpuSeconds)

    // Summed per interval, because the peaks of different processes coincide:
    // this is the single figure a process monitor's "total" column shows.
    const totalPerInterval = []
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]
      const current = samples[index]
      const seconds = (current.at - previous.at) / 1000
      if (seconds <= 0) continue
      let total = 0
      for (const [key, value] of current.cpuSeconds) {
        if (previous.cpuSeconds.has(key)) total += value - previous.cpuSeconds.get(key)
      }
      totalPerInterval.push((total / seconds) * 100)
    }

    return {
      sampleCount: samples.length,
      windowSeconds: round(windowSeconds),
      serverProcessesResolved: serverProcesses.length,
      totalAveragePercent: round(processes.reduce((total, entry) => total + entry.cpuSeconds, 0) / windowSeconds * 100),
      totalP90Percent: percentile(totalPerInterval, 0.9),
      totalMaxPercent: round(totalPerInterval.reduce((max, value) => Math.max(max, value), 0)),
      totalPerInterval: totalPerInterval.map((value) => round(value, 1)),
      processes,
    }
  }

  return { sample, summarize }
}
