#!/usr/bin/env node
/**
 * Fully automated Git-panel capture for OpenChamber.
 *
 * Builds a disposable git repository with many tracked files, opens the Git
 * panel on it in a browser, and measures the actions that strain the panel:
 * the diff burst a Generate click fires, the one-request-per-path fan-out of
 * Revert All, and the staging and commit path. The fixture is the only
 * repository this command mutates, it starts its own server against that
 * fixture, and it deletes everything it created unless `--keep`.
 *
 * The evidence is per action, over a window delimited by user-timing marks:
 * request count, client peak in-flight and to-complete peak per endpoint, the
 * long-task distribution, main-thread busy time and the timeline trace
 * breakdown. A scenario whose expected requests never fired fails instead of
 * reporting a clean zero.
 */

import { execFile, spawn } from "node:child_process"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { finished } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import {
  assertActionsRunnable,
  buildFixturePlan,
  expectedRequestsForAction,
  findMissingRequests,
  parseActions,
  primaryEndpointForAction,
  summarizeTraffic,
} from "./perf/git-panel.mjs"
import { metricMap, percentile, round, summarizeLongTasks, summarizeTraceEvents } from "./perf/metrics.mjs"
import { createProcessCpuSampler, openBrowserClient, resolveServerProcesses } from "./perf/process-cpu.mjs"
import { seedContextPanel } from "./perf/scenario.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cliPath = join(repoRoot, "packages", "web", "bin", "cli.js")

// The commit message the stage-commit action types. Deterministic so successive
// captures write the same commit.
const STAGE_COMMIT_MESSAGE = "perf: git panel fixture commit"

const HELP = `Usage: bun run profile:git -- [options]

Creates a disposable git repository, opens the Git panel on it, and measures
the request bursts and main-thread work of Generate, Revert All and staging a
commit. Starts its own OpenChamber server against the fixture; nothing outside
the fixture's temporary directory is mutated, and the fixture is deleted at the
end unless --keep.

Options:
  --files <n>              Tracked committed files in the fixture (default: 200)
  --modified <n>           Working-tree modified files (default: 40)
  --staged <n>             Modified files also staged, so Generate has a staged
                           group (default: 30; cannot exceed --modified)
  --actions <list>         Actions to run, in order. Supported: generate,
                           revert-all, stage-commit. revert-all and
                           stage-commit each consume the fixture's changes,
                           so they cannot be combined in one capture.
                           (default: generate,revert-all)
  --settle <seconds>       Wait after load before measuring (default: 12)
  --tail <seconds>         Quiet time after an action's requests drain before
                           the action's window closes (default: 1.5)
  --model-wait <seconds>   How long to wait for Generate's model step after its
                           diff burst drained (default: 10). The model failing
                           is recorded as modelOutcome, not treated as a
                           capture failure; the diff burst is the evidence.
  --action-timeout <s>     Timeout for an action's expected requests and drain
                           (default: 30)
  --output <directory>     Artifact directory (default: artifacts/git-panel-<time>)
  --baseline <directory>   Compare against a previous run's git-panel-summary.json
  --budget-diff-inflight <n>   Fail when Generate's client peak in-flight
                           (request start to response headers) on
                           /api/git/diff exceeds this
  --budget-revert-inflight <n> Fail when Revert All's client peak in-flight
                           (request start to response headers) on
                           /api/git/revert exceeds this
  --budget-longest <ms>    Fail when any action's longest main-thread task
                           exceeds this
  --label <text>           Human label stored in the summary
  --keep                   Keep the fixture directory after the run
  --save-trace             Also write the raw timeline to trace.json
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Reusable isolated Chrome profile
  --headed                 Show the browser (default: headless). Headless runs
                           have no GPU, so quote process CPU only from a
                           --headed run.
  --json                   Print the summary as JSON instead of a report.
                           --baseline is ignored with --json: the delta table
                           is only printed by the text report
  --help                   Show this help

Revert All and stage-commit mutate the fixture. They run only against the
temporary repository this command created, and each consumes the modified
files the other needs: run them as separate captures.`

const parseArgs = (argv) => {
  const options = {
    files: 200,
    modified: 40,
    staged: 30,
    actions: "generate,revert-all",
    settle: 12,
    tail: 1.5,
    modelWait: 10,
    actionTimeout: 30,
    output: null,
    baseline: null,
    budgetDiffInflight: null,
    budgetRevertInflight: null,
    budgetLongest: null,
    label: null,
    keep: false,
    saveTrace: false,
    chrome: null,
    profileDir: join(homedir(), ".cache", "openchamber-perf-git-profile"),
    headless: true,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") return { ...options, help: true }
    else if (value === "--files") options.files = Number(argv[++index])
    else if (value === "--modified") options.modified = Number(argv[++index])
    else if (value === "--staged") options.staged = Number(argv[++index])
    else if (value === "--actions") options.actions = argv[++index]
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--tail") options.tail = Number(argv[++index])
    else if (value === "--model-wait") options.modelWait = Number(argv[++index])
    else if (value === "--action-timeout") options.actionTimeout = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--baseline") options.baseline = argv[++index]
    else if (value === "--budget-diff-inflight") options.budgetDiffInflight = Number(argv[++index])
    else if (value === "--budget-revert-inflight") options.budgetRevertInflight = Number(argv[++index])
    else if (value === "--budget-longest") options.budgetLongest = Number(argv[++index])
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--keep") options.keep = true
    else if (value === "--save-trace") options.saveTrace = true
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = argv[++index]
    else if (value === "--headed") options.headless = false
    else if (value === "--json") options.json = true
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isFinite(options.settle) || options.settle < 0) throw new Error("--settle must be zero or greater")
  if (!Number.isFinite(options.tail) || options.tail < 0) throw new Error("--tail must be zero or greater")
  if (!Number.isFinite(options.modelWait) || options.modelWait < 0) throw new Error("--model-wait must be zero or greater")
  if (!Number.isFinite(options.actionTimeout) || options.actionTimeout <= 0) throw new Error("--action-timeout must be a positive number")
  // An unparseable budget used to be dropped silently, which turned the gate
  // off instead of failing it.
  for (const [name, value] of [
    ["--budget-diff-inflight", options.budgetDiffInflight],
    ["--budget-revert-inflight", options.budgetRevertInflight],
    ["--budget-longest", options.budgetLongest],
  ]) {
    if (value !== null && !(Number.isFinite(value) && value > 0)) {
      throw new Error(`${name} must be a positive number`)
    }
  }
  return options
}

