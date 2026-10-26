#!/usr/bin/env node
/**
 * An OpenChamber server for perf captures that shares nothing with the user's
 * own app: its own HOME (OpenCode's sessions database), its own
 * OPENCHAMBER_DATA_DIR, an environment rebuilt from scratch so no
 * OPENCHAMBER_* / OPENCODE_* variable from the desktop app leaks in, no UI
 * password, and the fixture provider registered as the default model.
 *
 * As a command (`bun run profile:serve`) it starts the fixture provider and the
 * server, checks the served bundle, and runs until interrupted, then stops
 * exactly what it started. `profile:compare` uses the same functions.
 *
 * Layout under --root: `state/` (HOME and data dir; the server's whole
 * state), `project/` (the directory sessions belong to), and `seed/` (a
 * snapshot of `state/`, restored with --fresh).
 */

import { execFileSync, spawn } from "node:child_process"
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { platform } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { wait } from "./cdp.mjs"
import { AGENT_READ_FILES, agentReadFileContent, fixtureProviderConfig } from "./fixture-provider.mjs"

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const FIXTURE_SCRIPT = join(REPO_ROOT, "scripts/perf/fixture-provider.mjs")
const MAC_BUNDLED_OPENCODE = "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode"

const HELP = `Usage: bun run profile:serve -- [options]

Starts the fixture provider and an isolated OpenChamber server on a build, and
keeps them running until Ctrl-C, which stops both. Point the profile:*
commands at the printed URL with --dir <root>/project.

Options:
  --repo <checkout>        Checkout whose server and CLI run (default: this one)
  --dist <directory>       Built UI to serve (default: <repo>/packages/web/dist;
                           the diagnostic build is <repo>/tmp/web-dist-diag)
  --root <directory>       State, project and seed directories
                           (default: tmp/perf-serve)
  --fresh                  Restore state from <root>/seed before starting, or
                           start empty when there is no seed
  --port <port>            Server port (default: 4799)
  --fixture-port <port>    Fixture provider port (default: 4798); reused when
                           something already listens there
  --opencode-binary <path> OpenCode CLI (default: $OPENCODE_BINARY, else the
                           one bundled in /Applications/OpenChamber.app on macOS,
                           else the server's own resolution)
  --help                   Show this help`

const portInUse = (port) => new Promise((resolvePort) => {
  const socket = connect({ port, host: "127.0.0.1" })
  socket.once("connect", () => { socket.destroy(); resolvePort(true) })
  socket.once("error", () => resolvePort(false))
})

/**
 * The environment every perf child gets: the parent's, minus anything that
 * would point it at the user's app, plus the given overrides.
 */
export const isolatedEnv = (overrides = {}) => {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENCHAMBER_|OPENCODE_|ELECTRON_)/.test(key)) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}

const defaultOpencodeBinary = () => process.env.OPENCODE_BINARY
  || (platform() === "darwin" && existsSync(MAC_BUNDLED_OPENCODE) ? MAC_BUNDLED_OPENCODE : null)

const waitForPort = async (port, timeoutMs, child) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false
    if (await portInUse(port)) return true
    await wait(250)
  }
  return false
}

