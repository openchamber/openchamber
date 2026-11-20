import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import process from "node:process"
import { finished } from "node:stream/promises"

import { reservePort, wait } from "../perf/cdp.mjs"
import { DESIGN_PROJECT_FILES } from "../perf/fixture-conversations.mjs"
import { writeFixtureCommands } from "../perf/shell-command.mjs"
import { fixtureProviderConfig } from "../perf/fixture-provider.mjs"
import { REPO_ROOT, startFixture } from "../perf/isolated-server.mjs"
import { resolveBunExecutable } from "../lib/bun-executable.mjs"
import { bundledOpenCodeServerEnv, devOpenCodeEnv } from "../lib/bundled-opencode-server.mjs"
import { prioritizeWindowsProcess } from "./windows-priority.mjs"
import { createStandProcesses, reapStaleStands } from "./processes.mjs"

export const DEFAULT_MODEL = "perf/stream-20000cps"
const PROJECT_LABEL = "relay-desk"
// What the server keeps of the UI's settings: the base file and the
// per-device profile fields.
const SETTINGS_FILES = ["settings.json", "preferences.json"]
const SETTINGS_BASELINE = "settings-baseline"
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Relay Desk",
  GIT_AUTHOR_EMAIL: "dev@relay-desk.test",
  GIT_COMMITTER_NAME: "Relay Desk",
  GIT_COMMITTER_EMAIL: "dev@relay-desk.test",
  GIT_AUTHOR_DATE: "2026-01-05T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-05T10:00:00Z",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

const portAnswers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((response) => response.status < 500, () => false)

const BASE_ENV_KEYS = ["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", ...(process.platform === "win32" ? ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"] : [])]

const baseEnv = () => Object.fromEntries(BASE_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))

const standEnv = (info) => {
  const env = {
    ...baseEnv(),
    HOME: info.home,
    XDG_CONFIG_HOME: join(info.root, "xdg"),
    XDG_DATA_HOME: join(info.root, "share"),
    XDG_CACHE_HOME: join(info.root, "cache"),
    XDG_STATE_HOME: join(info.root, "state"),
    BUN_INSTALL_CACHE_DIR: join(info.root, "cache"),
    OPENCHAMBER_DATA_DIR: info.data,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(info.fixturePort, info.deadPort)),
  }
  if (process.platform === "win32") {
    env.USERPROFILE = info.home
    env.APPDATA = join(info.root, "appdata")
    env.LOCALAPPDATA = join(info.root, "localappdata")
  }
  // A CLI the caller names, else the pinned OpenCode of this checkout, the one the desktop app bundles.
  Object.assign(env, devOpenCodeEnv(process.env, () => bundledOpenCodeServerEnv(REPO_ROOT)))
  return env
}

const listedSessions = (body) => (Array.isArray(body) ? body : body?.data ?? body?.sessions ?? body?.items ?? null)

export const parseStandSessions = (body) => {
  const listed = listedSessions(body)
  if (!Array.isArray(listed)) throw new Error("The stand's session list is invalid; nothing was reset")
  return listed.map((record) => ({ id: record.id, directory: record.location?.directory ?? record.directory }))
}

