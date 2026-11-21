#!/usr/bin/env node
/**
 * Before/after measurement of a change, end to end.
 *
 * Builds the unchanged commit and the change in two worktrees and measures the
 * chosen profile:* scenarios in pairs of blocks. A block is one side served
 * from an isolated server with identical seeded state, the order alternates
 * pair by pair so machine drift lands on both sides, and a scenario stops as
 * soon as a planned look has its verdict. Timing blocks carry no sampler and no
 * full trace; one instrumented run per side explains a change that moved.
 *
 * The after worktree defaults to the working tree as it is now: HEAD plus
 * `git diff HEAD --binary` plus the untracked files, verified byte-identical
 * to the checkout before anything is built. Only the build differs between
 * the sides: the measurement scripts, the CLI and the project directory come
 * from this checkout, and the server state is restored from one seed before
 * every block. One build, one server and one Chrome run at a time. Builds run
 * under nice; measured runs never do, because Chrome inherits the priority and
 * would lose the CPU to whatever else runs on the machine.
 */

import { execFileSync, spawn } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { platform } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"

import { comparePrimary, compareResultDirs } from "./perf/compare-runs.mjs"
import { REPO_ROOT, ensureProject, isolatedEnv, restoreState, startFixture, startIsolatedServer } from "./perf/isolated-server.mjs"
import { decideLook, DEFAULT_CONFIDENCE, LOOK_CONFIDENCE, LOOKS, MIN_PAIRS, pairsNeeded } from "./perf/paired-stats.mjs"

const HELP = `Usage: bun run profile:compare -- --scenarios <list> [options]

Measures the scenarios a change can affect on a before and an after build, in
alternating pairs, and prints a table with the change per pair, its interval
and a verdict.

Sources:
  --before <ref>           Commit for the before build (default: HEAD)
  --after <ref>            Commit for the after build (default: the working
                           tree: HEAD + uncommitted changes + untracked files)

Measurement:
  --scenarios <list>       Required. Comma-separated, or "release" for the set a
                           release checks (${"<RELEASE>"}).
                           Available: ${"<SCENARIOS>"}
  --pairs <auto|n>         auto (default): stop each scenario at the first of
                           ${"<LOOKS>"} pairs that has a verdict. n: exactly n pairs,
                           no early stop. A verdict needs ${MIN_PAIRS} pairs
  --max-minutes <n>        With --pairs auto, stop at the first look after this
                           much measuring, and from 12 pairs as soon as the
                           pairs a verdict needs do not fit in it (default: 20)
  --runs <n>               Repeats inside one block for switch (reload cycles),
                           startup (launches) and toggle (close/open pairs per
                           phase) (default: 1)
  --why <auto|always|never> One instrumented run per side after the pairs: when
                           the primary metric moved, always, or never (default:
                           auto). Timings there are perturbed; it is there for
                           profile:analyze
  --build <prod|diag>      Build to serve (default: prod). diag is the
                           unminified build with source maps and store
                           notifications, for attribution only
  --render-probe           Instrumented runs carry the render probe (use with
                           --build diag for real names). Implies --why always
  --save-trace             Instrumented session runs keep trace.json; their table
                           adds frames, restyled elements, layerize and GPU rows.
                           Implies --why always
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

Results: <output>/before/<scenario>-<pair>/, <output>/after/<scenario>-<pair>/,
<output>/why/<side>/<scenario>-1/, <output>/comparison.md, and
<output>/timing.json, where the time went. Reprint the table with
node scripts/perf/compare-runs.mjs <output>/before <output>/after, with
--confidence 0.9842 after --pairs auto.`