/** Child PIDs of a process, read before stopping it. */
const childPids = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").map(Number).filter(Boolean)
  } catch {
    return []
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Stops a process tree this module started: the process group, then any child left. */
const stopTree = async (child) => {
  if (!child.pid || child.exitCode !== null) return []
  const children = childPids(child.pid)
  try { process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
  for (let attempt = 0; attempt < 40 && alive(child.pid); attempt += 1) await wait(250)
  for (const pid of children) if (alive(pid)) process.kill(pid, "SIGTERM")
  return children
}

/** Starts the fixture provider unless one already listens on `port`. */
export const startFixture = async ({ port, logFile }) => {
  if (await portInUse(port)) return { pid: null, reused: true, stop: async () => undefined }
  const child = spawn(process.execPath, [FIXTURE_SCRIPT, String(port)], {
    detached: true,
    stdio: ["ignore", logFile ? "pipe" : "ignore", logFile ? "pipe" : "ignore"],
    env: isolatedEnv(),
  })
  if (logFile) {
    const log = createWriteStream(logFile)
    child.stdout.pipe(log)
    child.stderr.pipe(log)
  }
  if (!(await waitForPort(port, 15_000, child))) {
    await stopTree(child)
    throw new Error(`The fixture provider did not start on port ${port}${logFile ? `; see ${logFile}` : ""}.`)
  }
  return { pid: child.pid, reused: false, stop: () => stopTree(child) }
}

/** The main chunk a build's index.html loads, or null. */
const builtMainChunk = (dist) => {
  const file = join(dist, "index.html")
  if (!existsSync(file)) return null
  return readFileSync(file, "utf8").match(/src="(\/assets\/main-[^"]+)"/)?.[1] ?? null
}

/** The main chunk the running server serves, bypassing every cache. */
const servedMainChunk = async (url) => {
  const response = await fetch(new URL("/", url), { headers: { "cache-control": "no-cache" } })
  return (await response.text()).match(/src="(\/assets\/main-[^"]+)"/)?.[1] ?? null
}

const writeSettings = (state, project) => {
  const file = join(state, "oc-data", "settings.json")
  if (existsSync(file)) return
  const id = `path_${Buffer.from(project).toString("base64url")}`
  const now = Date.now()
  writeFileSync(file, JSON.stringify({
    homeDirectory: join(state, "home"),
    projects: [{ id, path: project, label: basename(project), addedAt: now, lastOpenedAt: now, sidebarCollapsed: false }],
    activeProjectId: id,
    lastDirectory: project,
    defaultModel: "perf/stream-300cps",
  }, null, 2))
}

/**
 * Creates the project directory as its own Git repository, so OpenCode does
 * not resolve it to a repository that happens to contain it.
 */
export const ensureProject = (project) => {
  mkdirSync(project, { recursive: true })
  if (!existsSync(join(project, ".git"))) execFileSync("git", ["init", "-q"], { cwd: project })
  for (const file of AGENT_READ_FILES) {
    mkdirSync(dirname(join(project, file)), { recursive: true })
    writeFileSync(join(project, file), agentReadFileContent(file))
  }
}

/** Replaces `state` with `seed`, or empties it when there is no seed. */
export const restoreState = (state, seed) => {
  rmSync(state, { recursive: true, force: true })
  if (seed && existsSync(seed)) cpSync(seed, state, { recursive: true })
}

/**
 * Starts `node <repo>/packages/web/bin/cli.js serve` on `dist` with an
 * isolated home under `state`. Resolves once it answers HTTP, with the served
 * main chunk checked against the build's index.html.
 */
