#!/usr/bin/env node
/**
 * Before/after measurement of a change, end to end.
 *
 * Builds the unchanged commit and the change in two worktrees, serves each in
 * turn from an isolated server with identical seeded state, runs the chosen
 * profile:* scenarios against it, and prints one table with median, p95 and
 * the change per metric, plus the validity flags of every run.
 *
 * The after worktree defaults to the working tree as it is now: HEAD plus
 * `git diff HEAD --binary` plus the untracked files, verified byte-identical
 * to the checkout before anything is built. Only the build differs between
 * the sides: the measurement scripts, the CLI and the project directory come
 * from this checkout, and the server state is restored from one seed before
 * every side. One build, one server and one Chrome run at a time.
 */

import { execFileSync, spawn } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"

import { compareResultDirs } from "./perf/compare-runs.mjs"
import { REPO_ROOT, ensureProject, isolatedEnv, restoreState, startFixture, startIsolatedServer } from "./perf/isolated-server.mjs"

const HELP = `Usage: bun run profile:compare -- [options]

Measures the same scenarios on a before and an after build and prints a
before/after table (median, p95, change, verdict, validity flags).

Sources:
  --before <ref>           Commit for the before build (default: HEAD)
  --after <ref>            Commit for the after build (default: the working
                           tree: HEAD + uncommitted changes + untracked files)

Measurement:
  --scenarios <list>       Comma-separated (default: stream,code,agent,switch,idle).
                           Available: ${"<SCENARIOS>"}
  --runs <n>               Runs per scenario and round (default: 5). For switch:
                           reload cycles; for startup: launches; for toggle:
                           measured close/open pairs per phase
  --rounds <n>             Alternate before/after this many times (default: 1).
                           Use 2 or more when the expected change is small:
                           machine drift then lands on both sides
  --build <prod|diag>      Build to serve (default: prod). diag is the
                           unminified build with source maps and store
                           notifications, for attribution only
  --render-probe           Pass --render-probe to session, switch, idle and toggle
                           scenarios (use with --build diag for real names)
  --save-trace             Session scenarios keep trace.json; the table then
                           adds frames, restyled elements, layerize and GPU rows
  --force-accessibility    Session, switch and toggle scenarios launch Chrome
                           with its accessibility tree on, the way a screen
                           reader or a macOS app that reads other windows turns
                           it on, so the result does not depend on the machine

Locations:
  --root <dir>             Worktrees, builds, server state, seed and Chrome
                           profiles (default: tmp/perf-compare)
  --output <dir>           Results (default: <root>/results). A rerun resumes:
                           runs whose summary exists are skipped
  --port <port>            Server port (default: 4799)
  --fixture-port <port>    Fixture provider port (default: 4798)
  --opencode-binary <path> OpenCode CLI for the servers (see profile:serve)

  --dry-run                Print the plan (sources, worktrees, builds,
                           commands) and change nothing
  --help                   Show this help

Results: <output>/before/<scenario>-<n>/, <output>/after/<scenario>-<n>/,
<output>/comparison.md. Reprint the table with
node scripts/perf/compare-runs.mjs <output>/before <output>/after.`

/**
 * `args(seed, runs)` builds the scenario's options; `once` scenarios run one
 * invocation per round that repeats internally, the others one per run.
 */