export const readStandSessions = async (apiUrl) => {
  const sessions = []
  const seen = new Set()
  const signal = AbortSignal.timeout(120_000)
  let cursor
  while (true) {
    const response = await fetch(`${apiUrl}/api/session?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal })
    if (!response.ok) throw new Error(`Reading the stand's sessions answered ${response.status}; nothing was reset`)
    const body = await response.json()
    const page = parseStandSessions(body)
    sessions.push(...page)
    const next = body?.cursor?.next
    if (!next) return sessions
    if (page.length === 0 || seen.has(next)) throw new Error("The stand's session cursor did not advance; nothing was reset")
    seen.add(next)
    cursor = next
  }
}

const assertIsolated = async (apiUrl) => {
  const response = await fetch(`${apiUrl}/api/session?directory=${encodeURIComponent(REPO_ROOT)}`).catch(() => null)
  const listed = response?.ok ? listedSessions(await response.json()) : null
  if (!Array.isArray(listed)) return false
  if (listed.length > 0) throw new Error(`The server on ${apiUrl} lists sessions of the real checkout, so it is not an isolated stand. Stopping.`)
  return true
}

export const gitIn = (project, args) => execFileSync("git", args, {
  cwd: project,
  env: { ...baseEnv(), ...GIT_ENV },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
})

class IsolationError extends Error {}

// Read Git's registry without invoking Git: a broken repository config must
// not prevent checking every linked directory before recovery removes metadata.
const standWorktrees = ({ root, project }) => {
  const standRoot = realpathSync(root).replaceAll("\\", "/")
  const mainProject = `${standRoot}/${basename(project)}`
  if (realpathSync(dirname(project)).replaceAll("\\", "/") !== standRoot || (existsSync(project) && realpathSync(project).replaceAll("\\", "/") !== mainProject)) {
    throw new IsolationError(`The project ${project} is outside ${root}; nothing was removed.`)
  }
  const metadata = join(project, ".git")
  if (existsSync(metadata) && (!lstatSync(metadata).isDirectory() || realpathSync(metadata).replaceAll("\\", "/") !== `${mainProject}/.git`)) {
    throw new IsolationError(`The project metadata ${metadata} is not stand-owned; nothing was removed.`)
  }
  const registry = join(metadata, "worktrees")
  if (!existsSync(registry)) return []
  const linked = readdirSync(registry).map((name) => {
    const gitdir = readFileSync(join(registry, name, "gitdir"), "utf8").trim()
    if (!gitdir || !gitdir.endsWith("/.git")) throw new IsolationError(`The worktree registry at ${registry} is invalid; nothing was removed.`)
    const directory = dirname(resolve(gitdir))
    return (existsSync(directory) ? realpathSync(directory) : directory).replaceAll("\\", "/")
  })
  const foreign = linked.find((directory) => !directory.startsWith(`${standRoot}/`) || directory === mainProject)
  if (foreign) throw new IsolationError(`The stand has a worktree outside ${root} (${foreign}); nothing was removed.`)
  return linked
}

const OPENCODE_FOLDER = ".opencode"

const emptyOpenCodeFolder = (project) => {
  const folder = join(project, OPENCODE_FOLDER)
  // A link a scenario left here would send the cleanup outside the stand.
  if (lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() === false) rmSync(folder, { force: true })
  mkdirSync(folder, { recursive: true })
  for (const entry of readdirSync(folder)) rmSync(join(folder, entry), { recursive: true, force: true })
}

/**
 * Saved drafts stay in the sidebar of every later scenario. They go through
 * the server, whose queue also holds a save the last page sent as it closed;
 * removing the file under it would let that save bring the drafts back.
 */
export const deleteSavedDrafts = async (apiUrl) => {
  const listed = await fetch(`${apiUrl}/api/session-drafts`)
  if (!listed.ok) throw new Error(`Reading the stand's saved drafts answered ${listed.status}`)
  const { drafts } = await listed.json()
  if (!Array.isArray(drafts)) throw new Error("The stand's saved drafts are invalid")
  for (const draft of drafts) {
    const response = await fetch(`${apiUrl}/api/session-drafts/${encodeURIComponent(draft.id)}`, { method: "DELETE" })
    if (!response.ok && response.status !== 404) throw new Error(`Deleting saved draft ${draft.id} answered ${response.status}`)
  }
}

export const resetWorktrees = ({ root, project, initialCommit, initialBranch = "main", initialGitConfig }) => {
  const linked = standWorktrees({ root, project })
  if (initialGitConfig !== undefined) writeFileSync(join(project, ".git/config"), initialGitConfig)
  for (const directory of linked) gitIn(project, ["worktree", "remove", "--force", "--force", directory])
  const baseline = initialCommit ?? gitIn(project, ["rev-list", "--max-parents=0", "HEAD"]).trim()
  if (existsSync(join(project, ".git/rebase-merge")) || existsSync(join(project, ".git/rebase-apply"))) gitIn(project, ["rebase", "--abort"])
  // Hard reset clears an unfinished merge and its unmerged index before checkout.
  gitIn(project, ["reset", "-q", "--hard", baseline])
  gitIn(project, ["clean", "-ffdqx", "-e", `/${OPENCODE_FOLDER}`])
  emptyOpenCodeFolder(project)
  gitIn(project, ["checkout", "-q", "-B", initialBranch, baseline])
  // Every branch other than the initial one was made by a scenario. Keeping
  // it changes the next worktree's branch name even after its folder is gone.
  const branches = gitIn(project, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).trim().split(/\r?\n/).filter((branch) => branch && branch !== initialBranch)
  for (const branch of branches) gitIn(project, ["branch", "-D", branch])
  gitIn(project, ["stash", "clear"])
}

export const resetProject = (info) => {
  const linked = standWorktrees(info)
  try {
    resetWorktrees(info)
    return null
  } catch (error) {
    if (error instanceof IsolationError) throw error
    for (const directory of linked) rmSync(directory, { recursive: true, force: true })
    rmSync(info.project, { recursive: true, force: true })
    writeProject(info.project)
    return `Project reset failed; rebuilt the fixture: ${error.message}`
  }
}

const writeProject = (project) => {
  mkdirSync(project, { recursive: true })
  for (const [file, content] of Object.entries(DESIGN_PROJECT_FILES)) {
    mkdirSync(dirname(join(project, file)), { recursive: true })
    writeFileSync(join(project, file), content)
  }
  gitIn(project, ["init", "-q", "-b", "main"])
  writeFixtureCommands(project)
  writeFileSync(join(project, ".gitattributes"), "* text=auto eol=lf\n")
  writeFileSync(join(project, ".git/info/exclude"), "perf-read/\n")
  gitIn(project, ["add", "-A"])
  gitIn(project, ["commit", "-q", "-m", "Initial import of the support inbox"])
  emptyOpenCodeFolder(project)
}

const writeSettings = (dataDir, home, project) => {
  mkdirSync(dataDir, { recursive: true })
  const id = `path_${Buffer.from(project).toString("base64url")}`
  const at = Date.parse("2026-01-05T10:00:00Z")
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
    homeDirectory: home,
    projects: [{ id, path: project, label: PROJECT_LABEL, addedAt: at, lastOpenedAt: at, sidebarCollapsed: false }],
    activeProjectId: id,
    lastDirectory: project,
    defaultModel: DEFAULT_MODEL,
  }, null, 2))
  return id
}