/**
 * `args(seed, runs)` builds the scenario's options. `repeats` scenarios take
 * `--runs` as repeats inside the block. A scenario on a command that takes
 * `--timing` runs its pairs with it.
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
  switch: { kind: "switch", seed: true, repeats: true, args: (_seed, runs) => ["--title", "perf: long 120", "--title", "perf: short A", "--title", "perf: short B", "--cold-reload", "--repeat", String(runs), "--headless"] },
  idle: { kind: "idle", seed: true, args: (seed) => ["--session", seed.long, "--duration", "30"] },
  "startup-cold": { kind: "startup", repeats: true, args: (_seed, runs) => ["--cache", "cold", "--runs", String(runs), "--warmup", "1"] },
  "startup-warm": { kind: "startup", repeats: true, args: (_seed, runs) => ["--cache", "warm", "--runs", String(runs), "--warmup", "1"] },
  heap: { kind: "heap", seed: true, args: () => ["--count", "20"] },
  composer: { kind: "composer", seed: true, args: (seed) => ["--session", seed.long] },
  // Headed: frame pacing from a software compositor says nothing about a
  // user's frames. Opens a visible window.
  toggle: { kind: "toggle", seed: true, repeats: true, args: (_seed, runs) => ["--title", "perf: long 120", "--count", String(runs)] },
  "toggle-short": { kind: "toggle", seed: true, repeats: true, args: (_seed, runs) => ["--title", "perf: short A", "--count", String(runs)] },
  // The full-width context surface: wide enough to re-wrap the transcript.
  "toggle-context": { kind: "toggle", seed: true, repeats: true, args: (_seed, runs) => ["--title", "perf: long 120", "--surface", "context", "--count", String(runs)] },
}

const RELEASE_SCENARIOS = ["stream", "code", "agent", "switch", "idle"]
/** Commands with a `--timing` mode. The others record nothing that slows them. */
const TIMED_KINDS = ["session", "switch", "idle"]

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
    before: "HEAD", after: null, scenarios: [], pairs: "auto", maxMinutes: 20, runs: 1, why: "auto", build: "prod",
    renderProbe: false, saveTrace: false, forceAccessibility: false, root: join(REPO_ROOT, "tmp/perf-compare"), output: null, port: 4799, fixturePort: 4798,
    opencodeBinary: undefined, dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP.replace("<SCENARIOS>", Object.keys(SCENARIOS).join(", ")).replace("<RELEASE>", RELEASE_SCENARIOS.join(",")).replace("<LOOKS>", LOOKS.join(", "))); process.exit(0) }
    else if (value === "--before") options.before = argv[++index]
    else if (value === "--after") options.after = argv[++index]
    else if (value === "--scenarios") options.scenarios = String(argv[++index]).split(",").map((name) => name.trim()).filter(Boolean)
    else if (value === "--pairs") { const pairs = argv[++index]; options.pairs = pairs === "auto" ? pairs : Number(pairs) }
    else if (value === "--max-minutes") options.maxMinutes = Number(argv[++index])
    else if (value === "--runs") options.runs = Number(argv[++index])
    else if (value === "--why") options.why = argv[++index]
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
  if (options.scenarios.length === 0) throw new Error(`Pass --scenarios with what the change can affect, or "release". Available: ${Object.keys(SCENARIOS).join(", ")}`)
  if (options.scenarios.join() === "release") options.scenarios = RELEASE_SCENARIOS
  const unknown = options.scenarios.filter((name) => !SCENARIOS[name])
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}. Available: ${Object.keys(SCENARIOS).join(", ")}`)
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer")
  if (options.pairs !== "auto" && (!Number.isInteger(options.pairs) || options.pairs < 1)) throw new Error("--pairs is auto or a positive integer")
  if (!(options.maxMinutes > 0)) throw new Error("--max-minutes must be a positive number")
  if (!["auto", "always", "never"].includes(options.why)) throw new Error("--why is auto, always or never")
  if (options.why === "auto" && (options.renderProbe || options.saveTrace)) options.why = "always"
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
const runLogged = (command, args, { cwd = REPO_ROOT, env = isolatedEnv(), log, nice = false }) => new Promise((resolveRun, reject) => {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, "a")
  const [spawned, spawnedArgs] = nice ? niceCommand(command, args) : [command, args]
  const child = spawn(spawned, spawnedArgs, { cwd, env, stdio: ["ignore", fd, fd] })
  child.on("error", reject)
  child.on("close", (code) => resolveRun(code ?? 1))
})

const runOrThrow = async (description, command, args, options) => {
  console.log(`  ${description} (log: ${options.log})`)
  const code = await runLogged(command, args, { nice: true, ...options })
  if (code !== 0) throw new Error(`${description} failed with exit code ${code}; see ${options.log}`)
}

/** Wall time per step, written next to the results: where a compare's time went. */
const createStepLog = () => {
  const steps = []
  return {
    steps,
    time: async (step, detail, work) => {
      const startedAt = Date.now()
      try {
        return await work()
      } finally {
        steps.push({ step, detail, seconds: (Date.now() - startedAt) / 1000 })
      }
    },
  }
}

const stepTotals = (steps) => {
  const totals = new Map()
  for (const { step, seconds } of steps) {
    const entry = totals.get(step) ?? { step, count: 0, seconds: 0 }
    entry.count += 1
    entry.seconds += seconds
    totals.set(step, entry)
  }
  return [...totals.values()].map((entry) => ({ ...entry, seconds: Math.round(entry.seconds) }))
}

const distFor = (worktree, build) => (build === "diag" ? join(worktree, "tmp/web-dist-diag") : join(worktree, "packages/web/dist"))

/** Creates or reuses the side's worktree and build; returns the dist to serve. */
const prepareSide = async (side, source, options, log) => {
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
  if (!existsSync(join(worktree, "node_modules"))) await log.time("install", side, () => runOrThrow(`${side}: bun install`, "bun", ["install", "--frozen-lockfile"], { cwd: worktree, log: join(logs, `${side}-install.log`) }))
  const web = join(worktree, "packages/web")
  const env = isolatedEnv({ NODE_OPTIONS: "--max-old-space-size=6144" })
  await log.time("build", side, async () => {
    if (options.build === "prod") {
      await runOrThrow(`${side}: production build`, "bun", ["run", "build", "--sourcemap", "hidden"], { cwd: web, env, log: join(logs, `${side}-build-prod.log`) })
      return
    }
    // An older commit predates the diagnostic config; it is a build tool, not app code.
    if (!existsSync(join(web, "vite.diag.config.ts"))) copyFileSync(join(REPO_ROOT, "packages/web/vite.diag.config.ts"), join(web, "vite.diag.config.ts"))
    if (existsSync(join(worktree, "scripts/build-builtin-extensions.mjs"))) {
      await runOrThrow(`${side}: builtin extensions`, "bun", ["../../scripts/build-builtin-extensions.mjs"], { cwd: web, env, log: join(logs, `${side}-build-diag.log`) })
    }
    await runOrThrow(`${side}: diagnostic build`, "bun", ["x", "vite", "build", "--config", "vite.diag.config.ts"], { cwd: web, env, log: join(logs, `${side}-build-diag.log`) })
  })
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
const scenarioCommand = ({ name, scenario, seed, options, paths, side, url, output, timing }) => {
  const chrome = join(paths.chrome, `${side}-${scenario.kind}`)
  const common = scenario.kind === "startup" ? ["--url", `${url}/`, "--home", chrome] : ["--url", url, "--profile-dir", chrome]
  const extra = []
  if (scenario.kind === "session") extra.push("--dir", paths.project)
  const timed = timing && TIMED_KINDS.includes(scenario.kind) && !scenario.uninstrumented
  if (timed) extra.push("--timing")
  if (!timed && options.renderProbe && ["session", "switch", "idle", "toggle"].includes(scenario.kind) && !scenario.uninstrumented) extra.push("--render-probe")
  if (!timed && options.saveTrace && scenario.kind === "session" && !scenario.uninstrumented) extra.push("--save-trace")
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
  const selected = new Map(options.scenarios.map((name) => [name, SCENARIOS[name]]))
  const needsSeed = [...selected.values()].some((scenario) => scenario.seed)
  const log = createStepLog()

  const sides = {}
  for (const side of ["before", "after"]) sides[side] = await prepareSide(side, sources[side], options, log)

  const auto = options.pairs === "auto"
  const confidence = auto ? LOOK_CONFIDENCE : DEFAULT_CONFIDENCE
  const lastPair = auto ? LOOKS.at(-1) : options.pairs
  if (options.dryRun) {
    const seed = readJson(join(paths.seed, "seed.json")) ?? { long: "<long session id>", short: [] }
    console.log(`\nSeed: ${needsSeed ? (existsSync(join(paths.seed, "seed.json")) ? `reuse ${paths.seed}` : "create on the before build") : "not needed"}`)
    console.log(`Server: port ${options.port}, fixture ${options.fixturePort}, project ${paths.project}`)
    console.log(`Pairs: ${auto ? `up to ${lastPair}, stopping at the first of ${LOOKS.join(", ")} with a verdict, or at the first look after ${options.maxMinutes} minutes` : options.pairs}, order alternating. Per block:`)
    for (const [name, scenario] of selected) {
      const output = join(options.output, "<side>", `${name}-<pair>`)
      console.log(`  node ${scenarioCommand({ name, scenario, seed, options, paths, side: "<side>", url: `http://127.0.0.1:${options.port}`, output, timing: true }).join(" ")}`)
    }
    console.log(`Then ${options.why === "never" ? "no instrumented runs" : `one instrumented run per side${options.why === "auto" ? " for a scenario whose primary metric moved" : ""}`}.`)
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
    const seed = needsSeed ? await log.time("seed", "", () => ensureSeed({ options, paths, before: sides.before })) : null
    const failures = []

    /** One side served fresh, with `runs` ([name, run directory, timing]) measured on it. */
    const runBlock = async (side, label, runs) => {
      const pending = runs.filter(({ output }) => {
        if (!hasSummary(output)) return true
        console.log(`  skip ${relative(options.output, output)} (already measured)`)
        return false
      })
      if (pending.length === 0) return
      console.log(`\n=== ${label}: ${side} (${sources[side].label})`)
      restoreState(paths.state, seed ? paths.seed : null)
      // Each block gets fresh Chrome profiles: the app keeps the sidebar and
      // the last session in storage per origin, and both sides share one.
      rmSync(paths.chrome, { recursive: true, force: true })
      server = await log.time("server start", label, () => startIsolatedServer({ repo: sides[side].worktree, dist: sides[side].dist, state: paths.state, project: paths.project, port: options.port, fixturePort: options.fixturePort, opencodeBinary: options.opencodeBinary, logFile: join(options.root, "logs", `server-${side}-${label.replace(/\W+/g, "-")}.log`) }))
      const sideOutput = dirname(pending[0].output)
      mkdirSync(sideOutput, { recursive: true })
      writeFileSync(join(sideOutput, "bundle-check.json"), JSON.stringify(server.bundle, null, 2))
      console.log(`  Serving ${server.bundle.served} from ${server.bundle.dist}`)
      for (const { name, output, timing } of pending) {
        const scenario = SCENARIOS[name]
        const args = scenarioCommand({ name, scenario, seed, options, paths, side, url: server.url, output, timing })
        console.log(`  ${new Date().toTimeString().slice(0, 8)} ${relative(options.output, output)}`)
        const code = await log.time(timing ? `run ${name}` : `instrumented ${name}`, `${side} ${label}`, () => runLogged(process.execPath, args, { log: `${output}.log`, env: isolatedEnv({ OPENCHAMBER_DATA_DIR: join(paths.state, "oc-data") }) }))
        if (code !== 0 || !hasSummary(output)) {
          failures.push(relative(options.output, output))
          console.warn(`  FAILED ${relative(options.output, output)}; see ${output}.log`)
        }
      }
      await server.stop()
      server = null
    }

    const before = join(options.output, "before")
    const after = join(options.output, "after")
    const primaryOf = (name, throughPair) => comparePrimary(before, after, name, { confidence, throughPair })
    const startedAt = Date.now()
    const active = new Set(selected.keys())
    const outcomes = new Map()
    for (let pair = 1; pair <= lastPair && active.size > 0; pair += 1) {
      // A B, B A, A B: drift over the run lands on both sides.
      for (const side of pair % 2 === 1 ? ["before", "after"] : ["after", "before"]) {
        await runBlock(side, `pair ${pair}/${lastPair}`, [...active].map((name) => ({ name, output: join(options.output, side, `${name}-${pair}`), timing: true })))
      }
      if (!auto || !LOOKS.includes(pair)) continue
      const minutes = (Date.now() - startedAt) / 60_000
      const affordablePairs = Math.floor(pair * (options.maxMinutes / minutes))
      for (const name of active) {
        const { comparison } = primaryOf(name, pair) ?? {}
        const decision = decideLook(comparison, { affordablePairs })
        console.log(`Look at ${pair} pairs: ${name}: ${decision}${comparison?.direction ? ` (${comparison.direction})` : ""}`)
        if (decision === "continue" && minutes < options.maxMinutes) continue
        outcomes.set(name, decision === "done" ? decision : `no verdict at ${pair} pairs: a verdict needs about ${pairsNeeded(comparison)} at this noise, and --max-minutes ${options.maxMinutes} affords ${affordablePairs}`)
        active.delete(name)
      }
    }

    const moved = (name) => { const direction = primaryOf(name)?.comparison?.direction; return direction === "lower" || direction === "higher" }
    const explained = [...selected.keys()].filter((name) => TIMED_KINDS.includes(selected.get(name).kind) && !selected.get(name).uninstrumented && (options.why === "always" || (options.why === "auto" && moved(name))))
    if (explained.length > 0) {
      for (const side of ["before", "after"]) {
        await runBlock(side, "instrumented", explained.map((name) => ({ name, output: join(options.output, "why", side, `${name}-1`), timing: false })))
      }
    }

    const scenarios = [...selected.keys()]
    const tables = [compareResultDirs(before, after, { scenarios, confidence })]
    const notes = [...outcomes].filter(([, outcome]) => outcome !== "done").map(([name, outcome]) => `- ${name}: ${outcome}`)
    if (notes.length) tables.push(`\nNo verdict:\n${notes.join("\n")}`)
    if (explained.length > 0) tables.push(`\n## Instrumented runs, one per side\n\nTimings here are perturbed; read them with profile:analyze.\n\n${compareResultDirs(join(options.output, "why", "before"), join(options.output, "why", "after"), { scenarios: explained })}`)
    const table = tables.join("\n")
    writeFileSync(join(options.output, "comparison.md"), `${table}\n`)
    writeFileSync(join(options.output, "timing.json"), JSON.stringify({ totals: stepTotals(log.steps), steps: log.steps }, null, 2))
    console.log(`\n${table}\n\nTime: ${stepTotals(log.steps).map(({ step, count, seconds }) => `${step} ${seconds} s (${count}x)`).join(", ")}\n\nWritten to ${join(options.output, "comparison.md")}`)
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
