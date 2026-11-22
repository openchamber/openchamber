#!/usr/bin/env node
/**
 * Long idle recording of the installed desktop app, the way a user runs it:
 * their own profile, projects, sessions and accounts.
 *
 * `profile:idle` answers "what does the page do while idle" on an isolated
 * server for seconds. This command answers "what does the whole app cost while
 * idle" over many minutes: CPU and memory of every process of the app's tree,
 * the processes it spawns, bytes on loopback and to the outside, and, when the
 * app runs with a debugging port, every request and realtime frame the window
 * receives. `soak-analyze.mjs` then lines them up per second, so a CPU spike
 * reads next to the request or event that came with it.
 *
 * It only observes: nothing is clicked, reloaded or sent. The recording starts
 * after `--delay`, which leaves time to step away from the machine.
 */

import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

import { analyzeSoak } from "./perf/soak-analyze.mjs"
import { startMainProfile, startRendererRecorder } from "./perf/soak-cdp.mjs"
import { startFootprintSampler, startNettop, startProcessSampler } from "./perf/soak-system.mjs"

const HELP = `Usage: bun run profile:soak -- [options]

Records the installed desktop app while nobody uses it.

Options:
  --minutes <n>        Recording length (default: 15)
  --delay <seconds>    Wait before recording starts (default: 60)
  --cdp-port <port>    Debugging port of the app, started with
                       --remote-debugging-port=<port>. Without it only
                       process, memory and byte counters are recorded.
  --cpu-profile        With --cdp-port, record a sampling CPU profile of each
                       window for the whole recording (attribution; adds load)
  --reload             With --cdp-port, reload the window once before the delay,
                       so the realtime channel opens under the recorder (frames
                       of a socket opened earlier are never reported)
  --inspect-port <p>   Node inspector port of the main process (the app started
                       with --inspect=<p>): records a CPU profile of the server
                       (attribution; adds load)
  --exclude-pid <pid>  Leave this process and its children out (an agent
                       session working inside the app). Repeatable.
  --app-pid <pid>      The app's main process (default: the running OpenChamber)
  --output <dir>       Run directory (default: tmp/soak/<time>)
  --label <text>       Stored in the summary
  --help               Show this help

Run the privileged capture into the same directory for request paths on
loopback, external hosts and every spawned process:
  sudo sh scripts/perf/soak-capture.sh <dir> <minutes>
`

const parseArgs = (argv) => {
  const options = { minutes: 15, delay: 60, cdpPort: null, cpuProfile: false, reload: false, inspectPort: null, excludePids: [], appPid: null, output: null, label: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      index += 1
      return value
    }
    if (argument === "--help") { console.log(HELP); process.exit(0) }
    else if (argument === "--minutes") options.minutes = Number(next())
    else if (argument === "--delay") options.delay = Number(next())
    else if (argument === "--cdp-port") options.cdpPort = Number(next())
    else if (argument === "--cpu-profile") options.cpuProfile = true
    else if (argument === "--reload") options.reload = true
    else if (argument === "--inspect-port") options.inspectPort = Number(next())
    else if (argument === "--exclude-pid") options.excludePids.push(Number(next()))
    else if (argument === "--app-pid") options.appPid = Number(next())
    else if (argument === "--output") options.output = next()
    else if (argument === "--label") options.label = next()
    else throw new Error(`Unknown option ${argument}\n\n${HELP}`)
  }
  if (!(options.minutes > 0)) throw new Error("--minutes must be positive")
  if ((options.cpuProfile || options.reload) && !options.cdpPort) throw new Error("--cpu-profile and --reload need --cdp-port")
  return options
}

// `pgrep -x OpenChamber` misses the main process on macOS 27; its executable
// path is unambiguous.
const findAppPid = () => new Promise((resolvePid, reject) => {
  execFile("ps", ["-axo", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    const line = String(stdout).split("\n").find((entry) => /^\s*\d+\s+\S*\/Contents\/MacOS\/OpenChamber(\s|$)/.test(entry))
    const pid = Number(line?.trim().split(/\s+/)[0])
    if (error || !pid) reject(new Error("OpenChamber is not running; pass --app-pid"))
    else resolvePid(pid)
  })
})

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const appPid = options.appPid ?? await findAppPid()
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outputDir = resolve(options.output ?? join("tmp", "soak", stamp))
  await mkdir(outputDir, { recursive: true })

  console.log(`[soak] app ${appPid}, output ${outputDir}`)
  // Attach first: a debugging port that is not there fails the run before any
  // sampler starts. A reload happens here, so the delay lets the window settle.
  const renderer = options.cdpPort ? await startRendererRecorder({ port: options.cdpPort, outputDir, cpuProfile: options.cpuProfile, reload: options.reload }) : null
  if (options.delay > 0) {
    console.log(`[soak] recording starts in ${options.delay}s`)
    await wait(options.delay * 1000)
  }
  await renderer?.markStart()
  const mainProfile = options.inspectPort ? await startMainProfile({ port: options.inspectPort, outputDir }) : null
  const startedAt = Date.now()
  const excluded = new Set(options.excludePids)
  const writeMeta = (extra = {}) => writeFile(join(outputDir, "meta.json"), `${JSON.stringify({
    label: options.label,
    appPid,
    startedAt,
    plannedMinutes: options.minutes,
    excludePids: [...excluded],
    cdpPort: options.cdpPort,
    cpuProfile: options.cpuProfile,
    pages: renderer?.pages ?? [],
    reload: options.reload,
    mainProfile: Boolean(options.inspectPort),
    ...extra,
  }, null, 2)}\n`)
  const processSampler = startProcessSampler({ outputDir, rootPid: appPid, excludePids: excluded })
  const longLived = () => processSampler.tree().filter((row) => (row.depth <= 2 && row.command.includes("OpenChamber")) || /opencode serve/.test(row.command)).map((row) => row.pid)
  await wait(1_000)
  const footprint = startFootprintSampler({ outputDir, pids: longLived })
  const nettop = [startNettop({ outputDir, kind: "loopback" }), startNettop({ outputDir, kind: "external" })]
  await writeMeta()
  console.log(`[soak] recording ${options.minutes} min${renderer ? `, ${renderer.pages.length} window(s) over CDP` : ", no CDP"}`)

  let failure = null
  let timer = null
  await Promise.race([
    new Promise((resolveWait) => { timer = setTimeout(resolveWait, options.minutes * 60_000) }),
    processSampler.done.catch((error) => { failure = error }),
  ])
  clearTimeout(timer)

  const endedAt = Date.now()
  await Promise.all([renderer?.stop(), mainProfile?.stop()])
  await Promise.all([processSampler.stop(), footprint.stop(), ...nettop.map((recorder) => recorder.stop())])
  await writeMeta({ endedAt, failure: failure?.message ?? null })
  if (failure) console.error(`[soak] ${failure.message}`)

  const report = await analyzeSoak(outputDir)
  console.log(report)
  console.log(`[soak] summary: ${join(outputDir, "summary.md")}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