const waitFor = async (label, predicate, { timeoutMs, intervalMs = 250 } = {}) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await wait(intervalMs)
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`)
}

// ---------------------------------------------------------------------------
// Disposable fixture
// ---------------------------------------------------------------------------

const runGit = (cwd, args) => new Promise((resolveRun, reject) => {
  execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
    if (error) {
      reject(new Error(`git ${args[0]} failed in the fixture: ${String(stderr).trim() || error.message}`))
      return
    }
    resolveRun()
  })
})

const fixtureContent = (path, revision) => {
  const lines = [path, ...Array.from({ length: 40 }, (_, index) => `line ${index}: revision ${revision}`)]
  return `${lines.join("\n")}\n`
}

const writeFixtureFiles = async (directory, paths, revision) => {
  const chunkSize = 25
  for (let index = 0; index < paths.length; index += chunkSize) {
    const chunk = paths.slice(index, index + chunkSize)
    await Promise.all(chunk.map((path) => writeFile(join(directory, path), fixtureContent(path, revision))))
  }
}

const createFixture = async (root, plan) => {
  const directory = join(root, "fixture")
  await mkdir(directory, { recursive: true })
  // Marks the directory as created by this run, so the destructive-action guard
  // can prove provenance instead of inferring it from a path prefix.
  await writeFile(join(root, "openchamber-perf-fixture"), "")
  // The app asks the server to diff `main...HEAD`; an init that follows the
  // machine's default branch (often `master`) makes that query fail with a 500
  // before anything is measured. Pin the branch the app expects.
  await runGit(directory, ["init", "-q", "-b", "main"])
  await runGit(directory, ["config", "user.name", "OpenChamber Perf Fixture"])
  await runGit(directory, ["config", "user.email", "perf@openchamber.invalid"])
  await writeFixtureFiles(directory, plan.paths, 0)
  await runGit(directory, ["add", "--", "."])
  await runGit(directory, ["commit", "-q", "-m", "fixture: initial commit"])
  await writeFixtureFiles(directory, plan.modifiedPaths, 1)
  if (plan.stagedPaths.length > 0) {
    await runGit(directory, ["add", "--", ...plan.stagedPaths])
    // Modified again after staging, so the index and the working tree each
    // carry a diff for the staged files instead of one shadowing the other.
    await writeFixtureFiles(directory, plan.stagedPaths, 2)
  }
  console.log(`Fixture: ${plan.paths.length} tracked files, ${plan.modifiedPaths.length} modified, ${plan.stagedPaths.length} staged at ${directory}`)
  return directory
}

/** Refuses a mutating action anywhere but this run's temporary fixture. */
const assertDisposableFixture = (root, directory) => {
  const tempRoot = `${resolve(tmpdir())}/`
  if (!resolve(directory).startsWith(tempRoot)) {
    throw new Error(`Refusing to run a destructive action outside the temporary directory: ${directory}`)
  }
  if (!existsSync(join(root, "openchamber-perf-fixture"))) {
    throw new Error(`Refusing to run a destructive action: ${root} is not a fixture created by this run`)
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Isolation contract: the server this command starts is a fresh instance on
 * the fixture, never the instance already running on the machine. A developer
 * or CI shell can carry the running server's environment, and each such value
 * changes where this capture points: `OPENCODE_HOST`/`OPENCODE_PORT` make the
 * managed OpenCode attach to the running one, `OPENCODE_SERVER_PASSWORD` and
 * `OPENCHAMBER_UI_PASSWORD` make the capture server demand the running
 * instance's credentials, `OPENCHAMBER_HOST=0.0.0.0` binds it to the network,
 * `OPENCODE_CONFIG_CONTENT` injects the running instance's plugins, and
 * `OPENCHAMBER_DATA_DIR` points it at the user's real settings and sessions.
 * The child environment therefore keeps every inherited variable that is not
 * `OPENCODE_*`/`OPENCHAMBER_*` (matched case-insensitively, because Windows
 * environment names are) and adds back only the values this run owns: an
 * isolated HOME/data pair under the temporary root and an explicit loopback
 * bind. PATH survives, so the CLI still finds `opencode` and `git`.
 */
const isolatedServerEnv = ({ homeDirectory, dataDirectory }) => {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper.startsWith("OPENCODE_") || upper.startsWith("OPENCHAMBER_")) continue
    env[key] = value
  }
  return {
    ...env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: join(homeDirectory, ".config"),
    XDG_CACHE_HOME: join(homeDirectory, ".cache"),
    XDG_DATA_HOME: join(homeDirectory, ".local", "share"),
    OPENCHAMBER_DATA_DIR: dataDirectory,
    // Pinned here and passed as --host below; both name loopback explicitly so
    // no inherited value can move the capture server off it.
    OPENCHAMBER_HOST: "127.0.0.1",
  }
}

const startServer = ({ cwd, homeDirectory, dataDirectory, port, logPath }) => {
  const log = createWriteStream(logPath)
  const child = spawn(
    process.execPath,
    [cliPath, "serve", "--port", String(port), "--host", "127.0.0.1", "--foreground"],
    {
      cwd,
      env: isolatedServerEnv({ homeDirectory, dataDirectory }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  return child
}

const waitForServer = async (child, url, logPath, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenChamber server exited with code ${child.exitCode} before becoming ready; log: ${logPath}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await wait(250)
  }
  throw new Error(`OpenChamber server did not become ready at ${url}: ${lastError?.message ?? "no response"}; log: ${logPath}`)
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Stops one process this run spawned: SIGTERM, a bounded wait for the actual
 * exit, then SIGKILL to that same PID when it is still alive. Only a child
 * handle this run owns is signalled — never a name-, port- or process-group
 * sweep — so an unrelated instance that happens to share a binary or port is
 * never touched. Waiting for the exit before returning keeps the temporary
 * root from being removed out from under a process that is still writing to
 * it, which is what happened when the removal followed SIGTERM immediately.
 */
const terminateChild = async (child, label, { timeoutMs = 10_000, killWaitMs = 2_000 } = {}) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
  child.kill("SIGTERM")
  const exitedAfterTerm = await Promise.race([exited.then(() => true), wait(timeoutMs).then(() => false)])
  if (exitedAfterTerm) return
  console.warn(`${label} (pid ${child.pid}) is still running ${timeoutMs / 1000}s after SIGTERM; sending SIGKILL`)
  child.kill("SIGKILL")
  await Promise.race([exited, wait(killWaitMs)])
}

// ---------------------------------------------------------------------------
// Reading and driving the Git panel
// ---------------------------------------------------------------------------

const byAria = (label) => `(entry.getAttribute("aria-label") || "") === ${JSON.stringify(label)}`
const byText = (text) => `(entry.textContent || "").trim() === ${JSON.stringify(text)}`

const clickButton = async (client, matcher, label) => {
  const result = await evaluateValue(client, `(() => {
    const button = [...document.querySelectorAll("button")].find((entry) => ${matcher})
    if (!button) return { clicked: false, reason: "not on screen" }
    if (button.disabled) return { clicked: false, reason: "disabled" }
    button.click()
    return { clicked: true }
  })()`)
  if (!result?.clicked) throw new Error(`Could not click ${label}: ${result?.reason ?? "unknown reason"}`)
}

const readCommitControls = async (client) => JSON.parse(await evaluateValue(client, `JSON.stringify((() => {
  const generate = document.querySelector('button[aria-label="Generate commit message"]')
  const textarea = document.querySelector('textarea[placeholder="Commit message"]')
  const commit = [...document.querySelectorAll("button")].find((entry) => (entry.textContent || "").trim() === "Commit")
  return {
    generatePresent: Boolean(generate),
    generateEnabled: generate ? !generate.disabled : null,
    generateLoading: generate ? Boolean(generate.querySelector(".animate-spin")) : false,
    commitFieldPresent: Boolean(textarea),
    commitEnabled: commit ? !commit.disabled : null,
  }
})())`) ?? "{}")

const readPanelState = async (client, plan) => JSON.parse(await evaluateValue(client, `JSON.stringify((() => {
  const path = ${JSON.stringify(plan.modifiedPaths[0] ?? plan.paths[0] ?? null)}
  const generate = document.querySelector('button[aria-label="Generate commit message"]')
  return {
    activeDirectory: localStorage.getItem("lastDirectory"),
    changedRowVisible: path !== null && [...document.querySelectorAll("[title]")].some((entry) => entry.getAttribute("title") === path),
    generatePresent: Boolean(generate),
    generateEnabled: generate ? !generate.disabled : null,
    revertAllVisible: [...document.querySelectorAll("button")].some((entry) => (entry.textContent || "").trim() === "Revert all"),
  }
})())`) ?? "{}")

const markAction = (client, action, edge) => evaluateValue(client, `performance.mark(${JSON.stringify(`git-panel:${action}:${edge}`)})`)

// ---------------------------------------------------------------------------
// Action drivers
// ---------------------------------------------------------------------------

const countSince = (state, endpoint) => state.requests
  .slice(state.actionRequestStart)
  .filter((entry) => entry.endpoint === endpoint)
  .length

const inFlight = (state, endpoint) => state.inFlight.get(endpoint) ?? 0

const observeModelOutcome = async (client, state) => {
  const readMessage = async () => {
    const controls = await readCommitControls(client)
    return controls.commitFieldPresent
      ? await evaluateValue(client, `document.querySelector('textarea[placeholder="Commit message"]')?.value ?? ""`)
      : ""
  }
  if (state.options.modelWait <= 0) {
    const message = await readMessage()
    return { outcome: message.length > 0 ? "message" : "not-waited", messageLength: message.length }
  }
  const deadline = Date.now() + state.options.modelWait * 1000
  while (Date.now() < deadline) {
    const message = await readMessage()
    if (message.length > 0) return { outcome: "message", messageLength: message.length }
    if (!(await readCommitControls(client)).generateLoading) return { outcome: "failed", messageLength: 0 }
    await wait(250)
  }
  const message = await readMessage()
  return { outcome: "timeout", messageLength: message.length }
}

const driveGenerate = async (client, state) => {
  const controls = await readCommitControls(client)
  if (!controls.generatePresent) throw new Error("the Generate button is not on screen")
  if (!controls.generateEnabled) {
    throw new Error("the Generate button is disabled: the fixture has no staged changes left (run generate before revert-all or stage-commit, or raise --staged)")
  }
  const expectedDiff = expectedRequestsForAction("generate", state.plan)["/api/git/diff"]
  const timeoutMs = state.options.actionTimeout * 1000
  await clickButton(client, byAria("Generate commit message"), "Generate commit message")
  await waitFor(
    `${expectedDiff} /api/git/diff request(s) from Generate`,
    async () => countSince(state, "/api/git/diff") >= expectedDiff,
    { timeoutMs, intervalMs: 100 },
  )
  await waitFor(
    "Generate's diff burst to drain",
    async () => inFlight(state, "/api/git/diff") === 0,
    { timeoutMs, intervalMs: 50 },
  )
  // The model step that follows the burst is not the evidence and may have no
  // provider configured; it is recorded, never allowed to fail the capture.
  const modelOutcome = await observeModelOutcome(client, state)
  return { modelOutcome }
}

const driveRevertAll = async (client, state) => {
  assertDisposableFixture(state.root, state.fixtureDirectory)
  const expectedReverts = expectedRequestsForAction("revert-all", state.plan)["/api/git/revert"]
  const timeoutMs = state.options.actionTimeout * 1000
  await clickButton(client, byText("Revert all"), "Revert all")
  await waitFor(
    "the Revert All confirmation dialog",
    async () => Boolean(await evaluateValue(client, `document.querySelector('[data-slot="dialog-content"]') !== null`)),
    { timeoutMs: 10_000, intervalMs: 100 },
  )
  await clickButton(
    client,
    `${byText("Revert all")} && entry.closest('[data-slot="dialog-content"]') !== null`,
    "Revert all (confirm)",
  )
  await waitFor(
    `${expectedReverts} /api/git/revert request(s)`,
    async () => countSince(state, "/api/git/revert") >= expectedReverts,
    { timeoutMs, intervalMs: 100 },
  )
  await waitFor(
    "the revert fan-out to drain",
    async () => inFlight(state, "/api/git/revert") === 0,
    { timeoutMs, intervalMs: 100 },
  )
  return {}
}

const driveStageCommit = async (client, state) => {
  assertDisposableFixture(state.root, state.fixtureDirectory)
  const timeoutMs = state.options.actionTimeout * 1000
  const expected = expectedRequestsForAction("stage-commit", state.plan)
  if (expected["/api/git/stage"]) {
    const stageAllPresent = await evaluateValue(client, `[...document.querySelectorAll("button")].some((entry) => (entry.getAttribute("aria-label") || "") === "Stage all changes")`)
    if (!stageAllPresent) {
      throw new Error("the Stage all control is not on screen: no unstaged changes remain (does revert-all run before stage-commit?)")
    }
    await clickButton(client, byAria("Stage all changes"), "Stage all changes")
    await waitFor("the stage request", async () => countSince(state, "/api/git/stage") >= 1, { timeoutMs, intervalMs: 100 })
    await waitFor("the stage request to drain", async () => inFlight(state, "/api/git/stage") === 0, { timeoutMs, intervalMs: 100 })
    await wait(500)
  }
  const typed = await evaluateValue(client, `(() => {
    const textarea = document.querySelector('textarea[placeholder="Commit message"]')
    if (!textarea) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set
    setter.call(textarea, ${JSON.stringify(STAGE_COMMIT_MESSAGE)})
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  })()`)
  if (!typed) throw new Error("the commit message field is not on screen")
  await waitFor(
    "the Commit button to enable",
    async () => (await readCommitControls(client)).commitEnabled === true,
    { timeoutMs: 10_000, intervalMs: 100 },
  )
  await clickButton(client, byText("Commit"), "Commit")
  await waitFor("the commit request", async () => countSince(state, "/api/git/commit") >= 1, { timeoutMs, intervalMs: 100 })
  await waitFor("the commit to finish", async () => inFlight(state, "/api/git/commit") === 0, { timeoutMs, intervalMs: 100 })
  return {}
}

const DRIVERS = {
  "generate": driveGenerate,
  "revert-all": driveRevertAll,
  "stage-commit": driveStageCommit,
}

const runAction = async (client, state, action) => {
  const before = metricMap((await client.send("Performance.getMetrics")).metrics)
  await state.processCpu.sample()
  state.actionRequestStart = state.requests.length
  const startedAt = Date.now()
  await markAction(client, action, "start")
  let driverResult = {}
  let error = null
  try {
    driverResult = await DRIVERS[action](client, state)
  } catch (driveError) {
    error = driveError instanceof Error ? driveError.message : String(driveError)
  }
  if (error === null && state.options.tail > 0) await wait(state.options.tail * 1000)
  await markAction(client, action, "end")
  const windowSeconds = round((Date.now() - startedAt) / 1000)
  const after = metricMap((await client.send("Performance.getMetrics")).metrics)
  await state.processCpu.sample()

  const delta = (name) => Number(after[name] ?? 0) - Number(before[name] ?? 0)
  const slice = state.requests.slice(state.actionRequestStart).map((entry) => ({
    // A request still in flight when the window closed would otherwise look
    // instantaneous; clamps it to the last observed monotonic timestamp so the
    // peak keeps counting it.
    ...entry,
    endedAt: entry.endedAt ?? state.lastMonotonic,
  }))
  const requests = summarizeTraffic(slice)
  const record = {
    action,
    windowSeconds,
    requests,
    expectedRequests: expectedRequestsForAction(action, state.plan),
    primaryEndpoint: primaryEndpointForAction(action),
    metrics: {
      mainThreadBusyMs: round(delta("TaskDuration") * 1000),
      mainThreadBusyPercent: windowSeconds > 0 ? round((delta("TaskDuration") / windowSeconds) * 100) : 0,
      scriptMs: round(delta("ScriptDuration") * 1000),
      recalcStyleMs: round(delta("RecalcStyleDuration") * 1000),
      layoutMs: round(delta("LayoutDuration") * 1000),
      taskCount: delta("TaskCount"),
    },
    longTasks: null,
    traceBreakdown: [],
    ...driverResult,
  }
  if (error !== null) record.error = error
  return record
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const endpointSummary = (requests, limit = 4) => Object.entries(requests.byEndpoint)
  .sort((left, right) => right[1].count - left[1].count)
  .slice(0, limit)
  .map(([endpoint, bucket]) => `${endpoint.replace("/api/git/", "")}=${bucket.count}`)
  .join(" ")

/** JSON.parse output only: plain objects pass; null, arrays and primitives do not. */
const isJsonObject = (value) => value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype

/**
 * Reads the baseline summary the delta table compares against. A file that is
 * not a profile:git summary — unreadable, not JSON, `null`, or missing its
 * fixture or actions — is reported as such; the comparison below would
 * otherwise fail later inside the table with a raw TypeError.
 */
const readBaselineSummary = async (directory) => {
  const summaryPath = join(resolve(directory), "git-panel-summary.json")
  let raw
  try {
    raw = await readFile(summaryPath, "utf8")
  } catch (error) {
    throw new Error(`Could not read the baseline summary at ${summaryPath}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Malformed baseline summary at ${summaryPath}: ${error.message}`)
  }
  const wellFormed = isJsonObject(parsed)
    && isJsonObject(parsed.fixture)
    && Array.isArray(parsed.actions)
    && parsed.actions.every((entry) => isJsonObject(entry))
  if (!wellFormed) {
    throw new Error(`Malformed baseline summary at ${summaryPath}: expected a profile:git git-panel-summary.json with fixture and actions fields`)
  }
  return parsed
}

/**
 * The delta table compares two runs of the same scenario; a baseline captured
 * at another scale or with other actions is not a comparison, so the run says
 * so instead of printing a misleading delta.
 */
const baselineScenarioMismatches = (baseline, plan, actions) => {
  const mismatches = []
  // A summary field that is not a number is "not compared", so an older or
  // malformed baseline cannot fabricate a mismatch.
  const compareCount = (label, previous, current) => {
    if (Number.isFinite(previous) && previous !== current) mismatches.push(`${label} ${previous} vs ${current}`)
  }
  const fixture = baseline.fixture ?? {}
  compareCount("tracked files", fixture.trackedFiles, plan.paths.length)
  compareCount("modified files", fixture.modifiedFiles, plan.modifiedPaths.length)
  compareCount("staged files", fixture.stagedFiles, plan.stagedPaths.length)
  if (Array.isArray(baseline.actions)) {
    const previousActions = baseline.actions.map((entry) => entry?.action).filter(Boolean).join(",")
    if (previousActions !== actions.join(",")) mismatches.push(`actions ${previousActions || "(none)"} vs ${actions.join(",")}`)
  }
  return mismatches.length > 0
    ? [`the baseline scenario differs from this run (${mismatches.join("; ")}); the methodology requires an identical scenario`]
    : []
}

const printReport = (summary, baseline) => {
  console.log(`\nGit panel capture — ${summary.fixture.trackedFiles} tracked files, ${summary.fixture.modifiedFiles} modified, ${summary.fixture.stagedFiles} staged`)
  if (summary.label) console.log(`Label: ${summary.label}`)
  for (const entry of summary.actions) {
    if (entry.error) {
      console.log(`${entry.action.padEnd(13)} FAILED after ${entry.windowSeconds}s: ${entry.error}`)
      continue
    }
    const endpoint = entry.requests.byEndpoint[entry.primaryEndpoint]
    const peak = endpoint?.peakInFlight ?? 0
    const peakToComplete = endpoint?.peakInFlightToComplete ?? 0
    const longest = entry.longTasks?.longestTaskMs ?? null
    console.log(
      `${entry.action.padEnd(13)} window ${String(entry.windowSeconds).padStart(5)}s`
      + ` · requests ${String(entry.requests.total).padStart(3)} (${endpointSummary(entry.requests)})`
      + ` · peak ${entry.primaryEndpoint.replace("/api/git/", "")} ${peak} client`
      + ` (${peakToComplete} to complete)`
      + ` · longest task ${longest === null ? "n/a" : `${longest}ms`}`
      + ` · busy ${entry.metrics.mainThreadBusyPercent}%`,
    )
    const failedEndpoints = Object.entries(entry.requests.byEndpoint).filter(([, bucket]) => bucket.failed > 0)
    if (failedEndpoints.length > 0) {
      console.log(`              failed: ${failedEndpoints.map(([name, bucket]) => `${name.replace("/api/git/", "")}=${bucket.failed}`).join(" ")}`)
    }
    if (entry.modelOutcome) {
      console.log(`              model: ${entry.modelOutcome.outcome}${entry.modelOutcome.messageLength ? ` (${entry.modelOutcome.messageLength} chars)` : ""}`)
    }
    const trace = entry.traceBreakdown.slice(0, 3).map((event) => `${event.name}=${event.totalMs}ms`).join(" ")
    if (trace) console.log(`              trace: ${trace}`)
    if (entry.longTasks) {
      console.log(`              long tasks: ${entry.longTasks.longTaskCount}/${entry.longTasks.taskCount} over ${entry.longTasks.longTaskTotalMs}ms (p95 ${entry.longTasks.taskP95Ms}ms)`)
    }
  }
  const cpu = summary.processCpu
  if (cpu) {
    console.log(`\nProcess CPU: total average ${cpu.totalAveragePercent}% of one core (p90 ${cpu.totalP90Percent}%, max ${cpu.totalMaxPercent}%)`)
    console.log(`  server processes resolved: ${cpu.serverProcessesResolved}${cpu.serverProcessesResolved === 0 ? " (lsof/pgrep unavailable; server CPU is missing, not zero)" : ""}`)
    for (const entry of cpu.processes?.slice(0, 8) ?? []) console.log(`    ${entry.label.padEnd(24)} avg ${entry.averagePercent}%  max ${entry.maxPercent}%`)
  }
  const frames = summary.frameLiveness?.framesPerSecond
  if (frames !== undefined) console.log(`\nFrame liveness: ${frames} frames/s (visibility: ${summary.frameLiveness.visibilityState})`)
  if (!summary.headless) console.log("Headed run: process CPU is the figure a user sees.")
  else console.log("Headless run: process CPU is not user-representative; quote it only from a --headed run.")

  if (baseline) {
    const rows = []
    for (const entry of summary.actions) {
      const previous = (baseline.actions ?? []).find((candidate) => candidate.action === entry.action)
      if (!previous || entry.error) continue
      const endpointName = entry.primaryEndpoint.replace("/api/git/", "")
      const endpoint = entry.requests.byEndpoint[entry.primaryEndpoint]
      const previousEndpoint = previous.requests?.byEndpoint?.[previous.primaryEndpoint ?? entry.primaryEndpoint]
      const metrics = [
        ["requests", entry.requests.total, previous.requests?.total],
        [`peak ${endpointName} (client)`, endpoint?.peakInFlight ?? 0, previousEndpoint?.peakInFlight ?? 0],
        ["longest task (ms)", entry.longTasks?.longestTaskMs ?? 0, previous.longTasks?.longestTaskMs ?? 0],
        ["busy (%)", entry.metrics.mainThreadBusyPercent, previous.metrics?.mainThreadBusyPercent],
        ["window (s)", entry.windowSeconds, previous.windowSeconds],
      ]
      // Summaries written before the client/to-complete split carry no
      // to-complete peak; omitting the row says "not compared" where a 0
      // would read as a measurement.
      if (previousEndpoint?.peakInFlightToComplete !== undefined) {
        metrics.splice(2, 0, [`peak ${endpointName} (to complete)`, endpoint?.peakInFlightToComplete ?? 0, previousEndpoint.peakInFlightToComplete])
      }
      for (const [metric, current, before] of metrics) {
        if (current === undefined || before === undefined) continue
        rows.push({ action: entry.action, metric, baseline: before, current, delta: round(current - before) })
      }
    }
    console.log("")
    console.table(rows)
  }
}

const evaluateBudgets = (summary, options) => {
  const failures = []
  const actionOf = (name) => summary.actions.find((entry) => entry.action === name)
  // The budgets gate the client-concurrency peak (request start to response
  // headers), the figure a mapper's concurrency limit bounds. The to-complete
  // peak stays diagnostic: an unread body can trail the client's slot.
  const peakOf = (entry) => entry?.requests?.byEndpoint?.[entry.primaryEndpoint]?.peakInFlight ?? 0
  if (Number.isFinite(options.budgetDiffInflight)) {
    const entry = actionOf("generate")
    if (!entry) failures.push("--budget-diff-inflight needs the generate action")
    else if (peakOf(entry) > options.budgetDiffInflight) {
      failures.push(`generate client peak in-flight /api/git/diff ${peakOf(entry)} exceeds ${options.budgetDiffInflight}`)
    }
  }
  if (Number.isFinite(options.budgetRevertInflight)) {
    const entry = actionOf("revert-all")
    if (!entry) failures.push("--budget-revert-inflight needs the revert-all action")
    else if (peakOf(entry) > options.budgetRevertInflight) {
      failures.push(`revert-all client peak in-flight /api/git/revert ${peakOf(entry)} exceeds ${options.budgetRevertInflight}`)
    }
  }
  if (Number.isFinite(options.budgetLongest)) {
    const measured = summary.actions
      .map((entry) => entry.longTasks?.longestTaskMs ?? null)
      .filter((value) => value !== null)
    const longest = measured.length > 0 ? Math.max(...measured) : 0
    if (measured.length === 0) failures.push("--budget-longest needs a capture with measured long tasks")
    else if (longest > options.budgetLongest) failures.push(`longest main-thread task ${longest}ms exceeds ${options.budgetLongest}ms`)
  }
  return failures
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  // The delta table belongs to the text report; saying so up front is clearer
  // than reading a baseline the JSON output would never use.
  if (options.baseline && options.json) {
    console.warn("--baseline is ignored with --json: the delta table is only printed by the text report")
  }

  const plan = buildFixturePlan({ files: options.files, modified: options.modified, staged: options.staged })
  const actions = assertActionsRunnable(parseActions(options.actions), plan)

  // Fails before creating a fixture or starting anything when the requested
  // browser cannot run.
  const chrome = resolveChrome(options.chrome)
  const builtUi = join(repoRoot, "packages", "web", "dist", "index.html")
  if (!existsSync(builtUi)) {
    throw new Error(`The built UI is missing at ${builtUi}. Run \`bun run build:ui && bun run build:web\` first; a development server is not measured.`)
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const root = join(tmpdir(), `openchamber-perf-git-${timestamp}`)
  const output = resolve(options.output ?? join("artifacts", `git-panel-${timestamp}`))
  const homeDirectory = join(root, "home")
  const dataDirectory = join(root, "data")
  const logPath = join(root, "server.log")
  const profileDir = resolve(options.profileDir)

  let serverProcess = null
  let chromeProcess = null
  let client = null
  let browserClient = null
  let baseline = null
  const failures = []
  const warnings = []

  try {
    // The delta table is only printed by the text report, so --json never
    // reads a baseline it would not use (the flag combination warns above).
    // Reading it before creating anything keeps a missing or malformed
    // baseline from leaving directories behind; every directory this run
    // creates is created inside the try so any later failure still reaches
    // the finally block and removes the temporary root.
    if (options.baseline && !options.json) {
      baseline = await readBaselineSummary(options.baseline)
      warnings.push(...baselineScenarioMismatches(baseline, plan, actions))
    }

    await mkdir(root, { recursive: true })
    await mkdir(homeDirectory, { recursive: true })
    await mkdir(dataDirectory, { recursive: true })
    await mkdir(output, { recursive: true })
    await mkdir(profileDir, { recursive: true })

    const fixtureDirectory = await createFixture(root, plan)
    const serverPort = await reservePort()
    serverProcess = startServer({ cwd: fixtureDirectory, homeDirectory, dataDirectory, port: serverPort, logPath })
    const serverUrl = `http://127.0.0.1:${serverPort}`
    await waitForServer(serverProcess, serverUrl, logPath)
    console.log(`OpenChamber server ready on ${serverUrl} (isolated data: ${dataDirectory})`)

    const debuggingPort = await reservePort()
    chromeProcess = launchChrome({ chrome, profileDir, port: debuggingPort, headless: options.headless })
    const target = await createPageTarget(debuggingPort)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    browserClient = await openBrowserClient(debuggingPort)
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Performance.enable"),
      client.send("Profiler.enable"),
      client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
    ])
    await client.send("Network.setBypassServiceWorker", { bypass: true })
    // The burst under test is the app's request fan-out. A cached diff would
    // hide a request the app issued, so the capture disables the HTTP cache and
    // records that condition in the summary; both before and after runs use it.
    await client.send("Network.setCacheDisabled", { cacheDisabled: true })
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    // The app reads its active directory from localStorage before any route
    // resolves; seeding it makes the fixture the active project on first paint.
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("lastDirectory", ${JSON.stringify(fixtureDirectory)}) } catch {}`,
    })

    // Request tracking. `startedAt` (request sent), `responseAt` (response
    // headers) and `endedAt` (body finished or failure) are monotonic seconds
    // from the same clock, so both peak overlaps are interval computations,
    // not guesses: client concurrency runs start -> headers, transfer
    // occupancy runs start -> completion.
    const requests = []
    const byId = new Map()
    const inFlight = new Map()
    let lastMonotonic = 0
    client.on("Network.requestWillBeSent", (params) => {
      let url
      try {
        url = new URL(params.request.url)
      } catch {
        return
      }
      if (url.origin !== serverUrl) return
      lastMonotonic = Number(params.timestamp) || lastMonotonic
      const entry = {
        id: params.requestId,
        method: params.request.method,
        endpoint: url.pathname,
        url: params.request.url,
        startedAt: Number(params.timestamp),
        responseAt: null,
        endedAt: null,
        failed: false,
        servedFromCache: false,
        status: null,
      }
      byId.set(params.requestId, entry)
      requests.push(entry)
      inFlight.set(entry.endpoint, (inFlight.get(entry.endpoint) ?? 0) + 1)
    })
    const finishRequest = (requestId, timestamp, failed) => {
      const entry = byId.get(requestId)
      if (!entry) return
      byId.delete(requestId)
      entry.endedAt = Number(timestamp)
      entry.failed = failed
      if (entry.endedAt > lastMonotonic) lastMonotonic = entry.endedAt
      inFlight.set(entry.endpoint, Math.max(0, (inFlight.get(entry.endpoint) ?? 1) - 1))
    }
    client.on("Network.loadingFinished", ({ requestId, timestamp }) => finishRequest(requestId, timestamp, false))
    client.on("Network.loadingFailed", ({ requestId, timestamp }) => finishRequest(requestId, timestamp, true))
    client.on("Network.requestServedFromCache", ({ requestId }) => {
      const entry = byId.get(requestId)
      if (entry) entry.servedFromCache = true
    })
    client.on("Network.responseReceived", ({ requestId, response, timestamp }) => {
      const entry = byId.get(requestId)
      if (!entry) return
      entry.status = response.status
      entry.responseAt = Number(timestamp)
      if (entry.responseAt > lastMonotonic) lastMonotonic = entry.responseAt
    })

    const traceEvents = []
    client.on("Tracing.dataCollected", ({ value }) => {
      for (const event of value ?? []) traceEvents.push(event)
    })

    let loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: serverUrl })
    await loaded

    // The UI store is written during boot; seed the Git panel once it exists.
    await waitFor(
      "the app to persist its UI store",
      async () => {
        try {
          await seedContextPanel(client, ["git"], null)
          return true
        } catch (error) {
          if (error instanceof Error && error.message.includes("no ui-store")) return false
          throw error
        }
      },
      { timeoutMs: 30_000, intervalMs: 1_000 },
    )
    loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.reload")
    await loaded

    console.log(`Loaded ${serverUrl}; settling for ${options.settle}s.`)
    await wait(options.settle * 1000)

    // A panel opened on another directory renders a perfectly quiet profile.
    // Both the app's persisted directory and its own status request must name
    // the fixture before anything is measured.
    const panel = await waitFor(
      "the Git panel to show the fixture",
      async () => {
        const state = await readPanelState(client, plan)
        if (state.activeDirectory !== fixtureDirectory) return null
        if (!state.changedRowVisible) return null
        if (actions.includes("revert-all") && !state.revertAllVisible) return null
        if (actions.includes("generate") && !(state.generatePresent && state.generateEnabled)) return null
        return state
      },
      { timeoutMs: 60_000, intervalMs: 1_000 },
    ).catch((error) => {
      throw new Error(`${error.message}. The Git panel is not showing the fixture; the scenario never ran.`)
    })
    await waitFor(
      "an /api/git/status request for the fixture",
      async () => requests.some((entry) => entry.endpoint === "/api/git/status"
        && new URL(entry.url).searchParams.get("directory") === fixtureDirectory),
      { timeoutMs: 30_000, intervalMs: 500 },
    )
    console.log(`Git panel shows the fixture (${actions.join(", ")}).`)

    const serverProcesses = await resolveServerProcesses(serverPort)
    const processCpu = createProcessCpuSampler({ browserClient, serverProcesses })
    const state = {
      root,
      plan,
      options,
      requests,
      inFlight,
      processCpu,
      fixtureDirectory,
      actionRequestStart: 0,
      get lastMonotonic() { return lastMonotonic },
    }

    await client.send("Profiler.setSamplingInterval", { interval: 250 })
    await client.send("Profiler.start")
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      // `RunTask` only exists under the disabled-by-default timeline category;
      // without it the capture would report zero long tasks.
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing"].join(","),
    })

    const actionRecords = []
    for (const action of actions) {
      const record = await runAction(client, state, action)
      actionRecords.push(record)
      if (record.error) failures.push(`${action}: ${record.error}`)
      else failures.push(...findMissingRequests(action, plan, record.requests))
      if (record.modelOutcome && record.modelOutcome.outcome !== "message") {
        warnings.push(`${action}: the model step finished as "${record.modelOutcome.outcome}" (no provider configured is the usual cause); the diff burst above is the measurement`)
      }
    }

    let traceComplete = true
    const tracingComplete = client.once("Tracing.tracingComplete", 120_000)
    try {
      await client.send("Tracing.end")
      await tracingComplete
    } catch (error) {
      traceComplete = false
      void tracingComplete.catch(() => undefined)
      console.warn(`Chrome did not confirm trace completion; using the events collected so far: ${error.message}`)
      await wait(2_000)
    }
    await wait(500)
    const { profile } = await client.send("Profiler.stop")

    const frameLiveness = await evaluateValue(client, `new Promise((resolveFrames) => {
      let frames = 0
      const startedAtFrames = performance.now()
      const tick = () => {
        frames += 1
        if (performance.now() - startedAtFrames < 1000) requestAnimationFrame(tick)
        else resolveFrames({ framesPerSecond: frames, visibilityState: document.visibilityState })
      }
      requestAnimationFrame(tick)
      setTimeout(() => resolveFrames({ framesPerSecond: frames, visibilityState: document.visibilityState }), 2000)
    })`)

    // Attribute long tasks and trace events to each action through its marks.
    const tasks = traceEvents.filter((event) => event.name === "RunTask" && event.ph === "X" && Number(event.dur) > 0)
    if (tasks.length === 0) {
      failures.push("the trace contains no RunTask events; long-task metrics are unavailable, not zero")
    }
    const marks = new Map()
    for (const event of traceEvents) {
      if (!event.cat?.includes("blink.user_timing")) continue
      if (event.name?.startsWith("git-panel:")) marks.set(event.name, event.ts)
    }
    for (const entry of actionRecords) {
      const start = marks.get(`git-panel:${entry.action}:start`)
      const end = marks.get(`git-panel:${entry.action}:end`)
      if (start === undefined || end === undefined) {
        failures.push(`${entry.action}: the trace carries no action marks, so its window cannot be attributed`)
        continue
      }
      const inWindow = traceEvents.filter((event) => event.ts >= start && event.ts <= end)
      entry.longTasks = summarizeLongTasks(inWindow)
      entry.traceBreakdown = summarizeTraceEvents(inWindow, 10)
    }
    if (Number(frameLiveness?.framesPerSecond ?? 0) < 10) {
      failures.push(`the renderer produced ${frameLiveness?.framesPerSecond ?? 0} frames/s; it was throttled and rendering metrics from this run understate real work`)
    }

    const summary = {
      recordedAt: new Date().toISOString(),
      label: options.label,
      headless: options.headless,
      httpCacheDisabled: true,
      fixture: {
        directory: fixtureDirectory,
        trackedFiles: plan.paths.length,
        modifiedFiles: plan.modifiedPaths.length,
        stagedFiles: plan.stagedPaths.length,
      },
      actions: actionRecords,
      panelAlignment: {
        activeDirectory: panel.activeDirectory,
        fixtureDirectory,
        statusRequestObserved: true,
      },
      processCpu: processCpu.summarize(),
      frameLiveness,
      traceComplete,
      traceTaskCount: tasks.length,
      cpuProfile: summarizeCpuProfile(profile),
      warnings,
      failures,
    }

    await writeFile(join(output, "git-panel-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))
    if (options.saveTrace) {
      // Streamed event by event: one JSON.stringify over a long trace exceeds
      // the maximum string length.
      const traceFile = createWriteStream(join(output, "trace.json"))
      traceFile.write('{"traceEvents":[\n')
      traceEvents.forEach((event, index) => traceFile.write(`${index === 0 ? "" : ",\n"}${JSON.stringify(event)}`))
      traceFile.end("\n]}")
      await finished(traceFile)
    }

    if (options.json) console.log(JSON.stringify(summary, null, 2))
    else printReport(summary, baseline)
    console.log(`\nSaved to ${output}`)
    if (options.keep) console.log(`Fixture kept at ${root}`)
    if (warnings.length > 0) console.warn(`Warnings:\n${warnings.map((warning) => `  - ${warning}`).join("\n")}`)

    const budgetFailures = evaluateBudgets(summary, options)
    if (budgetFailures.length > 0) {
      console.error(`Budget failures:\n${budgetFailures.map((failure) => `  - ${failure}`).join("\n")}`)
    }
    if (failures.length > 0) {
      console.error(`Capture failures:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
    }
    if (failures.length > 0 || budgetFailures.length > 0) process.exitCode = 1
  } finally {
    client?.close()
    browserClient?.close()
    // A failed run reaches this block too, so cleanup is unconditional: stop
    // the server first (it reaps its own managed OpenCode child on SIGTERM),
    // then Chrome, each with a bounded wait before the temporary root goes
    // away. The fixture directory holds the only repository this run ever
    // mutated.
    await terminateChild(serverProcess, "the OpenChamber server")
    await terminateChild(chromeProcess, "Chrome")
    if (!options.keep) await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