// The user's profile (Settings > Chat and the like) lives in `preferences.json`,
// mirrored into `settings.json`; the server reads both on every settings
// request. A scenario that changed a setting and failed before changing it
// back must not hand it to the next one, so the reset drops the profile and
// keeps the stand's own model.
export const PROFILE_KEYS = Object.entries(JSON.parse(readFileSync(join(REPO_ROOT, "packages/web/server/lib/settings/settings-registry.json"), "utf8")).fields)
  .filter(([, field]) => field.scope === "profile")
  .map(([key]) => key)

const dropProfile = (dataDir) => {
  const file = join(dataDir, "settings.json")
  const settings = JSON.parse(readFileSync(file, "utf8"))
  for (const key of PROFILE_KEYS) delete settings[key]
  writeFileSync(file, JSON.stringify({ ...settings, defaultModel: DEFAULT_MODEL }, null, 2))
  rmSync(join(dataDir, "preferences.json"), { force: true })
}

// What the profile holds in both files, in a form two reads can compare.
const readProfile = (dataDir) => {
  const settings = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"))
  const preferencesFile = join(dataDir, "preferences.json")
  const preferences = existsSync(preferencesFile) ? JSON.parse(readFileSync(preferencesFile, "utf8")).fields ?? {} : {}
  const values = (record, read) => Object.keys(record).filter((key) => PROFILE_KEYS.includes(key)).sort().map((key) => [key, read(record[key])])
  return JSON.stringify([values(settings, (value) => value), values(preferences, (field) => field?.value ?? field?.surfaces ?? null)])
}

// The server keeps running through the reset. A read of the settings seeds a
// missing preferences file from what it read (the server's defaults after a
// drop), so a read it began before the drop can write the old profile back.
// Drop, read through the API, and repeat until two rounds leave the same
// profile: a stale read lands in at most one of them.
const resetProfile = async (dataDir, apiUrl) => {
  let previous = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    dropProfile(dataDir)
    await fetch(`${apiUrl}/api/config/settings`).catch(() => null)
    const current = readProfile(dataDir)
    if (current === previous) return
    previous = current
    await wait(100)
  }
  throw new Error(`The profile settings in ${dataDir} kept changing during the reset`)
}

