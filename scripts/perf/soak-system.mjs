/**
 * Operating-system samplers for `profile:soak`: what the installed desktop app
 * costs as a process monitor sees it, without touching the app.
 *
 * - `ps` every 250 ms: cumulative CPU time per process of the app's tree, so a
 *   delta between two samples is exact CPU, and every process that appears in
 *   the tree (a `git` the server spawned, an MCP server OpenCode started) is
 *   recorded with its command line. A child that lives under 250 ms can be
 *   missed; `soak-capture.sh` adds `eslogger exec` for a complete count.
 * - `footprint` every 30 s: physical footprint per long-lived process, the
 *   figure Activity Monitor shows (`ps` RSS understates it several times).
 * - `nettop` every 5 s: bytes per process, loopback and external apart.
 *
 * Everything is written as JSON lines to the run directory; the analysis reads
 * them back, so a recording that is cut short still leaves usable data.
 */

import { execFile } from "node:child_process"
import { createWriteStream } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"

const run = (command, args, timeout = 20_000) => new Promise((resolveRun) => {
  execFile(command, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolveRun(error ? "" : String(stdout)))
})

const parsePsTime = (text) => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return null
  const [, days = "0", hours = "0", minutes, seconds] = match
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/** One `ps` listing of every process: pid, ppid, cumulative CPU seconds, RSS, command. */
const listProcesses = async () => {
  const output = await run("ps", ["-axo", "pid=,ppid=,time=,rss=,command="], 5_000)
  const rows = []
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const cpuSeconds = parsePsTime(match[3])
    if (cpuSeconds === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuSeconds, rssKb: Number(match[4]), command: match[5] })
  }
  return rows
}

/**
 * Names a process of the app's tree by its role, so the report reads
 * "renderer" and "opencode" instead of helper binaries and pids.
 */
export const classifyProcess = (row, rootPid) => {
  const command = row.command
  if (row.pid === rootPid) return "main"
  if (command.includes("--type=renderer")) return "renderer"
  if (command.includes("--type=gpu-process")) return "gpu"
  if (command.includes("--type=utility")) return command.includes("NetworkService") ? "network" : "utility"
  if (/opencode(-cli)?\/opencode serve|\/opencode serve/.test(command)) return "opencode"
  const executable = command.split(/\s+/)[0].split("/").pop()
  if (executable === "git") return "git"
  return "child"
}

/** Every descendant of `rootPid`, minus the subtrees rooted at `excludePids`. */
const treeOf = (rows, rootPid, excludePids) => {
  const children = new Map()
  for (const row of rows) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const tree = []
  const visit = (pid, depth) => {
    const row = byPid.get(pid)
    if (!row || excludePids.has(pid)) return
    tree.push({ ...row, depth })
    for (const child of children.get(pid) ?? []) visit(child.pid, depth + 1)
  }
  visit(rootPid, 0)
  return tree
}

/**
 * Started from an agent shell inside the app, the recorder and the `ps`,
 * `footprint` and `nettop` it runs sit in the app's tree. Leaves out the
 * subtree of the recorder's topmost ancestor below OpenCode or the app.
 */
const excludeOwnShell = (rows, rootPid, excludePids) => {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  let current = byPid.get(process.pid)
  while (current) {
    const parent = byPid.get(current.ppid)
    if (!parent || parent.pid <= 1) return
    if (parent.pid === rootPid || classifyProcess(parent, rootPid) === "opencode") {
      excludePids.add(current.pid)
      return
    }
    current = parent
  }
}

/**
 * Samples the app's process tree. Each tick writes one line with the CPU
 * seconds each process used since the previous tick; a process seen for the
 * first time is also written to `processes.jsonl` with its command line.
 */
export const startProcessSampler = ({ outputDir, rootPid, excludePids, intervalMs = 250 }) => {
  const samples = createWriteStream(join(outputDir, "cpu.jsonl"))
  const processes = createWriteStream(join(outputDir, "processes.jsonl"))
  const previous = new Map()
  const known = new Set()
  let stopped = false
  let lastTree = []
  let lastAt = null

  const tick = async () => {
    const at = Date.now()
    const rows = await listProcesses()
    // A failed `ps` skips the tick; only a listing without the app ends the run.
    if (rows.length === 0) return true
    if (lastAt === null) excludeOwnShell(rows, rootPid, excludePids)
    const tree = treeOf(rows, rootPid, excludePids)
    if (tree.length === 0) return false
    const deltas = {}
    for (const row of tree) {
      const key = `${row.pid}:${row.command.slice(0, 80)}`
      if (!known.has(key)) {
        known.add(key)
        processes.write(`${JSON.stringify({ t: at, pid: row.pid, ppid: row.ppid, role: classifyProcess(row, rootPid), command: row.command.slice(0, 400), cpuSecondsAtFirstSight: row.cpuSeconds })}\n`)
      }
      // A pid that now runs another command is a new process (pid reuse).
      const before = previous.get(row.pid)
      const same = before !== undefined && before.command === row.command
      // A new process counts from zero: what it used before the first sample
      // was spent inside this interval or the one before.
      const used = !same ? (lastAt === null ? 0 : row.cpuSeconds) : row.cpuSeconds - before.cpuSeconds
      if (used > 0) deltas[row.pid] = Math.round(used * 1000) / 1000
    }
    previous.clear()
    for (const row of tree) previous.set(row.pid, { cpuSeconds: row.cpuSeconds, command: row.command })
    if (lastAt !== null) samples.write(`${JSON.stringify({ t: at, dt: at - lastAt, cpu: deltas, rssKb: Object.fromEntries(tree.filter((row) => row.depth <= 2).map((row) => [row.pid, row.rssKb])) })}\n`)
    lastAt = at
    lastTree = tree
    return true
  }

  const loop = (async () => {
    while (!stopped) {
      const started = Date.now()
      const alive = await tick()
      if (!alive) {
        stopped = true
        throw new Error(`Process ${rootPid} is gone; the app quit during the recording`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, intervalMs - (Date.now() - started))))
    }
  })()

  return {
    tree: () => lastTree,
    stop: async () => {
      stopped = true
      await loop.catch(() => {})
      await Promise.all([new Promise((done) => samples.end(done)), new Promise((done) => processes.end(done))])
    },
    done: loop,
  }
}