export const startIsolatedServer = async ({ repo, dist, state, project, port, fixturePort, opencodeBinary = defaultOpencodeBinary(), logFile }) => {
  if (await portInUse(port)) throw new Error(`Port ${port} is already in use; stop that server or pass another port.`)
  const built = builtMainChunk(dist)
  if (!built) throw new Error(`${dist}/index.html has no main chunk; build it first.`)
  mkdirSync(join(state, "home"), { recursive: true })
  mkdirSync(join(state, "oc-data"), { recursive: true })
  ensureProject(project)
  writeSettings(state, project)
  const config = { ...fixtureProviderConfig(fixturePort), model: "perf/stream-300cps", small_model: "perf/stream-1200cps", autoupdate: false, share: "disabled" }
  const env = {
    HOME: join(state, "home"),
    USER: process.env.USER ?? "",
    PATH: process.env.PATH ?? "",
    SHELL: process.env.SHELL ?? "/bin/sh",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    OPENCHAMBER_DATA_DIR: join(state, "oc-data"),
    OPENCHAMBER_DIST_DIR: dist,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  }
  if (opencodeBinary) env.OPENCODE_BINARY = opencodeBinary
  const child = spawn(process.execPath, [join(repo, "packages/web/bin/cli.js"), "serve", "--port", String(port), "--foreground"], {
    cwd: project,
    env,
    // Its own process group, so stopping it stops the OpenCode it manages.
    detached: true,
    stdio: ["ignore", logFile ? "pipe" : "ignore", logFile ? "pipe" : "ignore"],
  })
  if (logFile) {
    const log = createWriteStream(logFile)
    child.stdout.pipe(log)
    child.stderr.pipe(log)
  }
  const url = `http://127.0.0.1:${port}`
  const stop = () => stopTree(child)
  const deadline = Date.now() + 120_000
  let ready = false
  while (Date.now() < deadline && child.exitCode === null) {
    ready = await fetch(`${url}/`).then((response) => response.ok, () => false)
    if (ready) break
    await wait(1000)
  }
  if (!ready) {
    await stop()
    throw new Error(`The server did not answer on ${url}${logFile ? `; see ${logFile}` : ""}.`)
  }
  const served = await servedMainChunk(url)
  const bundle = { dist, built, served, matches: built === served }
  if (!bundle.matches) {
    await stop()
    throw new Error(`The server serves ${served} but ${dist} built ${built}; the page would not run this build.`)
  }
  return { url, pid: child.pid, bundle, stop }
}

const parseArgs = (argv) => {
  const options = { repo: REPO_ROOT, dist: null, root: join(REPO_ROOT, "tmp/perf-serve"), fresh: false, port: 4799, fixturePort: 4798, opencodeBinary: defaultOpencodeBinary() }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--repo") options.repo = resolve(argv[++index])
    else if (value === "--dist") options.dist = resolve(argv[++index])
    else if (value === "--root") options.root = resolve(argv[++index])
    else if (value === "--fresh") options.fresh = true
    else if (value === "--port") options.port = Number(argv[++index])
    else if (value === "--fixture-port") options.fixturePort = Number(argv[++index])
    else if (value === "--opencode-binary") options.opencodeBinary = resolve(argv[++index])
    else throw new Error(`Unknown option: ${value}`)
  }
  options.dist = options.dist ?? join(options.repo, "packages/web/dist")
  return options
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const state = join(options.root, "state")
  // The fixture log is opened before startServer creates anything under the
  // root, so a first run on a new --root needs the directory made here.
  mkdirSync(options.root, { recursive: true })
  if (options.fresh) restoreState(state, join(options.root, "seed"))
  const fixture = await startFixture({ port: options.fixturePort, logFile: join(options.root, "fixture.log") })
  let server
  try {
    server = await startIsolatedServer({
      repo: options.repo, dist: options.dist, state, project: join(options.root, "project"),
      port: options.port, fixturePort: options.fixturePort, opencodeBinary: options.opencodeBinary,
      logFile: join(options.root, "server.log"),
    })
  } catch (error) {
    await fixture.stop()
    throw error
  }
  console.log(`Server ${server.url} (pid ${server.pid}) serving ${server.bundle.served} from ${options.dist}`)
  console.log(`Fixture provider on ${options.fixturePort}${fixture.reused ? " (already running, not started here)" : ` (pid ${fixture.pid})`}`)
  console.log(`Project: ${join(options.root, "project")}  State: ${state}  Log: ${join(options.root, "server.log")}`)
  console.log("Ctrl-C stops both.")
  const shutdown = async () => {
    const children = await server.stop()
    await fixture.stop()
    console.log(`Stopped server ${server.pid}${children.length ? ` and its children ${children.join(", ")}` : ""}${fixture.reused ? "" : `, fixture ${fixture.pid}`}.`)
    process.exit(0)
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`profile:serve failed: ${error.message}`)
    process.exitCode = 1
  })
}
