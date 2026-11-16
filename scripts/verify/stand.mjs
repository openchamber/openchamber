import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"

import { reservePort, wait } from "../perf/cdp.mjs"
import { DESIGN_PROJECT_FILES } from "../perf/fixture-conversations.mjs"
import { fixtureProviderConfig } from "../perf/fixture-provider.mjs"
import { REPO_ROOT, startFixture } from "../perf/isolated-server.mjs"
import { resolveBunExecutable } from "../lib/bun-executable.mjs"

const MAC_BUNDLED_OPENCODE = "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode"
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
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

const portAnswers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((response) => response.status < 500, () => false)

const BASE_ENV_KEYS = ["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"]

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
  if (process.env.OPENCODE_BINARY || process.platform === "darwin") env.OPENCODE_BINARY = process.env.OPENCODE_BINARY || MAC_BUNDLED_OPENCODE
  return env
}

const listedSessions = (body) => (Array.isArray(body) ? body : body?.data ?? body?.sessions ?? body?.items ?? null)

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

const writeProject = (project) => {
  mkdirSync(project, { recursive: true })
  for (const [file, content] of Object.entries(DESIGN_PROJECT_FILES)) {
    mkdirSync(dirname(join(project, file)), { recursive: true })
    writeFileSync(join(project, file), content)
  }
  gitIn(project, ["init", "-q", "-b", "main"])
  writeFileSync(join(project, ".git/info/exclude"), "perf-read/\n")
  gitIn(project, ["add", "-A"])
  gitIn(project, ["commit", "-q", "-m", "Initial import of the support inbox"])
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
export const PROFILE_KEYS = Object.entries(JSON.parse(readFileSync(join(REPO_ROOT, "packages/web/server/lib/opencode/settings-registry.json"), "utf8")).fields)
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

const stopGroup = async (child) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
  for (const [signal, waitMs] of [["SIGINT", 4000], ["SIGTERM", 3000], ["SIGKILL", 1000]]) {
    try { process.kill(-child.pid, signal) } catch { return }
    const done = await Promise.race([exited.then(() => true), wait(waitMs).then(() => false)])
    if (done) return
  }
}