const opencodeConfig = (fixturePort, deadPort) => {
  const fixture = fixtureProviderConfig(fixturePort)
  return {
    ...fixture,
    provider: {
      ...fixture.provider,
      offline: {
        npm: "@ai-sdk/openai-compatible",
        name: "Offline fixture",
        options: { baseURL: `http://127.0.0.1:${deadPort}/v1`, apiKey: "unused" },
        models: { "no-answer": { name: "Offline fixture, server down" } },
      },
    },
    model: DEFAULT_MODEL,
    small_model: DEFAULT_MODEL,
    autoupdate: false,
    share: "disabled",
    compaction: { auto: false },
    // Everything else runs without asking. A read of a `.secret` file and a
    // fetch ask, so a scenario can show a permission request or hold a
    // session on one; nothing else in the fixture fetches.
    permission: { read: { "*.secret": "ask" }, webfetch: "ask" },
    // Released builds keep `todowrite` behind a flag; the chat's Tasks row needs it.
    experimental: { todo: true },
  }
}

export const closeStandLog = async (log, pipes) => {
  await Promise.race([
    Promise.allSettled(pipes.map((stream) => finished(stream))),
    wait(1000),
  ])
  for (const stream of pipes) {
    stream.unpipe(log)
    stream.destroy()
  }
  await finished(log.end())
}