/**
 * Physical footprint of the long-lived processes every `intervalMs`. Keeps
 * the total and the categories that explain it: in a renderer "App-Specific
 * Tag 16" is V8, "Tag 14" PartitionAlloc (DOM, strings).
 */
export const startFootprintSampler = ({ outputDir, pids, intervalMs = 30_000 }) => {
  const stream = createWriteStream(join(outputDir, "footprint.jsonl"))
  const errors = createWriteStream(join(outputDir, "errors-footprint.jsonl"))
  const scratch = join(outputDir, ".footprint.json")
  let stopped = false
  let wake = null

  const sample = async () => {
    const list = pids()
    if (list.length === 0) return
    await rm(scratch, { force: true })
    await run("footprint", ["-j", scratch, ...list.flatMap((pid) => ["-p", String(pid)])], 25_000)
    let parsed
    try {
      parsed = JSON.parse(await readFile(scratch, "utf8"))
    } catch {
      errors.write(`${JSON.stringify({ t: Date.now(), source: "footprint" })}\n`)
      return
    }
    const processes = (parsed.processes ?? []).map((entry) => {
      const categories = Object.entries(entry.categories ?? {})
        .map(([name, value]) => ({ name, dirty: value.dirty ?? 0 }))
        .sort((left, right) => right.dirty - left.dirty)
        .slice(0, 6)
      return { pid: entry.pid, name: entry.name, footprint: entry.footprint, top: categories }
    })
    stream.write(`${JSON.stringify({ t: Date.now(), processes })}\n`)
  }

  const loop = (async () => {
    while (!stopped) {
      await sample()
      await new Promise((resolveWait) => { wake = resolveWait; setTimeout(resolveWait, intervalMs) })
    }
  })()

  return {
    stop: async () => {
      stopped = true
      wake?.()
      await loop
      await sample()
      await Promise.all([new Promise((done) => stream.end(done)), new Promise((done) => errors.end(done))])
      await rm(scratch, { force: true })
    },
  }
}

/**
 * Cumulative bytes per process from `nettop`, one block every `seconds`.
 * `nettop` names a process `<name truncated>.<pid>`; the analysis matches the
 * pid against the app's tree and takes deltas between blocks.
 */
export const startNettop = ({ outputDir, kind, seconds = 5 }) => {
  const stream = createWriteStream(join(outputDir, `net-${kind}.jsonl`))
  const errors = createWriteStream(join(outputDir, `errors-net-${kind}.jsonl`))
  let stopped = false
  let wake = null
  // A long-running `nettop -L 0` block-buffers its output into a pipe and
  // writes nothing for minutes, and its cumulative counters drop when a
  // connection closes. Each call prints two blocks and exits; with `-d` the
  // second block is the bytes moved during the call.
  const sample = async () => {
    const startedAt = Date.now()
    const output = await run("nettop", ["-P", "-L", "2", "-d", "-s", String(seconds), "-n", "-x", "-t", kind, "-J", "bytes_in,bytes_out"], (seconds + 10) * 1000)
    const blocks = output.split(/^,bytes_in,bytes_out,?$/m).slice(1)
    const bytes = {}
    for (const line of (blocks[1] ?? "").split("\n")) {
      const match = /^(.*)\.(\d+),(\d+),(\d+),?$/.exec(line)
      if (match && (Number(match[3]) > 0 || Number(match[4]) > 0)) bytes[match[2]] = [Number(match[3]), Number(match[4])]
    }
    if (blocks.length >= 2) {
      stream.write(`${JSON.stringify({ t: Date.now(), dt: Date.now() - startedAt, bytes })}\n`)
      return
    }
    errors.write(`${JSON.stringify({ t: Date.now(), source: `nettop ${kind}` })}\n`)
    // A call that failed at once must not turn into a spawn loop.
    await new Promise((resolveWait) => { wake = resolveWait; setTimeout(resolveWait, Math.max(0, seconds * 1000 - (Date.now() - startedAt))) })
  }
  const loop = (async () => {
    while (!stopped) await sample()
  })()
  return {
    stop: async () => {
      stopped = true
      wake?.()
      await loop
      await Promise.all([new Promise((done) => stream.end(done)), new Promise((done) => errors.end(done))])
    },
  }
}