const SCENARIOS = {
  stream: { kind: "session", args: () => ["--model", "perf/stream-300cps"] },
  code: { kind: "session", args: () => ["--model", "perf/code-300cps"] },
  unicode: { kind: "session", args: () => ["--model", "perf/unicode-300cps"] },
  agent: { kind: "session", args: () => ["--model", "perf/agent-40tools-300cps"] },
  // A chat someone works in: agentic history grown with the page open (a
  // seeded session opens with only its last turns in memory), on a CPU slowed
  // four times, where what scales with history shows as dropped frames.
  grow: { kind: "session", args: () => ["--grow", "100", "--grow-model", "perf/agent-20reads-20000cps", "--model", "perf/agent-20reads-300cps", "--cpu-throttle", "4"] },
  "grow-short": { kind: "session", args: () => ["--grow", "10", "--grow-model", "perf/agent-20reads-20000cps", "--model", "perf/agent-20reads-300cps", "--cpu-throttle", "4"] },
  long: { kind: "session", seed: true, args: (seed) => ["--session", seed.long, "--model", "perf/stream-300cps"] },
  quiet: { kind: "session", seed: true, args: (seed) => ["--session", seed.long, "--quiet", "20"] },
  cpu: { kind: "session", uninstrumented: true, args: () => ["--model", "perf/stream-300cps", "--process-cpu-only", "--headed"] },
  switch: { kind: "switch", seed: true, once: true, args: (_seed, runs) => ["--title", "perf: long 120", "--title", "perf: short A", "--title", "perf: short B", "--cold-reload", "--repeat", String(runs), "--headless"] },
  idle: { kind: "idle", seed: true, args: (seed) => ["--session", seed.long, "--duration", "30"] },
  "startup-cold": { kind: "startup", once: true, args: (_seed, runs) => ["--cache", "cold", "--runs", String(runs), "--warmup", "1"] },
  "startup-warm": { kind: "startup", once: true, args: (_seed, runs) => ["--cache", "warm", "--runs", String(runs), "--warmup", "1"] },
  heap: { kind: "heap", seed: true, once: true, args: () => ["--count", "20"] },
  composer: { kind: "composer", seed: true, args: (seed) => ["--session", seed.long] },
  // Headed: frame pacing from a software compositor says nothing about a
  // user's frames. Opens a visible window.
  toggle: { kind: "toggle", seed: true, once: true, args: (_seed, runs) => ["--title", "perf: long 120", "--count", String(runs)] },
  "toggle-short": { kind: "toggle", seed: true, once: true, args: (_seed, runs) => ["--title", "perf: short A", "--count", String(runs)] },
  // The full-width context surface: wide enough to re-wrap the transcript.
  "toggle-context": { kind: "toggle", seed: true, once: true, args: (_seed, runs) => ["--title", "perf: long 120", "--surface", "context", "--count", String(runs)] },
}

const SCRIPTS = {
  session: "scripts/profile-session.mjs",
  switch: "scripts/profile-switch.mjs",
  idle: "scripts/profile-idle.mjs",
  startup: "scripts/profile-startup.mjs",
  heap: "scripts/profile-heap.mjs",
  composer: "scripts/profile-composer.mjs",
  toggle: "scripts/profile-toggle.mjs",
}