const waitUntil = async (check, timeoutMs, what, child, logFile) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.targetExitCode !== undefined)) throw new Error(`A stand process exited (${child.targetExitCode ?? child.exitCode}) before ${what}; see ${logFile}`)
    if (await check()) return
    await wait(500)
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}; see ${logFile}`)
}

export const startStand = async ({ log, logsDir, onStop }) => {
  await reapStaleStands({ checkout: REPO_ROOT, log })
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "oc-verify-"))).replaceAll("\\", "/")
  const dirs = {
    root,
    home: join(root, "home"),
    data: join(root, "oc-data"),
    project: `${root}/project`,
    logs: logsDir,
  }
  let fixture = null
  let api = null
  let ui = null
  let logStream = null
  let uiPort = null
  let stopped = false
  let stopping = null
  let processes = null
  const stop = () => {
    stopped = true
    stopping ??= (async () => {
      const errors = []
      await processes?.stop().catch((error) => errors.push(error))
      await fixture?.stop().catch((error) => errors.push(error))
      if (logStream) {
        await closeStandLog(logStream, [ui?.stdout, ui?.stderr, api?.stdout, api?.stderr].filter(Boolean)).catch((error) => errors.push(error))
        logStream = null
      }
      if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "))
      if (uiPort) rmSync(join(REPO_ROOT, `packages/web/node_modules/.vite-dev-${uiPort}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      await processes?.release()
    })().finally(() => { stopping = null })
    return stopping
  }
  onStop(stop)
  const abortIfStopped = async () => {
    if (!stopped) return
    await stop()
    throw new Error("Stopped while the stand was starting")
  }
  try {
  processes = createStandProcesses({ checkout: REPO_ROOT, root })
  for (const dir of [dirs.home, dirs.logs, join(root, "xdg"), join(root, "share"), join(root, "cache"), join(root, "state")]) mkdirSync(dir, { recursive: true })
  writeProject(dirs.project)
  const projectId = writeSettings(dirs.data, dirs.home, dirs.project)

  const [fixturePort, deadPort, apiPort] = [await reservePort(), await reservePort(), await reservePort()]
  uiPort = await reservePort()
  processes.setUiPort(uiPort)
  const apiUrl = `http://localhost:${apiPort}`
  const uiUrl = `http://localhost:${uiPort}`
  const serverLog = join(dirs.logs, "dev.log")
  const info = {
    ...dirs, projectId, apiUrl, uiUrl, apiPort, uiPort, fixturePort, deadPort, serverLog,
    initialCommit: gitIn(dirs.project, ["rev-parse", "HEAD"]).trim(),
    initialBranch: "main",
    initialGitConfig: readFileSync(join(dirs.project, ".git/config"), "utf8"),
  }
  await abortIfStopped()
  fixture = await startFixture({ port: fixturePort, logFile: join(dirs.logs, "fixture.log"), verifyControl: true, onSpawn: (child) => processes.track(child, { label: "fixture" }) })
  await abortIfStopped()
  logStream = createWriteStream(serverLog)
  const bun = resolveBunExecutable()
  const launch = (args, cwd, extraEnv, executable = bun) => {
    const child = processes.launch(executable, args, { cwd, env: { ...standEnv(info), ...extraEnv }, label: args.includes("server/index.js") || args.includes("dev:server") ? "API" : "Vite" })
    child.stdout.pipe(logStream, { end: false })
    child.stderr.pipe(logStream, { end: false })
    return child
  }
  const webRoot = join(REPO_ROOT, "packages/web")
  const launchApi = () => {
    const env = { OPENCHAMBER_PORT: String(apiPort), OPENCHAMBER_RELAY_HOST: "off" }
    if (process.platform !== "win32") return launch(["run", "dev:server"], webRoot, env)
    execFileSync(bun, [join(REPO_ROOT, "scripts/build-builtin-extensions.mjs")], { cwd: webRoot, env: standEnv(info), stdio: "ignore" })
    return launch(["server/index.js", "--port", String(apiPort)], webRoot, { ...env, OPENCHAMBER_ALLOW_DEV_ORIGINS: "1" })
  }
  const modelsListed = async () => {
    const response = await fetch(`${apiUrl}/api/model?directory=${encodeURIComponent(dirs.project)}`).catch(() => null)
    if (!response?.ok) return false
    return JSON.stringify(await response.json()).includes("stream-20000cps")
  }
  api = launchApi()

  {
    if (api.pid) prioritizeWindowsProcess(api.pid)
    log(`stand at ${root}: api ${apiPort}, ui ${uiPort}, fixture ${fixturePort}`)
    await waitUntil(() => portAnswers(`${apiUrl}/health`), 180_000, "the API", api, serverLog)
    await waitUntil(() => assertIsolated(apiUrl), 120_000, "the session list", api, serverLog)
    await abortIfStopped()
    const viteArgs = ["--force", "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"]
    const windows = process.platform === "win32"
    ui = launch(windows ? [join(webRoot, "node_modules/vite/bin/vite.js"), ...viteArgs] : ["x", "vite", ...viteArgs], webRoot, {
      OPENCHAMBER_PORT: String(apiPort),
      OPENCHAMBER_DISABLE_PWA_DEV: "1",
      OPENCHAMBER_VITE_CACHE_DIR: join(webRoot, `node_modules/.vite-dev-${uiPort}`),
    }, windows ? process.execPath : bun)
    if (ui.pid) prioritizeWindowsProcess(ui.pid)
    await waitUntil(() => portAnswers(`${uiUrl}/`), 120_000, "the UI", ui, serverLog)
    await waitUntil(modelsListed, 120_000, "OpenCode to list the fixture models", api, serverLog)
    // A scenario can change a setting the server keeps (Don't ask again on a
    // move); the reset puts this copy back so the next one starts the same.
    mkdirSync(join(root, SETTINGS_BASELINE), { recursive: true })
    for (const file of SETTINGS_FILES) {
      if (existsSync(join(dirs.data, file))) copyFileSync(join(dirs.data, file), join(root, SETTINGS_BASELINE, file))
    }
  }
  processes.remember()
  await abortIfStopped()

  let apiDown = false
  const stopApi = async () => {
    apiDown = true
    await processes.stopTree(api)
    await waitUntil(async () => !await portAnswers(`${apiUrl}/health`), 30_000, "the API to stop", null, serverLog)
  }
  const startApi = async () => {
    api = launchApi()
    if (api.pid) prioritizeWindowsProcess(api.pid)
    await waitUntil(() => portAnswers(`${apiUrl}/health`), 180_000, "the API", api, serverLog)
    await waitUntil(modelsListed, 120_000, "OpenCode to list the fixture models", api, serverLog)
    apiDown = false
  }
  const attached = attachStand(info)
  const reset = async () => {
    if (apiDown) await startApi()
    return attached.reset()
  }
  return { ...attached, reset, stop, stopApi, startApi, trackProcess: (child, profile) => processes.track(child, { label: "Chrome", group: false, profile }) }
  } catch (error) {
    await stop()
    throw error
  }
}

