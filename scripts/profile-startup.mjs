#!/usr/bin/env node
/**
 * Cold-start benchmark for a packaged OpenChamber Desktop build.
 *
 * Launches the packaged app in an isolated home directory (its own settings,
 * Electron profile, logs and OpenCode data, with the developer's
 * OPENCHAMBER_* / OPENCODE_* environment stripped), so it never touches the
 * developer's running app or settings. Every launch reports, in milliseconds
 * since the process was spawned:
 *
 * - the main process's own startup marks from `main.log`
 *   (`[startup-performance]`, enabled through OPENCHAMBER_STARTUP_PERF=1):
 *   Electron ready, splash navigation, window shown, server start/ready,
 *   application navigation and renderer load;
 * - renderer readiness polled over CDP: React mounted into `#root`, the
 *   composer on screen, and `rendererIdle` once the renderer main thread
 *   stayed quiet for `--settle-ms`;
 * - with `--screen`, when the window's pixels first changed (`screenPainted`)
 *   and when they stopped changing (`screenSettled`), sampled from the screen
 *   itself. Chromium stops painting an occluded window and a splash reads as
 *   "painted" long before the interface is on screen, so this is the ground
 *   truth for "the user sees the app". Needs the Screen Recording permission
 *   for the terminal running the benchmark, and a `--window-at` position that
 *   nothing else covers.
 *
 * `--compare <other .app>` alternates launches of two builds so machine drift
 * affects both equally. `--warmup` launches are discarded (the first launch of
 * a new binary pays the Gatekeeper scan). `--opencode warm` starts the bundled
 * OpenCode CLI once before the runs and points every launch at it through
 * OPENCODE_PORT, so the measurement excludes OpenCode's own start.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, reservePort, wait } from "./perf/cdp.mjs"
import { round } from "./perf/metrics.mjs"

const HELP = `Usage: bun run profile:startup -- [options]

Measures how long a packaged OpenChamber Desktop build takes to start.

Options:
  --app <path>             Packaged app (.app bundle on macOS, executable elsewhere).
                           Default: packages/electron/dist/mac-<arch>/OpenChamber.app
  --compare <path>         Second build; launches alternate between the two
  --runs <n>               Measured launches per build (default: 5)
  --warmup <n>             Discarded launches per build before measuring (default: 1)
  --opencode cold|warm     cold: the app starts its own OpenCode on every launch
                           (default). warm: one OpenCode from the bundled CLI is
                           started before the runs and every launch attaches to it.
  --home <dir>             Isolated home directory (default: <tmp>/openchamber-bench-startup)
  --fresh                  Wipe the isolated home before every launch (first launch
                           after an install). Default keeps it, so the second and
                           later launches measure a returning user.
  --shell-delay-ms <ms>    Make the isolated home's login shell take this long to
                           start (a .zshrc that sleeps), the way a user's real
                           shell startup files do. The app probes the login shell
                           for PATH before it starts the backend. Default: 0
  --window-at <x,y>        Restore the window at this position. Pick a spot the
                           terminal does not cover when sampling the screen.
  --screen                 Sample the window's pixels from the screen (macOS,
                           needs Screen Recording permission for the terminal)
  --settle-ms <ms>         Renderer quiet time that ends a run (default: 1500)
  --timeout-ms <ms>        Give up on a launch after this long (default: 60000)
  --output <directory>     Artifact directory (default: artifacts/startup-<time>)
  --label <text>           Human label stored in the summary
  --help                   Show this help

Needs a packaged build: bun run electron:build. See scripts/perf/DOCUMENTATION.md.
`

const parseArgs = (argv) => {
  const options = {
    app: null,
    compare: null,
    runs: 5,
    warmup: 1,
    opencode: "cold",
    home: null,
    fresh: false,
    shellDelayMs: 0,
    windowAt: null,
    screen: false,
    settleMs: 1500,
    timeoutMs: 60_000,
    output: null,
    label: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") { console.log(HELP); process.exit(0) }
    else if (value === "--app") options.app = argv[++index]
    else if (value === "--compare") options.compare = argv[++index]
    else if (value === "--runs") options.runs = Number(argv[++index])
    else if (value === "--warmup") options.warmup = Number(argv[++index])
    else if (value === "--opencode") options.opencode = argv[++index]
    else if (value === "--home") options.home = argv[++index]
    else if (value === "--fresh") options.fresh = true
    else if (value === "--shell-delay-ms") options.shellDelayMs = Number(argv[++index])
    else if (value === "--window-at") {
      const [x, y] = String(argv[++index]).split(",").map(Number)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("--window-at expects x,y")
      options.windowAt = { x, y }
    }
    else if (value === "--screen") options.screen = true
    else if (value === "--settle-ms") options.settleMs = Number(argv[++index])
    else if (value === "--timeout-ms") options.timeoutMs = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--label") options.label = argv[++index]
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer")
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error("--warmup must be a non-negative integer")
  if (options.opencode !== "cold" && options.opencode !== "warm") throw new Error("--opencode must be cold or warm")
  if (!Number.isFinite(options.shellDelayMs) || options.shellDelayMs < 0) throw new Error("--shell-delay-ms must be a non-negative number")
  return options
}

const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 800

const repoRoot = resolve(new URL("..", import.meta.url).pathname)

const defaultApp = () => {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "darwin") return join(repoRoot, "packages/electron/dist", `mac-${arch}`, "OpenChamber.app")
  if (process.platform === "linux") return join(repoRoot, "packages/electron/dist/linux-unpacked/openchamber")
  return join(repoRoot, "packages/electron/dist/win-unpacked/OpenChamber.exe")
}

// The executable to spawn and the bundled OpenCode CLI, per platform layout.
const resolveBuild = (appPath, label) => {
  const app = resolve(appPath)
  if (!existsSync(app)) throw new Error(`Packaged app not found: ${app}. Run bun run electron:build or pass --app.`)
  if (process.platform === "darwin") {
    const macos = join(app, "Contents", "MacOS")
    const executable = existsSync(macos) ? readdirSync(macos).map((name) => join(macos, name)).find((candidate) => existsSync(candidate)) : null
    if (!executable) throw new Error(`No executable inside ${app}`)
    return { label, app, executable, opencodeCli: join(app, "Contents", "Resources", "opencode-cli", "opencode") }
  }
  const resources = join(app, "..", "resources")
  return { label, app, executable: app, opencodeCli: join(resources, "opencode-cli", process.platform === "win32" ? "opencode.exe" : "opencode") }
}

// Where the app writes inside the isolated home. Settings follow
// OPENCHAMBER_DATA_DIR and electron-log follows $HOME; the Electron profile
// (single-instance lock, Chromium caches) follows OPENCHAMBER_DESKTOP_USER_DATA_DIR,
// because macOS resolves the home directory from the user record rather than $HOME.
const homeLayout = (home) => {
  const config = join(home, ".config", "openchamber")
  const logs = process.platform === "darwin"
    ? join(home, "Library", "Logs", "OpenChamber")
    : process.platform === "win32"
      ? join(home, "AppData", "Roaming", "OpenChamber", "logs")
      : join(home, ".config", "OpenChamber", "logs")
  return { home, config, settings: join(config, "settings.json"), userData: join(home, "userData"), mainLog: join(logs, "main.log") }
}

// ELECTRON_RUN_AS_NODE would turn the launched app into a bare Node process
// (an agent host or an Electron-based terminal sets it for its own children).
const isolatedEnv = (home, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCHAMBER_|OPENCODE_|ELECTRON_|NODE_OPTIONS$)/.test(key))),
  HOME: home,
  USERPROFILE: home,
  // The login-shell probe runs $SHELL; pin it so the isolated .zshrc applies.
  ...(process.platform === "win32" ? {} : { SHELL: "/bin/zsh" }),
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  OPENCHAMBER_DATA_DIR: join(home, ".config", "openchamber"),
  OPENCHAMBER_DESKTOP_USER_DATA_DIR: join(home, "userData"),
  OPENCHAMBER_STARTUP_PERF: "1",
  ...extra,
})

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// The app probes `$SHELL -il` for the user's PATH before starting the backend;
// a sleeping .zshrc stands in for the startup files a real shell runs.
const seedShellStartup = (home, delayMs) => {
  const rc = join(home, ".zshrc")
  if (delayMs > 0) writeFileSync(rc, `sleep ${(delayMs / 1000).toFixed(3)}\n`)
  else rmSync(rc, { force: true })
}

// The window is restored from `desktopWindowState` in settings.json; writing it
// before a launch both places the window and tells the screen sampler where to look.
const seedWindowState = (layout, windowAt) => {
  if (!windowAt) return
  mkdirSync(layout.config, { recursive: true })
  const settings = readJson(layout.settings) ?? {}
  settings.desktopWindowState = { x: windowAt.x, y: windowAt.y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT, maximized: false, fullscreen: false }
  writeFileSync(layout.settings, JSON.stringify(settings, null, 2))
}

// Every `[startup-performance]` entry electron-log wrote since the launch,
// keyed by phase (and document class for the navigation phases), with the
// epoch it was recorded at. electron-log wraps long objects onto continuation
// lines, so entries are split on the next timestamp. The Electron phases carry
// `totalDurationMs` counted from the first line of the app's own code (the
// entry module, or main.mjs's body in builds without one), so
// `at - totalDurationMs` recovers when that code started running.
const readStartupMarks = (mainLog, since) => {
  if (!existsSync(mainLog)) return { marks: {}, codeStartedAt: undefined }
  const marks = {}
  let codeStartedAt
  for (const entry of readFileSync(mainLog, "utf8").split(/\r?\n(?=\[\d{4}-)/)) {
    if (!entry.includes("[startup-performance]")) continue
    const phase = entry.match(/phase: '([^']+)'/)?.[1]
    const at = Number(entry.match(/\bat: (\d+)/)?.[1])
    if (!phase || !Number.isFinite(at) || at < since) continue
    const documentClass = entry.match(/documentClass: '([^']+)'/)?.[1]
    const key = documentClass ? `${phase}.${documentClass}` : phase
    if (marks[key] === undefined) marks[key] = at
    const total = Number(entry.match(/totalDurationMs: ([\d.]+)/)?.[1])
    if (phase === "electron.app.ready" && Number.isFinite(total)) codeStartedAt = at - total
  }
  return { marks, codeStartedAt }
}

const listTargets = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`)
    if (!response.ok) return []
    return await response.json()
  } catch {
    return []
  }
}

// Renderer readiness, read in one round trip. The splash is a data: document
// with no #root; the application document mounts React into it.
const PROBE = `(() => ({
  origin: performance.timeOrigin,
  url: location.href,
  visible: document.visibilityState === 'visible',
  firstPaint: performance.getEntriesByType('paint').find((entry) => entry.name === 'first-paint')?.startTime ?? null,
  domInteractive: performance.getEntriesByType('navigation')[0]?.domInteractive ?? null,
  mounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
  composer: !!document.querySelector('[data-chat-input="true"]'),
  sessionRows: document.querySelectorAll('[data-session-row]').length,
}))()`

const metricValue = (metrics, name) => metrics.find((entry) => entry.name === name)?.value ?? 0

// Sample a 16x16 grid of the window's pixels from the screen every ~50 ms and
// report when the content first differed from the initial frame and when it
// stopped changing. Uses `screencapture`, so macOS only; a capture that fails
// (no Screen Recording permission) ends sampling and is reported as such.
const startScreenSampler = ({ windowAt, outputDir, run, durationMs }) => {
  if (process.platform !== "darwin") return { stop: async () => ({ error: "screen sampling is implemented for macOS only" }) }
  const rect = `${windowAt.x},${windowAt.y},${WINDOW_WIDTH},${WINDOW_HEIGHT}`
  const file = join(outputDir, `screen-${run}.bmp`)
  const samples = []
  let error = null
  let stopped = false
  const startedAt = Date.now()
  const loop = (async () => {
    while (!stopped && Date.now() - startedAt < durationMs) {
      const at = Date.now()
      const result = spawnSync("screencapture", ["-x", "-t", "bmp", "-R", rect, file], { encoding: "utf8" })
      if (result.status !== 0 || !existsSync(file)) {
        error = (result.stderr || result.stdout || "screencapture failed").trim()
        break
      }
      const sum = sampleBitmap(readFileSync(file))
      if (sum === null) {
        error = "screencapture wrote a bitmap this script cannot read"
        break
      }
      samples.push([at - startedAt, sum])
      await wait(50)
    }
    rmSync(file, { force: true })
  })()
  return {
    stop: async () => {
      stopped = true
      await loop
      if (error) return { error, samples: samples.length }
      const first = samples[0]?.[1]
      const last = samples.at(-1)?.[1]
      const differs = (a, b) => Math.abs(a - b) > 16 * 16 * 12
      const changed = samples.filter(([, sum]) => differs(sum, first)).map(([at]) => at)
      const settledIndex = samples.findLastIndex(([, sum]) => last !== undefined && differs(sum, last))
      return {
        samples: samples.length,
        painted: changed[0],
        settled: settledIndex >= 0 ? samples[settledIndex + 1]?.[0] : samples[0]?.[0],
      }
    },
  }
}

// Sum of R+G+B over a 16x16 grid of an uncompressed 24/32-bit BMP.
const sampleBitmap = (buffer) => {
  if (buffer.length < 54 || buffer.toString("ascii", 0, 2) !== "BM") return null
  const pixelOffset = buffer.readUInt32LE(10)
  const width = buffer.readInt32LE(18)
  const heightRaw = buffer.readInt32LE(22)
  const bitsPerPixel = buffer.readUInt16LE(28)
  const compression = buffer.readUInt32LE(30)
  if ((bitsPerPixel !== 24 && bitsPerPixel !== 32) || (compression !== 0 && compression !== 3)) return null
  const height = Math.abs(heightRaw)
  const bytesPerPixel = bitsPerPixel / 8
  const rowBytes = Math.ceil((width * bytesPerPixel) / 4) * 4
  let sum = 0
  for (let i = 1; i <= 16; i += 1) {
    for (let j = 1; j <= 16; j += 1) {
      const x = Math.floor((width * j) / 17)
      const y = Math.floor((height * i) / 17)
      const row = heightRaw > 0 ? height - 1 - y : y
      const offset = pixelOffset + row * rowBytes + x * bytesPerPixel
      if (offset + 2 >= buffer.length) return null
      sum += buffer[offset] + buffer[offset + 1] + buffer[offset + 2]
    }
  }
  return sum
}

// Every process under `root`, so a launch can be cleaned up completely: the
// app's own helpers plus the OpenCode it started.
const processTree = (root) => {
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
  const children = new Map()
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const tree = []
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return tree
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const signal = (pid, name) => {
  try {
    process.kill(pid, name)
  } catch {
  }
}

// Only ever touches processes this script spawned. Ask the app to exit first,
// then force the whole tree so an OpenCode it started does not outlive the run.
const stopTree = async (root) => {
  if (!root || !isRunning(root)) return
  const tree = processTree(root)
  signal(root, "SIGTERM")
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isRunning(root)) await wait(100)
  for (const pid of tree) if (isRunning(pid)) signal(pid, "SIGKILL")
  await wait(300)
}

const launchOnce = async ({ build, run, layout, env, cdpPort, options, outputDir }) => {
  if (options.fresh) rmSync(layout.home, { recursive: true, force: true })
  mkdirSync(layout.config, { recursive: true })
  seedWindowState(layout, options.windowAt)
  seedShellStartup(layout.home, options.shellDelayMs)
  const sampler = options.screen && options.windowAt
    ? startScreenSampler({ windowAt: options.windowAt, outputDir, run, durationMs: options.timeoutMs })
    : null

  const spawnAt = Date.now()
  const child = spawn(build.executable, [`--remote-debugging-port=${cdpPort}`], { env, stdio: "ignore", detached: true })
  child.unref()
  const pid = child.pid
  const deadline = spawnAt + options.timeoutMs
  const seen = {}
  let client = null
  let targetId = null
  let last = null
  let quietSince
  let taskMs = 0
  const window = []
  let error = null

  try {
    while (Date.now() < deadline) {
      if (!client) {
        const targets = await listTargets(cdpPort)
        const page = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl && !entry.url.startsWith("devtools://"))
        if (!page) { await wait(25); continue }
        targetId = page.id
        client = new CdpClient(page.webSocketDebuggerUrl)
        await client.connect()
        await client.send("Runtime.enable")
        await client.send("Performance.enable")
        seen.rendererTarget = Date.now() - spawnAt
      }
      let probe
      try {
        const result = await client.send("Runtime.evaluate", { expression: PROBE, returnByValue: true })
        probe = result.result?.value
      } catch {
        await wait(25)
        continue
      }
      if (!probe) { await wait(25); continue }
      last = probe
      const now = Date.now() - spawnAt
      // The desktop splash is a data: document, or `/__splash` on the app's own origin.
      const isSplash = probe.url.startsWith("data:") || new URL(probe.url).pathname === "/__splash"
      const isApplication = !isSplash
      if (isSplash && seen.splashDocument === undefined) seen.splashDocument = now
      if (isApplication && seen.applicationDocument === undefined) seen.applicationDocument = now
      if (probe.visible && seen.documentVisible === undefined) seen.documentVisible = now
      if (isApplication && probe.mounted && seen.reactMounted === undefined) seen.reactMounted = now
      if (isApplication && probe.composer && seen.composerVisible === undefined) seen.composerVisible = now
      if (isApplication && probe.firstPaint !== null && seen.applicationFirstPaint === undefined) {
        seen.applicationFirstPaint = Math.round(probe.origin + probe.firstPaint - spawnAt)
      }

      let metrics = []
      try {
        metrics = (await client.send("Performance.getMetrics")).metrics ?? []
      } catch {
      }
      const task = metricValue(metrics, "TaskDuration") * 1000
      taskMs = task
      window.push({ at: Date.now(), task })
      while (window.length > 1 && window[1].at <= Date.now() - 500) window.shift()
      if (task - window[0].task > 50) quietSince = undefined
      else quietSince ??= window[0].at
      if (seen.reactMounted !== undefined && quietSince && Date.now() - quietSince >= options.settleMs) break
      await wait(50)
    }
    if (seen.reactMounted === undefined) error = `the application never mounted within ${options.timeoutMs} ms (last url: ${last?.url ?? "none"})`
  } catch (caught) {
    error = caught?.message ?? String(caught)
  }

  const rendererIdle = quietSince && seen.reactMounted !== undefined ? quietSince - spawnAt : undefined
  let renderer = null
  if (client) {
    try {
      const metrics = (await client.send("Performance.getMetrics")).metrics ?? []
      renderer = {
        taskMs: Math.round(metricValue(metrics, "TaskDuration") * 1000),
        scriptMs: Math.round(metricValue(metrics, "ScriptDuration") * 1000),
        layoutMs: Math.round(metricValue(metrics, "LayoutDuration") * 1000),
        styleMs: Math.round(metricValue(metrics, "RecalcStyleDuration") * 1000),
        domNodes: metricValue(metrics, "Nodes"),
        jsHeapMB: Math.round(metricValue(metrics, "JSHeapUsedSize") / 1048576),
      }
    } catch {
    }
    client.close()
  }
  const screen = sampler ? await sampler.stop() : null
  // Let the main log flush before reading it.
  await wait(300)
  const { marks, codeStartedAt } = readStartupMarks(layout.mainLog, spawnAt)
  await stopTree(pid)

  const msSinceSpawn = {
    codeStart: codeStartedAt !== undefined ? Math.round(codeStartedAt - spawnAt) : undefined,
    ...Object.fromEntries(Object.entries(marks).map(([key, at]) => [key, at - spawnAt])),
    ...seen,
    rendererIdle,
    screenPainted: screen?.painted,
    screenSettled: screen?.settled,
  }
  return {
    build: build.label,
    run,
    error,
    msSinceSpawn,
    renderer,
    rendererTaskMs: Math.round(taskMs),
    screen,
    finalUrl: last?.url ?? null,
    sessionRows: last?.sessionRows ?? null,
    targetId,
  }
}

// One OpenCode from the bundled CLI, shared by every launch of a warm run. The
// compared builds must bundle the same CLI or the measurement would attach
// each build to a different OpenCode.
const startWarmOpenCode = async (builds, env, port) => {
  const identities = builds.map((build) => {
    if (!existsSync(build.opencodeCli)) throw new Error(`Bundled OpenCode CLI not found: ${build.opencodeCli}`)
    const version = spawnSync(build.opencodeCli, ["--version"], { encoding: "utf8", env })
    return (version.stdout || "").trim()
  })
  if (new Set(identities).size > 1) throw new Error(`The compared builds bundle different OpenCode versions: ${identities.join(" vs ")}`)
  const child = spawn(builds[0].opencodeCli, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { env, stdio: "ignore", detached: true })
  child.unref()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`)
      if (response.ok) return child.pid
    } catch {
    }
    await wait(200)
  }
  await stopTree(child.pid)
  throw new Error("The warm OpenCode did not become healthy")
}

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length }
}

// The checkpoints a user could feel, in the order they happen, so the report
// reads top to bottom as the launch.
const MILESTONES = [
  ["codeStart", "first own code ran"],
  ["electron.entry", "entry module ran"],
  ["electron.app.ready", "electron ready"],
  ["electron.window.created", "window created"],
  ["electron.navigation.start.splash", "splash navigation start"],
  ["electron.main.loaded", "main module loaded"],
  ["electron.window.ready-to-show.splash", "window shown (splash)"],
  ["splashDocument", "splash target seen (cdp)"],
  ["electron.server.start", "server start"],
  ["electron.server.ready", "server ready"],
  ["opencode.process.ready", "opencode process ready"],
  ["opencode.health.ready", "opencode healthy"],
  ["electron.navigation.start.application", "app navigation start"],
  ["electron.renderer.dom-ready.application", "app dom-ready"],
  ["electron.renderer.loaded.application", "app loaded"],
  ["applicationFirstPaint", "app first paint"],
  ["reactMounted", "react mounted"],
  ["composerVisible", "composer visible"],
  ["rendererIdle", "renderer idle"],
  ["screenPainted", "screen: first change"],
  ["screenSettled", "screen: settled"],
]

const summarize = (samples) => {
  const out = {}
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample.msSinceSpawn)))]
  for (const key of keys) {
    const stats = median(samples.map((sample) => sample.msSinceSpawn[key]))
    if (stats) out[key] = stats
  }
  return out
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const builds = [resolveBuild(options.app ?? defaultApp(), options.compare ? "A" : "")]
  if (options.compare) builds.push(resolveBuild(options.compare, "B"))
  const home = resolve(options.home ?? join(tmpdir(), "openchamber-bench-startup"))
  const layout = homeLayout(home)
  const outputDir = resolve(options.output ?? join(repoRoot, "artifacts", `startup-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(layout.config, { recursive: true })
  if (options.screen && !options.windowAt) throw new Error("--screen needs --window-at so the sampler knows where the window is")

  const cdpPort = await reservePort()
  const opencodePort = options.opencode === "warm" ? await reservePort() : null
  const env = isolatedEnv(home, opencodePort
    ? { OPENCODE_HOST: "127.0.0.1", OPENCODE_PORT: String(opencodePort), OPENCODE_SKIP_START: "1" }
    : {})

  for (const build of builds) console.log(`build${build.label ? ` ${build.label}` : ""}: ${build.app}`)
  console.log(`home: ${home}${options.fresh ? " (wiped before every launch)" : ""}`)
  console.log(`opencode: ${options.opencode}, runs: ${options.runs} (+${options.warmup} warm-up), cdp port ${cdpPort}${options.shellDelayMs > 0 ? `, login shell delayed ${options.shellDelayMs} ms` : ""}`)

  let opencodePid = null
  let currentPid = null
  const cleanup = async () => {
    if (currentPid) await stopTree(currentPid)
    if (opencodePid) await stopTree(opencodePid)
  }
  process.on("SIGINT", async () => { await cleanup(); process.exit(130) })

  if (opencodePort) {
    opencodePid = await startWarmOpenCode(builds, isolatedEnv(home), opencodePort)
    console.log(`warm opencode at http://127.0.0.1:${opencodePort}`)
  }

  const samples = []
  try {
    for (let run = 1 - options.warmup; run <= options.runs; run += 1) {
      for (const build of builds) {
        const sample = await launchOnce({ build, run, layout, env, cdpPort, options, outputDir })
        const tag = `${run < 1 ? "warm-up" : `run ${run}`}${build.label ? ` ${build.label}` : ""}`
        if (sample.error) {
          console.log(`${tag}: FAILED — ${sample.error}`)
          if (run >= 1) samples.push(sample)
          continue
        }
        const m = sample.msSinceSpawn
        console.log(`${tag}: ready ${m["electron.app.ready"] ?? "?"} · splash ${m["electron.window.ready-to-show.splash"] ?? "?"} · server ${m["electron.server.ready"] ?? "?"} · mounted ${m.reactMounted ?? "?"} · idle ${m.rendererIdle ?? "?"}${m.screenPainted !== undefined ? ` · screen ${m.screenPainted}→${m.screenSettled}` : ""} ms`)
        if (sample.screen?.error) console.log(`  screen sampling unavailable: ${sample.screen.error}`)
        if (run >= 1) samples.push(sample)
      }
    }
  } finally {
    await cleanup()
  }

  const labels = builds.map((build) => build.label || "A")
  const summaries = Object.fromEntries(builds.map((build) => [build.label || "A", summarize(samples.filter((sample) => sample.build === build.label && !sample.error))]))
  const failures = samples.filter((sample) => sample.error).length
  const summary = {
    generatedAt: new Date().toISOString(),
    label: options.label,
    builds: builds.map(({ label, app }) => ({ label: label || "A", app })),
    opencode: options.opencode,
    runs: options.runs,
    warmup: options.warmup,
    fresh: options.fresh,
    shellDelayMs: options.shellDelayMs,
    home,
    failures,
    summaries,
    samples,
  }
  writeFileSync(join(outputDir, "startup-summary.json"), JSON.stringify(summary, null, 2))

  const width = 22
  console.log(`\n${options.opencode} opencode${options.fresh ? ", fresh home" : ""} — median (min…max) ms since spawn over ${options.runs} runs`)
  console.log(`${"".padEnd(30)}${labels.map((label) => (labels.length > 1 ? label : "").padStart(6).padEnd(width)).join("")}`)
  for (const [key, title] of MILESTONES) {
    if (!labels.some((label) => summaries[label][key])) continue
    const cells = labels.map((label) => {
      const stats = summaries[label][key]
      return stats ? `${String(round(stats.median, 0)).padStart(6)}  (${round(stats.min, 0)}…${round(stats.max, 0)})`.padEnd(width) : "".padEnd(width)
    })
    console.log(`${title.padEnd(30)}${cells.join("")}`)
  }
  const screenErrors = samples.map((sample) => sample.screen?.error).filter(Boolean)
  if (screenErrors.length > 0) console.log(`\nscreen sampling unavailable: ${screenErrors[0]}`)
  if (failures > 0) console.log(`\n${failures} launch(es) failed; see startup-summary.json`)
  console.log(`\nsummary: ${join(outputDir, "startup-summary.json")}`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exit(1)
})