const parseArgs = (argv) => {
  const options = {
    before: "HEAD", after: null, scenarios: ["stream", "code", "agent", "switch", "idle"], runs: 5, rounds: 1, build: "prod",
    renderProbe: false, saveTrace: false, forceAccessibility: false, root: join(REPO_ROOT, "tmp/perf-compare"), output: null, port: 4799, fixturePort: 4798,
    opencodeBinary: undefined, dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP.replace("<SCENARIOS>", Object.keys(SCENARIOS).join(", "))); process.exit(0) }
    else if (value === "--before") options.before = argv[++index]
    else if (value === "--after") options.after = argv[++index]
    else if (value === "--scenarios") options.scenarios = String(argv[++index]).split(",").map((name) => name.trim()).filter(Boolean)
    else if (value === "--runs") options.runs = Number(argv[++index])
    else if (value === "--rounds") options.rounds = Number(argv[++index])
    else if (value === "--build") options.build = argv[++index]
    else if (value === "--render-probe") options.renderProbe = true
    else if (value === "--save-trace") options.saveTrace = true
    else if (value === "--force-accessibility") options.forceAccessibility = true
    else if (value === "--root") options.root = resolve(argv[++index])
    else if (value === "--output") options.output = resolve(argv[++index])
    else if (value === "--port") options.port = Number(argv[++index])
    else if (value === "--fixture-port") options.fixturePort = Number(argv[++index])
    else if (value === "--opencode-binary") options.opencodeBinary = resolve(argv[++index])
    else if (value === "--dry-run") options.dryRun = true
    else throw new Error(`Unknown option: ${value}`)
  }
  const unknown = options.scenarios.filter((name) => !SCENARIOS[name])
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}. Available: ${Object.keys(SCENARIOS).join(", ")}`)
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer")
  if (!Number.isInteger(options.rounds) || options.rounds < 1) throw new Error("--rounds must be a positive integer")
  if (!["prod", "diag"].includes(options.build)) throw new Error("--build is prod or diag")
  options.output = options.output ?? join(options.root, "results")
  return options
}

const git = (args, { cwd = REPO_ROOT, input, encoding = "utf8" } = {}) => execFileSync("git", args, { cwd, input, encoding, maxBuffer: 1024 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })

// Fixed prefixes and no external diff tools, whatever the user's git config says.
const diffHead = (cwd) => git(["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "diff", "HEAD", "--binary", "--no-color", "--no-ext-diff"], { cwd, encoding: "buffer" })

const untrackedFiles = (cwd) => git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }).split("\0").filter(Boolean).sort()

/**
 * What one side builds: a commit, or the working tree (the commit plus its
 * uncommitted diff and untracked files), with a hash over all of it.
 */
const resolveSource = (ref) => {
  if (ref) {
    const commit = git(["rev-parse", "--verify", `${ref}^{commit}`]).trim()
    return { label: ref, commit, patch: null, untracked: [], hash: commit }
  }
  const commit = git(["rev-parse", "HEAD"]).trim()
  const patch = diffHead(REPO_ROOT)
  const untracked = untrackedFiles(REPO_ROOT)
  const hash = createHash("sha256").update(commit).update(patch)
  for (const file of untracked) hash.update(`\0${file}\0`).update(readFileSync(join(REPO_ROOT, file)))
  return { label: "working tree", commit, patch, untracked, hash: hash.digest("hex").slice(0, 16) }
}

/** Throws unless `worktree` holds exactly `source`. */
const verifyWorktree = (worktree, source) => {
  const head = git(["rev-parse", "HEAD"], { cwd: worktree }).trim()
  if (head !== source.commit) throw new Error(`${worktree} is at ${head}, expected ${source.commit}`)
  const patch = diffHead(worktree)
  if (!patch.equals(source.patch ?? Buffer.alloc(0))) throw new Error(`${worktree} differs from ${source.label} in tracked files`)
  if (!source.patch) return
  const copied = untrackedFiles(worktree)
  const expected = source.untracked
  if (copied.join("\0") !== expected.join("\0")) throw new Error(`${worktree} has untracked files ${copied.length}, the checkout ${expected.length}`)
  for (const file of expected) {
    if (!readFileSync(join(worktree, file)).equals(readFileSync(join(REPO_ROOT, file)))) throw new Error(`${worktree}/${file} differs from the checkout`)
  }
}

const copyUntracked = (worktree, files) => {
  for (const file of files) {
    const from = join(REPO_ROOT, file)
    const to = join(worktree, file)
    mkdirSync(dirname(to), { recursive: true })
    const info = lstatSync(from)
    if (info.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else { copyFileSync(from, to); chmodSync(to, info.mode) }
  }
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null)

const niceCommand = (command, args) => (platform() === "win32" ? [command, args] : ["nice", ["-n", "10", command, ...args]])

/** Runs a command to completion with its output in `log`; resolves its exit code. */
const runLogged = (command, args, { cwd = REPO_ROOT, env = isolatedEnv(), log }) => new Promise((resolveRun, reject) => {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, "a")
  const [niced, nicedArgs] = niceCommand(command, args)
  const child = spawn(niced, nicedArgs, { cwd, env, stdio: ["ignore", fd, fd] })
  child.on("error", reject)
  child.on("close", (code) => resolveRun(code ?? 1))
})

const runOrThrow = async (description, command, args, options) => {
  console.log(`  ${description} (log: ${options.log})`)
  const code = await runLogged(command, args, options)
  if (code !== 0) throw new Error(`${description} failed with exit code ${code}; see ${options.log}`)
}

const distFor = (worktree, build) => (build === "diag" ? join(worktree, "tmp/web-dist-diag") : join(worktree, "packages/web/dist"))

/** Creates or reuses the side's worktree and build; returns the dist to serve. */
const prepareSide = async (side, source, options) => {
  const worktree = join(options.root, "worktrees", side)
  const stampFile = join(options.root, "stamps", `${side}.json`)
  const stamp = readJson(stampFile)
  const dist = distFor(worktree, options.build)
  const reusable = stamp?.hash === source.hash && existsSync(worktree)
  const builtFor = stamp?.builds?.[options.build]
  const assets = join(dist, "assets")
  const needsBuild = !reusable || builtFor !== source.hash || !existsSync(join(dist, "index.html")) || (options.build === "prod" && (!existsSync(assets) || !readdirSync(assets).some((file) => file.endsWith(".js.map"))))
  if (options.dryRun) {
    console.log(`${side}: ${source.label} @ ${source.commit.slice(0, 9)}${source.patch ? ` + ${source.patch.length} bytes of diff + ${source.untracked.length} untracked files` : ""} (source ${source.hash})`)
    console.log(`  worktree ${worktree}: ${reusable ? "reuse" : existsSync(worktree) ? "recreate" : "create"}; ${options.build} build: ${needsBuild ? "build" : "up to date"} -> ${dist}`)
    return { worktree, dist }
  }
  const logs = join(options.root, "logs")
  if (!reusable) {
    if (existsSync(worktree)) {
      if (!stamp) throw new Error(`${worktree} exists but was not created by profile:compare; remove it or pass another --root.`)
      console.log(`  Removing the stale ${side} worktree (built from ${stamp.hash}).`)
      git(["worktree", "remove", "--force", worktree])
    }
    mkdirSync(dirname(worktree), { recursive: true })
    git(["worktree", "add", "--detach", worktree, source.commit])
    // --index: files the diff adds must be tracked there too, as they are here.
    if (source.patch?.length) git(["apply", "--binary", "--index"], { cwd: worktree, input: source.patch })
    copyUntracked(worktree, source.untracked)
    mkdirSync(dirname(stampFile), { recursive: true })
    writeFileSync(stampFile, JSON.stringify({ hash: source.hash, commit: source.commit, builds: {} }, null, 2))
  }
  verifyWorktree(worktree, source)
  console.log(`${side}: ${worktree} verified identical to ${source.label} (${source.hash}).`)
  if (!needsBuild) return { worktree, dist }
  if (!existsSync(join(worktree, "node_modules"))) await runOrThrow(`${side}: bun install`, "bun", ["install", "--frozen-lockfile"], { cwd: worktree, log: join(logs, `${side}-install.log`) })
  const web = join(worktree, "packages/web")
  const env = isolatedEnv({ NODE_OPTIONS: "--max-old-space-size=6144" })
  if (options.build === "prod") {
    await runOrThrow(`${side}: production build`, "bun", ["run", "build", "--sourcemap", "hidden"], { cwd: web, env, log: join(logs, `${side}-build-prod.log`) })
  } else {
    // An older commit predates the diagnostic config; it is a build tool, not app code.
    if (!existsSync(join(web, "vite.diag.config.ts"))) copyFileSync(join(REPO_ROOT, "packages/web/vite.diag.config.ts"), join(web, "vite.diag.config.ts"))
    if (existsSync(join(worktree, "scripts/build-builtin-extensions.mjs"))) {
      await runOrThrow(`${side}: builtin extensions`, "bun", ["../../scripts/build-builtin-extensions.mjs"], { cwd: web, env, log: join(logs, `${side}-build-diag.log`) })
    }
    await runOrThrow(`${side}: diagnostic build`, "bun", ["x", "vite", "build", "--config", "vite.diag.config.ts"], { cwd: web, env, log: join(logs, `${side}-build-diag.log`) })
  }
  const updated = readJson(stampFile)
  writeFileSync(stampFile, JSON.stringify({ ...updated, builds: { ...updated.builds, [options.build]: source.hash } }, null, 2))
  return { worktree, dist }
}

/** Builds the seeded server state once: a 120-turn session and three short ones. */
const ensureSeed = async ({ options, paths, before }) => {
  const seedFile = join(paths.seed, "seed.json")
  const existing = readJson(seedFile)
  if (existing) {
    if (existing.project !== paths.project) throw new Error(`The seed in ${paths.seed} belongs to project ${existing.project}; delete it to reseed.`)
    return existing
  }
  console.log("Seeding server state (one long and three short sessions); this runs once per --root.")
  restoreState(paths.state, null)
  const server = await startIsolatedServer({ repo: before.worktree, dist: before.dist, state: paths.state, project: paths.project, port: options.port, fixturePort: options.fixturePort, opencodeBinary: options.opencodeBinary, logFile: join(options.root, "logs", "seed-server.log") })
  const seed = { project: paths.project, long: null, short: [] }
  try {
    const seedSession = async (turns, title) => {
      const log = join(options.root, "logs", `seed-${title.replace(/\W+/g, "-")}.log`)
      await runOrThrow(`seed "${title}"`, process.execPath, ["scripts/perf/seed-long-session.mjs", "--port", String(options.port), "--dir", paths.project, "--turns", String(turns), "--title", title, "--json"], { log })
      const line = readFileSync(log, "utf8").trim().split("\n").reverse().find((entry) => entry.startsWith("{"))
      const sessionId = line ? JSON.parse(line).sessionId : null
      if (!sessionId) throw new Error(`Seeding "${title}" printed no session id; see ${log}`)
      return sessionId
    }
    seed.long = await seedSession(120, "perf: long 120")
    for (const name of ["A", "B", "C"]) seed.short.push(await seedSession(8, `perf: short ${name}`))
  } finally {
    await server.stop()
  }
  rmSync(paths.seed, { recursive: true, force: true })
  cpSync(paths.state, paths.seed, { recursive: true })
  writeFileSync(seedFile, JSON.stringify(seed, null, 2))
  return seed
}

const hasSummary = (directory) => existsSync(directory) && readdirSync(directory).some((name) => name.endsWith("-summary.json"))

/** The command line of one scenario run against `url`. */
const scenarioCommand = ({ name, scenario, seed, options, paths, side, url, output }) => {
  const chrome = join(paths.chrome, `${side}-${scenario.kind}`)
  const common = scenario.kind === "startup" ? ["--url", `${url}/`, "--home", chrome] : ["--url", url, "--profile-dir", chrome]
  const extra = []
  if (scenario.kind === "session") extra.push("--dir", paths.project)
  if (options.renderProbe && ["session", "switch", "idle", "toggle"].includes(scenario.kind) && !scenario.uninstrumented) extra.push("--render-probe")
  if (options.saveTrace && scenario.kind === "session" && !scenario.uninstrumented) extra.push("--save-trace")
  if (options.forceAccessibility && ["session", "switch", "toggle"].includes(scenario.kind)) extra.push("--force-accessibility")
  return [SCRIPTS[scenario.kind], ...common, ...extra, ...scenario.args(seed, options.runs), "--output", output, "--label", `${side} ${name}`]
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const sources = { before: resolveSource(options.before), after: resolveSource(options.after) }
  const unchanged = (source) => !source.patch?.length && source.untracked.length === 0
  if (sources.before.commit === sources.after.commit && unchanged(sources.before) && unchanged(sources.after)) console.warn("Note: before and after are the same source. This is an A/A run: it measures run-to-run noise.")
  const paths = {
    project: join(options.root, "project"),
    state: join(options.root, "state"),
    seed: join(options.root, "seed"),
    chrome: join(options.root, "chrome"),
  }
  const selected = options.scenarios.map((name) => [name, SCENARIOS[name]])
  const needsSeed = selected.some(([, scenario]) => scenario.seed)

  const sides = {}
  for (const side of ["before", "after"]) sides[side] = await prepareSide(side, sources[side], options)

  if (options.dryRun) {
    const seed = readJson(join(paths.seed, "seed.json")) ?? { long: "<long session id>", short: [] }
    console.log(`\nSeed: ${needsSeed ? (existsSync(join(paths.seed, "seed.json")) ? `reuse ${paths.seed}` : "create on the before build") : "not needed"}`)
    console.log(`Server: port ${options.port}, fixture ${options.fixturePort}, project ${paths.project}`)
    console.log(`Rounds: ${options.rounds}, each before then after. Per side and round:`)
    for (const [name, scenario] of selected) {
      const output = join(options.output, "<side>", `${name}-<n>`)
      console.log(`  ${scenario.once ? "1x" : `${options.runs}x`} node ${scenarioCommand({ name, scenario, seed, options, paths, side: "<side>", url: `http://127.0.0.1:${options.port}`, output }).join(" ")}`)
    }
    console.log(`\nResults: ${options.output}`)
    return
  }

  mkdirSync(options.output, { recursive: true })
  const metaFile = join(options.output, "sources.json")
  const meta = { before: { ref: sources.before.label, commit: sources.before.commit, hash: sources.before.hash }, after: { ref: sources.after.label, commit: sources.after.commit, hash: sources.after.hash }, build: options.build }
  // Only when on, so result directories from before this option still resume.
  if (options.forceAccessibility) meta.forceAccessibility = true
  const previous = readJson(metaFile)
  if (previous && JSON.stringify({ ...previous, recordedAt: undefined }) !== JSON.stringify({ ...meta, recordedAt: undefined })) {
    throw new Error(`${options.output} holds results for other sources, another build or another accessibility setting (${metaFile}); pass a new --output or delete it.`)
  }
  writeFileSync(metaFile, JSON.stringify({ ...meta, recordedAt: previous?.recordedAt ?? new Date().toISOString() }, null, 2))

  ensureProject(paths.project)
  const fixture = await startFixture({ port: options.fixturePort, logFile: join(options.root, "logs", "fixture.log") })
  let server = null
  const stopAll = async () => {
    if (server) await server.stop()
    server = null
    await fixture.stop()
  }
  process.once("SIGINT", () => { void stopAll().then(() => process.exit(130)) })
  try {
    const seed = needsSeed ? await ensureSeed({ options, paths, before: sides.before }) : null
    const failures = []
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const side of ["before", "after"]) {
        console.log(`\n=== Round ${round}/${options.rounds}: ${side} (${sources[side].label})`)
        restoreState(paths.state, seed ? paths.seed : null)
        // Each side gets fresh Chrome profiles: the app keeps the sidebar and
        // the last session in storage per origin, and both sides share one.
        rmSync(paths.chrome, { recursive: true, force: true })
        server = await startIsolatedServer({ repo: sides[side].worktree, dist: sides[side].dist, state: paths.state, project: paths.project, port: options.port, fixturePort: options.fixturePort, opencodeBinary: options.opencodeBinary, logFile: join(options.root, "logs", `server-${side}-${round}.log`) })
        const sideOutput = join(options.output, side)
        mkdirSync(sideOutput, { recursive: true })
        writeFileSync(join(sideOutput, `bundle-check-${round}.json`), JSON.stringify(server.bundle, null, 2))
        console.log(`  Serving ${server.bundle.served} from ${server.bundle.dist}`)
        for (const [name, scenario] of selected) {
          const count = scenario.once ? 1 : options.runs
          for (let index = 1; index <= count; index += 1) {
            const runName = `${name}-${scenario.once ? round : (round - 1) * options.runs + index}`
            const output = join(sideOutput, runName)
            if (hasSummary(output)) { console.log(`  skip ${runName} (already measured)`); continue }
            const args = scenarioCommand({ name, scenario, seed, options, paths, side, url: server.url, output })
            console.log(`  ${new Date().toTimeString().slice(0, 8)} ${runName}`)
            const code = await runLogged(process.execPath, args, { log: `${output}.log`, env: isolatedEnv({ OPENCHAMBER_DATA_DIR: join(paths.state, "oc-data") }) })
            if (code !== 0 || !hasSummary(output)) {
              failures.push(`${side}/${runName}`)
              console.warn(`  FAILED ${runName}; see ${output}.log`)
            }
          }
        }
        await server.stop()
        server = null
      }
    }
    const table = compareResultDirs(join(options.output, "before"), join(options.output, "after"), { scenarios: options.scenarios })
    writeFileSync(join(options.output, "comparison.md"), `${table}\n`)
    console.log(`\n${table}\n\nWritten to ${join(options.output, "comparison.md")}`)
    if (failures.length) {
      console.error(`\n${failures.length} run(s) failed: ${failures.join(", ")}`)
      process.exitCode = 1
    }
  } finally {
    await stopAll()
  }
}

main().catch((error) => {
  console.error(`profile:compare failed: ${error.message}`)
  process.exitCode = 1
})