export const attachKeptStand = async (info) => {
  if (!existsSync(info.project) || !existsSync(info.data)) throw new Error(`The kept stand at ${info.root} is gone; start a new one.`)
  if (!await assertIsolated(info.apiUrl)) throw new Error(`Nothing answers on ${info.apiUrl}; the kept stand has stopped.`)
  if (!existsSync(join(info.root, SETTINGS_BASELINE))) throw new Error(`The kept stand at ${info.root} has no settings baseline, so its reset cannot undo settings a scenario changes; start a new one.`)
  return attachStand(info)
}

const attachStand = (info) => {
  const env = standEnv(info)
  const insideStand = (directory) => {
    const path = String(directory).replaceAll("\\", "/")
    return path === info.root || path.startsWith(`${info.root}/`)
  }
  const cli = (args, timeoutMs = 120_000, { anyDirectory = false } = {}) => {
    try {
      const scope = anyDirectory ? [] : ["--dir", info.project]
      return JSON.parse(execFileSync(resolveBunExecutable(), [join(REPO_ROOT, "packages/web/bin/cli.js"), "session", ...args, ...scope, "--port", String(info.apiPort), "--json"], {
        encoding: "utf8",
        timeout: timeoutMs,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }))
    } catch (error) {
      throw new Error(`openchamber session ${args[0]} failed: ${String(error.stderr || error.stdout || error.message).trim().slice(0, 300)}`)
    }
  }
  const cliInBackground = (args) => {
    const child = spawn(resolveBunExecutable(), [join(REPO_ROOT, "packages/web/bin/cli.js"), "session", ...args, "--dir", info.project, "--port", String(info.apiPort), "--json"], { env, stdio: "ignore" })
    const done = new Promise((resolveDone) => child.once("exit", resolveDone).once("error", resolveDone))
    return { done, stop: () => { if (child.exitCode === null) child.kill("SIGTERM") } }
  }
  // The raw global list includes archived and child sessions. Housekeeping on
  // Windows uses this read directly: the CLI's 4 s control timeout is too short
  // for a restarted server. Scenario actions still run through the CLI.
  const reset = async () => {
    const roots = process.platform === "win32" ? [] : cli(["list", "--all", "--limit", "1000"], 120_000, { anyDirectory: true }).sessions ?? []
    const sessions = [...new Map([...roots, ...await readStandSessions(info.apiUrl)].map((session) => [session.id, session])).values()]
    const foreign = sessions.filter((session) => !insideStand(session.directory))
    if (foreign.length) throw new Error(`The server on ${info.apiUrl} holds sessions outside ${info.root} (${foreign[0].directory}); it is not this stand, so nothing was deleted.`)
    for (const session of sessions) {
      const response = await fetch(`${info.apiUrl}/api/session/${encodeURIComponent(session.id)}?directory=${encodeURIComponent(session.directory)}`, { method: "DELETE" })
      if (!response.ok && response.status !== 404) throw new Error(`Deleting session ${session.id} answered ${response.status}`)
    }
    const failure = resetProject(info)
    for (const file of SETTINGS_FILES) {
      const baseline = join(info.root, SETTINGS_BASELINE, file)
      if (existsSync(baseline)) copyFileSync(baseline, join(info.data, file))
      else rmSync(join(info.data, file), { force: true })
    }
    // Sidebar folders, which the server keeps for every window. The Detailed
    // rows switch a scenario may leave on is a profile setting, dropped below.
    rmSync(join(info.data, "sessions-directories.json"), { force: true })
    await deleteSavedDrafts(info.apiUrl)
    await resetProfile(info.data, info.apiUrl)
    return { failure }
  }
  const outsideControl = async () => { throw new Error("server.stop and server.start need a stand this run started; they do not work with --attach") }
  return { ...info, cli, cliInBackground, reset, describe: () => info, stop: async () => undefined, stopApi: outsideControl, startApi: outsideControl }
}