const waitUntil = async (check, timeoutMs, what, child, logFile) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`A stand process exited (${child.exitCode}) before ${what}; see ${logFile}`)
    if (await check()) return
    await wait(500)
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}; see ${logFile}`)
}

export const startStand = async ({ log, logsDir, onStop }) => {
  const root = realpathSync(mkdtempSync(join("/private/tmp", "oc-verify-")))
  const dirs = {
    root,
    home: join(root, "home"),
    data: join(root, "oc-data"),
    project: join(root, "project"),
    logs: logsDir,
  }
  let fixture = null
  let api = null
  let ui = null
  let uiPort = null
  let stopped = false
  const stop = async () => {
    stopped = true
    await stopGroup(ui)
    await stopGroup(api)
    await fixture?.stop()
    if (uiPort) rmSync(join(REPO_ROOT, `packages/web/node_modules/.vite-dev-${uiPort}`), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  onStop(stop)
  const abortIfStopped = async () => {
    if (!stopped) return
    await stop()
    throw new Error("Stopped while the stand was starting")
  }
  for (const dir of [dirs.home, dirs.logs, join(root, "xdg"), join(root, "share"), join(root, "cache"), join(root, "state")]) mkdirSync(dir, { recursive: true })
  writeProject(dirs.project)
  const projectId = writeSettings(dirs.data, dirs.home, dirs.project)

  const [fixturePort, deadPort, apiPort] = [await reservePort(), await reservePort(), await reservePort()]
  uiPort = await reservePort()
  const apiUrl = `http://localhost:${apiPort}`
  const uiUrl = `http://localhost:${uiPort}`
  const serverLog = join(dirs.logs, "dev.log")
  const info = { ...dirs, projectId, apiUrl, uiUrl, apiPort, uiPort, fixturePort, deadPort, serverLog }
  await abortIfStopped()
  fixture = await startFixture({ port: fixturePort, logFile: join(dirs.logs, "fixture.log") })
  await abortIfStopped()
  const logStream = createWriteStream(serverLog)
  const bun = resolveBunExecutable()
  const launch = (args, cwd, extraEnv) => {
    const child = spawn(bun, args, { cwd, env: { ...standEnv(info), ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.pipe(logStream, { end: false })
    child.stderr.pipe(logStream, { end: false })
    return child
  }
  const webRoot = join(REPO_ROOT, "packages/web")
  const launchApi = () => launch(["run", "dev:server"], webRoot, { OPENCHAMBER_PORT: String(apiPort), OPENCHAMBER_RELAY_HOST: "off" })
  const modelsListed = async () => {
    const response = await fetch(`${apiUrl}/api/model?directory=${encodeURIComponent(dirs.project)}`).catch(() => null)
    if (!response?.ok) return false
    return JSON.stringify(await response.json()).includes("stream-20000cps")
  }
  api = launchApi()

  try {
    log(`stand at ${root}: api ${apiPort}, ui ${uiPort}, fixture ${fixturePort}`)
    await waitUntil(() => portAnswers(`${apiUrl}/health`), 180_000, "the API", api, serverLog)
    await waitUntil(() => assertIsolated(apiUrl), 120_000, "the session list", api, serverLog)
    await abortIfStopped()
    ui = launch(["x", "vite", "--force", "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"], webRoot, {
      OPENCHAMBER_PORT: String(apiPort),
      OPENCHAMBER_DISABLE_PWA_DEV: "1",
      OPENCHAMBER_VITE_CACHE_DIR: join(webRoot, `node_modules/.vite-dev-${uiPort}`),
    })
    await waitUntil(() => portAnswers(`${uiUrl}/`), 120_000, "the UI", ui, serverLog)
    await waitUntil(modelsListed, 120_000, "OpenCode to list the fixture models", api, serverLog)
    // A scenario can change a setting the server keeps (Don't ask again on a
    // move); the reset puts this copy back so the next one starts the same.
    mkdirSync(join(root, SETTINGS_BASELINE), { recursive: true })
    for (const file of SETTINGS_FILES) {
      if (existsSync(join(dirs.data, file))) copyFileSync(join(dirs.data, file), join(root, SETTINGS_BASELINE, file))
    }
  } catch (error) {
    await stop()
    throw error
  }

  let apiDown = false
  const stopApi = async () => {
    apiDown = true
    await stopGroup(api)
    await waitUntil(async () => !await portAnswers(`${apiUrl}/health`), 30_000, "the API to stop", null, serverLog)
  }
  const startApi = async () => {
    api = launchApi()
    await waitUntil(() => portAnswers(`${apiUrl}/health`), 180_000, "the API", api, serverLog)
    await waitUntil(modelsListed, 120_000, "OpenCode to list the fixture models", api, serverLog)
    apiDown = false
  }
  const attached = attachStand(info)
  const reset = async () => {
    if (apiDown) await startApi()
    await attached.reset()
  }
  return { ...attached, reset, stop, stopApi, startApi }
}

export const attachKeptStand = async (info) => {
  if (!existsSync(info.project) || !existsSync(info.data)) throw new Error(`The kept stand at ${info.root} is gone; start a new one.`)
  if (!await assertIsolated(info.apiUrl)) throw new Error(`Nothing answers on ${info.apiUrl}; the kept stand has stopped.`)
  if (!existsSync(join(info.root, SETTINGS_BASELINE))) throw new Error(`The kept stand at ${info.root} has no settings baseline, so its reset cannot undo settings a scenario changes; start a new one.`)
  return attachStand(info)
}

const attachStand = (info) => {
  const env = standEnv(info)
  const insideStand = (directory) => directory === info.root || String(directory).startsWith(`${info.root}/`)
  const cli = (args, timeoutMs = 120_000, { anyDirectory = false } = {}) => {
    try {
      const scope = anyDirectory ? [] : ["--dir", info.project]
      return JSON.parse(execFileSync(process.execPath, [join(REPO_ROOT, "packages/web/bin/cli.js"), "session", ...args, ...scope, "--port", String(info.apiPort), "--json"], {
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
    const child = spawn(process.execPath, [join(REPO_ROOT, "packages/web/bin/cli.js"), "session", ...args, "--dir", info.project, "--port", String(info.apiPort), "--json"], { env, stdio: "ignore" })
    const done = new Promise((resolveDone) => child.once("exit", resolveDone).once("error", resolveDone))
    return { done, stop: () => { if (child.exitCode === null) child.kill("SIGTERM") } }
  }
  // `session list` names top-level sessions only; the raw list adds the ones
  // linked to a parent by metadata (workflow agents, an agent's own workers),
  // which deleting their parent leaves behind.
  const listLinkedSessions = async () => {
    const response = await fetch(`${info.apiUrl}/api/session?limit=1000`).catch(() => null)
    const listed = response?.ok ? listedSessions(await response.json()) : null
    return Array.isArray(listed) ? listed.map((record) => ({ id: record.id, directory: record.location?.directory ?? record.directory })) : []
  }
  const reset = async () => {
    const { sessions: roots = [] } = cli(["list", "--all", "--limit", "1000"], 120_000, { anyDirectory: true })
    const sessions = [...new Map([...roots, ...await listLinkedSessions()].map((session) => [session.id, session])).values()]
    const foreign = sessions.filter((session) => !insideStand(session.directory))
    if (foreign.length) throw new Error(`The server on ${info.apiUrl} holds sessions outside ${info.root} (${foreign[0].directory}); it is not this stand, so nothing was deleted.`)
    for (const session of sessions) {
      const response = await fetch(`${info.apiUrl}/api/session/${encodeURIComponent(session.id)}?directory=${encodeURIComponent(session.directory)}`, { method: "DELETE" })
      if (!response.ok && response.status !== 404) throw new Error(`Deleting session ${session.id} answered ${response.status}`)
    }
    for (const file of SETTINGS_FILES) {
      const baseline = join(info.root, SETTINGS_BASELINE, file)
      if (existsSync(baseline)) copyFileSync(baseline, join(info.data, file))
      else rmSync(join(info.data, file), { force: true })
    }
    gitIn(info.project, ["reset", "-q", "--hard", "HEAD"])
    gitIn(info.project, ["clean", "-fdq"])
    // Sidebar folders, which the server keeps for every window. The Detailed
    // rows switch a scenario may leave on is a profile setting, dropped below.
    rmSync(join(info.data, "sessions-directories.json"), { force: true })
    await resetProfile(info.data, info.apiUrl)
  }
  const outsideControl = async () => { throw new Error("server.stop and server.start need a stand this run started; they do not work with --attach") }
  return { ...info, cli, cliInBackground, reset, describe: () => info, stop: async () => undefined, stopApi: outsideControl, startApi: outsideControl }
}
