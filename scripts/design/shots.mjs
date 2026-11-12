#!/usr/bin/env node
/**
 * Screenshots of a fixed set of OpenChamber screens for design review.
 *
 *   node scripts/design/shots.mjs --label <name>
 *
 * Starts an isolated server on the built UI (`packages/web/dist`) with scratch
 * state under `tmp/ui-shots/state`, seeds a project with believable sessions
 * through the fixture provider (cached in `tmp/ui-shots/seed`), drives headless
 * Chrome to each screen in the default dark and light themes, and writes
 * `tmp/ui-shots/<label>/<dark|light>/<nn-name>.png` with a `manifest.json`.
 * Everything it started is stopped on exit, failure included.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { DatabaseSync } from "node:sqlite"

import { CdpClient, launchChrome, reservePort, resolveChrome, resolveProfileDir, wait } from "../perf/cdp.mjs"
import { DESIGN_PROJECT_FILES, DESIGN_RETRY_EDITED, DESIGN_SESSIONS } from "../perf/fixture-conversations.mjs"
import { REPO_ROOT, restoreState, startFixture, startIsolatedServer } from "../perf/isolated-server.mjs"

const HELP = `Usage: node scripts/design/shots.mjs --label <name> [options]

Options:
  --label <name>     Output directory under tmp/ui-shots (required)
  --only <names>     Comma-separated shot names or numbers, such as 02,07-search
  --themes <list>    dark,light (default: both)
  --reseed           Rebuild the seeded sessions even when the cache matches
  --hold             Keep the server and Chrome running after the shots, until Ctrl-C
  --chrome <path>    Chrome executable
  --help             Show this help

SHOTS_DEBUG=1 prints what each wait for a still page sees: fonts, running
animations, loading indicators, layout changes and requests in flight.`

const ROOT = join(REPO_ROOT, "tmp/ui-shots")
const STATE = join(ROOT, "state")
const SEED = join(ROOT, "seed")
const PROJECT = join(ROOT, "project")
const DIST = join(REPO_ROOT, "packages/web/dist")
// Bump when the seeding steps below change what the seed holds.
const SEED_VERSION = 2

// The comparison shots of other apps are a 1454x841 window at 2x.
const VIEWPORT = { width: 1454, height: 841, deviceScaleFactor: 2 }
const NARROW_VIEWPORT = { width: 900, height: 841, deviceScaleFactor: 2 }
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Relay Desk",
  GIT_AUTHOR_EMAIL: "dev@relay-desk.test",
  GIT_COMMITTER_NAME: "Relay Desk",
  GIT_COMMITTER_EMAIL: "dev@relay-desk.test",
  GIT_AUTHOR_DATE: "2026-01-05T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-05T10:00:00Z",
  // The user's git config (signing, hooks, templates) stays out of the scratch repo.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

// The seeded sessions run on this model. OpenCode lists the real providers'
// models from the catalog it bundles (models.dev fetching is off, so the list
// is the same on every run); the fixture provider answers for all of them.
const SEED_MODEL = "anthropic/claude-sonnet-4-5"
const SERVER_ENV = { OPENCODE_DISABLE_MODELS_FETCH: "1" }
const projectConfig = (fixturePort) => {
  const provider = { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${fixturePort}/v1`, apiKey: "unused" } }
  return {
    $schema: "https://opencode.ai/config.json",
    // The fixture's own rate-named models stay out of the picker.
    disabled_providers: ["perf"],
    provider: { anthropic: provider, openai: provider, google: provider },
    compaction: { auto: false },
  }
}

/**
 * The moment the app believes it is: the latest 08:42 UTC (10:42 or 11:42 in
 * Kyiv) not after the real time. The page clock starts there and the seeded
 * history is stamped relative to it, so greetings, relative ages and dates
 * read the same on every run of the same day, and the server never sees a
 * timestamp from its future.
 */
const fixedNow = (real = Date.now()) => {
  const day = new Date(real)
  const candidate = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8, 42)
  return candidate <= real ? candidate : candidate - 24 * 60 * 60_000
}
const TIMEZONE = "Europe/Kyiv"
const LOCALE = "en-US"

const parseArgs = (argv) => {
  const options = { label: null, only: null, themes: ["dark", "light"], reseed: false, hold: false, chrome: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--only") options.only = String(argv[++index]).split(",").map((item) => item.trim()).filter(Boolean)
    else if (value === "--themes") options.themes = String(argv[++index]).split(",").map((item) => item.trim()).filter(Boolean)
    else if (value === "--reseed") options.reseed = true
    else if (value === "--hold") options.hold = true
    else if (value === "--chrome") options.chrome = argv[++index]
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!options.label || !/^[\w.-]+$/.test(options.label)) throw new Error("--label <name> is required (letters, digits, dot, dash, underscore)")
  if (options.themes.some((theme) => theme !== "dark" && theme !== "light")) throw new Error("--themes takes dark and/or light")
  return options
}

const log = (message) => console.log(`[shots] ${message}`)

// --- Scratch project -------------------------------------------------------

const git = (args) => execFileSync("git", args, { cwd: PROJECT, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] })

/**
 * Rebuilds the project from scratch: the committed starting point the
 * seeding conversation edits, with `uncommitted` deciding whether the working
 * tree also carries the edits the Git shot shows. The commit is identical on
 * every run (fixed dates and author), so its hash is too.
 */
const writeProject = (fixturePort, { uncommitted }) => {
  rmSync(PROJECT, { recursive: true, force: true })
  mkdirSync(PROJECT, { recursive: true })
  const files = { ...DESIGN_PROJECT_FILES, "opencode.json": `${JSON.stringify(projectConfig(fixturePort), null, 2)}\n` }
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(PROJECT, file)), { recursive: true })
    writeFileSync(join(PROJECT, file), content)
  }
  git(["init", "-q", "-b", "main"])
  // The perf tooling writes its read fixtures into every project it serves,
  // and opencode.json names this run's fixture port.
  writeFileSync(join(PROJECT, ".git/info/exclude"), "perf-read/\nopencode.json\n")
  git(["add", "-A"])
  git(["commit", "-q", "-m", "Initial import of the support inbox"])
  if (!uncommitted) return
  writeFileSync(join(PROJECT, "src/api/retry.ts"), DESIGN_RETRY_EDITED)
  writeFileSync(join(PROJECT, "src/api/client.ts"), DESIGN_PROJECT_FILES["src/api/client.ts"]
    .replace("    attempts: 4,\n", "    attempts: 3,\n")
    .replace("export const markRead = (id: string) =>\n  request<void>(`/conversations/${id}/read`, { method: \"POST\" })\n",
      "export const markRead = (id: string, signal?: AbortSignal) =>\n  request<void>(`/conversations/${id}/read`, { method: \"POST\", signal })\n"))
  writeFileSync(join(PROJECT, "src/api/abort.test.ts"), [
    "import { expect, it, vi } from \"vitest\"",
    "import { withRetry } from \"./retry\"",
    "",
    "it(\"does not retry a cancelled request\", async () => {",
    "  const controller = new AbortController()",
    "  const run = vi.fn(async () => {",
    "    controller.abort()",
    "    throw new DOMException(\"The operation was aborted.\", \"AbortError\")",
    "  })",
    "  await expect(withRetry(run, { attempts: 3, baseDelayMs: 1, signal: controller.signal })).rejects.toThrow(\"aborted\")",
    "  expect(run).toHaveBeenCalledTimes(1)",
    "})",
    "",
  ].join("\n"))
}

// --- Seed ------------------------------------------------------------------

/**
 * What the seed depends on: the conversation and project content (ages,
 * spans and work state are applied per run, so they are left out), the
 * fixture and the server setup.
 */
const seedKey = () => {
  const hash = createHash("sha256")
  hash.update(String(SEED_VERSION))
  hash.update(JSON.stringify(DESIGN_SESSIONS.map(({ key, title, pinned, turns }) => ({ key, title, pinned, turns }))))
  hash.update(JSON.stringify(DESIGN_PROJECT_FILES))
  hash.update(SEED_MODEL)
  hash.update(JSON.stringify([SERVER_ENV, projectConfig(0)]))
  for (const file of ["scripts/perf/fixture-provider.mjs", "scripts/perf/isolated-server.mjs"]) {
    hash.update(readFileSync(join(REPO_ROOT, file)))
  }
  return hash.digest("hex").slice(0, 16)
}

/**
 * Places the seeded history in time relative to `now`, in the restored state
 * before the server starts. Seeding runs at fixture speed, so every session
 * was made within a minute and every turn took milliseconds; a reviewer
 * would see "now" on every row and "0s" on every turn. Each session's
 * timestamps are stretched over its `spanMinutes` and moved to end
 * `ageMinutes` before `now`, so the labels read the same on every run.
 * Sessions without `inWork` are marked done, as a user would have.
 */
const stampTimes = (ids, now) => {
  const db = new DatabaseSync(join(STATE, "home/.local/share/opencode/opencode.db"))
  try {
    for (const session of DESIGN_SESSIONS) {
      const id = ids[session.key]
      const row = db.prepare("SELECT time_created, time_updated, metadata FROM session_v2 WHERE id = ?").get(id)
      if (!row) throw new Error(`Seeded session ${session.key} (${id}) is missing from the database; rerun with --reseed.`)
      const start = row.time_created
      const end = row.time_updated
      const newEnd = now - session.ageMinutes * 60_000
      const scale = (session.spanMinutes * 60_000) / Math.max(1, end - start)
      const inWindow = (value) => value >= start - 5_000 && value <= end + 5_000
      const map = (value) => Math.round(newEnd - (end - value) * scale)
      // Every number in the stored JSON that falls inside the session's time
      // window is a timestamp; durations scale with the stretch.
      const remap = (key, value) => {
        if (!Number.isFinite(value)) return value
        if (key === "durationMs") return Math.round(value * scale)
        return inWindow(value) ? map(value) : value
      }
      const remapJson = (text) => (text ? JSON.stringify(JSON.parse(text, remap)) : text)
      const metadata = JSON.parse(row.metadata ?? "{}", remap)
      metadata.openchamber = { ...metadata.openchamber }
      metadata.openchamber.work = session.inWork
        ? { state: "open", openedAt: map(start), openedBy: "auto" }
        : { state: "done", openedAt: map(start), openedBy: "auto", doneAt: newEnd + 60_000 }
      const timeOrNull = (value) => (value === null ? null : map(value))
      const current = db.prepare("SELECT time_busy, time_idle, time_viewed FROM session_v2 WHERE id = ?").get(id)
      db.prepare("UPDATE session_v2 SET time_created = ?, time_updated = ?, time_busy = ?, time_idle = ?, time_viewed = ?, metadata = ? WHERE id = ?")
        .run(map(start), newEnd, timeOrNull(current.time_busy), timeOrNull(current.time_idle), newEnd, JSON.stringify(metadata), id)
      for (const table of ["session_message", "session_part"]) {
        const key = table === "session_message" ? "id" : "message_id, ordinal"
        const rows = db.prepare(`SELECT ${key}, time_created, time_updated, data FROM ${table} WHERE session_id = ?`).all(id)
        const update = table === "session_message"
          ? db.prepare("UPDATE session_message SET time_created = ?, time_updated = ?, data = ? WHERE id = ?")
          : db.prepare("UPDATE session_part SET time_created = ?, time_updated = ?, data = ? WHERE message_id = ? AND ordinal = ?")
        for (const entry of rows) {
          const args = [map(entry.time_created), map(entry.time_updated), remapJson(entry.data)]
          if (table === "session_message") update.run(...args, entry.id)
          else update.run(...args, entry.message_id, entry.ordinal)
        }
      }
    }
  } finally {
    db.close()
  }
  // Every seeded session counts as read.
  writeFileSync(join(STATE, "oc-data/sessions-unread.json"), JSON.stringify({ since: now }))
}

const readSeed = () => {
  try {
    return JSON.parse(readFileSync(join(SEED, "seed.json"), "utf8"))
  } catch {
    return null
  }
}

const runCli = (port, args, timeoutMs = 180_000) => {
  const output = execFileSync(process.execPath, [join(REPO_ROOT, "packages/web/bin/cli.js"), "session", ...args, "--dir", PROJECT, "--port", String(port), "--json"], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return JSON.parse(output)
}

/** Creates the sessions oldest first, plays each turn, and pins the pinned ones. */
const seedSessions = async (server, port) => {
  const ids = {}
  for (const session of [...DESIGN_SESSIONS].reverse()) {
    const created = runCli(port, ["create", "--title", session.title])
    ids[session.key] = created.sessionId
    for (const turn of session.turns) {
      runCli(port, ["send", "--session", created.sessionId, "--prompt", turn.prompt, "--model", SEED_MODEL, "--wait", "--timeout", "120"])
    }
    if (session.pinned) {
      const response = await fetch(`${server.url}/api/openchamber/sessions/${encodeURIComponent(created.sessionId)}/metadata`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { openchamber: { pinned: { at: Date.now() } } } }),
      })
      if (!response.ok) throw new Error(`Pinning ${session.key} failed with ${response.status}: ${await response.text()}`)
    }
    log(`seeded ${session.key} (${created.sessionId})`)
  }
  const main = runCli(port, ["messages", "--session", ids.main, "--limit", "20"])
  const assistant = (main.messages ?? []).filter((message) => (message.info?.role ?? message.role) === "assistant").length
  if (assistant < 2) throw new Error(`The main conversation has ${assistant} assistant messages; check ${join(ROOT, "fixture.log")}.`)
  return ids
}

// --- Processes -------------------------------------------------------------

const cleanups = []
const runCleanups = async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    try { await cleanup() } catch (error) { console.error(`[shots] cleanup failed: ${error.message}`) }
  }
}

const startStack = async () => {
  const fixturePort = await reservePort()
  const serverPort = await reservePort()
  mkdirSync(ROOT, { recursive: true })
  const fixture = await startFixture({ port: fixturePort, logFile: join(ROOT, "fixture.log") })
  cleanups.push(() => fixture.stop())
  return { fixturePort, serverPort }
}

const startServer = async (ports) => {
  const server = await startIsolatedServer({
    repo: REPO_ROOT,
    dist: DIST,
    state: STATE,
    project: PROJECT,
    port: ports.serverPort,
    fixturePort: ports.fixturePort,
    logFile: join(ROOT, "server.log"),
    env: SERVER_ENV,
  })
  cleanups.push(() => server.stop())
  return server
}

/** OpenChamber's own settings for the scratch state, written before its first start. */
const writeSettings = () => {
  const dataDir = join(STATE, "oc-data")
  mkdirSync(dataDir, { recursive: true })
  const id = `path_${Buffer.from(PROJECT).toString("base64url")}`
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
    homeDirectory: join(STATE, "home"),
    projects: [{ id, path: PROJECT, label: "relay-desk", addedAt: Date.parse("2026-01-05T10:00:00Z"), lastOpenedAt: Date.parse("2026-01-05T10:00:00Z"), sidebarCollapsed: false }],
    activeProjectId: id,
    lastDirectory: PROJECT,
    defaultModel: SEED_MODEL,
    // Thinking rows on, as most people who look at the transcript run it; a
    // new profile starts with them off, and 03-chat-tools shows two.
    showReasoningTraces: true,
  }, null, 2))
}

const ensureSeed = async (options, ports) => {
  const key = seedKey()
  const cached = readSeed()
  if (!options.reseed && cached?.key === key && existsSync(join(SEED, "state"))) {
    log(`seed ${key} cached`)
    return cached
  }
  log(`seeding ${key}`)
  rmSync(STATE, { recursive: true, force: true })
  writeSettings()
  writeProject(ports.fixturePort, { uncommitted: false })
  const server = await startServer(ports)
  const ids = await seedSessions(server, ports.serverPort)
  await cleanups.pop()()
  rmSync(SEED, { recursive: true, force: true })
  mkdirSync(SEED, { recursive: true })
  cpSync(STATE, join(SEED, "state"), { recursive: true })
  const seed = { key, ids }
  writeFileSync(join(SEED, "seed.json"), JSON.stringify(seed, null, 2))
  return seed
}

// --- Page ------------------------------------------------------------------

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
// The app binds `mod` to Command where the platform is a Mac, Ctrl elsewhere.
const MOD = process.platform === "darwin" ? "meta" : "ctrl"

const KEYS = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13 },
  Backspace: { code: "Backspace", keyCode: 8 },
  End: { code: "End", keyCode: 35 },
  ",": { code: "Comma", keyCode: 188 },
}

/** One browser tab, driven the way a user drives the app: pointer, keyboard, URL. */
class Page {
  constructor(client) {
    this.client = client
    // Data requests and fonts in flight, by id, with when they started.
    // Other kinds are left out: Chrome never reports a worker's script
    // finished to the page. Event streams stay open for the
    // page's lifetime, so they are dropped once their response says what
    // they are.
    this.inflight = new Map()
    client.on("Network.requestWillBeSent", ({ requestId, type, request }) => {
      if (type !== "Fetch" && type !== "XHR" && type !== "Font") return
      // The manifest request is never reported finished either, whoever sends it.
      if (/\.webmanifest\b/.test(request.url)) return
      this.inflight.set(requestId, { startedAt: Date.now(), url: request.url })
    })
    client.on("Network.responseReceived", ({ requestId, response }) => {
      if (/event-stream/.test(response.mimeType ?? "")) this.inflight.delete(requestId)
    })
    client.on("Network.loadingFinished", ({ requestId }) => this.inflight.delete(requestId))
    client.on("Network.loadingFailed", ({ requestId }) => this.inflight.delete(requestId))
  }

  /** URLs still loading, other than ones open for over 15 s (long polls). */
  pendingRequests() {
    const cutoff = Date.now() - 15_000
    return [...this.inflight.values()].filter(({ startedAt }) => startedAt > cutoff).map(({ url, startedAt }) => `${url.replace(/^https?:\/\/[^/]+/, "")}${process.env.SHOTS_DEBUG ? `@${Date.now() - startedAt}` : ""}`)
  }

  static async open(chromePort, browserContextId) {
    const browser = await browserInfo(chromePort)
    const root = new CdpClient(browser.webSocketDebuggerUrl)
    await root.connect()
    const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId })
    root.close()
    const client = new CdpClient(`ws://127.0.0.1:${chromePort}/devtools/page/${targetId}`)
    await client.connect()
    const page = new Page(client)
    await client.send("Page.enable")
    await client.send("Runtime.enable")
    await client.send("Network.enable")
    return page
  }

  async evaluate(expression) {
    const result = await this.client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result?.value ?? null
  }

  async setViewport({ width, height, deviceScaleFactor }) {
    await this.client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false })
  }

  async setTheme(theme) {
    await this.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "no-preference" }] })
  }

  async navigate(url) {
    const loaded = this.client.once("Page.loadEventFired", 60_000)
    await this.client.send("Page.navigate", { url })
    await loaded
  }

  /** Resolves once `expression` is truthy in the page, with its value. */
  async waitFor(expression, { timeoutMs = 20_000, what = expression } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await this.evaluate(`(() => { try { return ${expression} } catch { return null } })()`)
      if (value) return value
      await wait(100)
    }
    throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`)
  }

  /** The center of the first visible element matching `selector` (and `text`, when given). */
  async locate(selector, { text = null, exact = false, timeoutMs = 20_000 } = {}) {
    const find = `(() => {
      const text = ${JSON.stringify(text)}
      const exact = ${exact}
      for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
        const content = (element.textContent ?? "").trim()
        if (text !== null && (exact ? content !== text : !content.includes(text))) continue
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const style = getComputedStyle(element)
        if (style.visibility === "hidden" || style.display === "none") continue
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }
      return null
    })()`
    return this.waitFor(find, { timeoutMs, what: `${selector}${text ? ` with "${text}"` : ""}` })
  }

  async mouse(type, point, extra = {}) {
    await this.client.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra })
  }

  async hover(selector, options) {
    const point = await this.locate(selector, options)
    await this.mouse("mouseMoved", point)
    return point
  }

  async click(selector, { button = "left", ...options } = {}) {
    const point = await this.hover(selector, options)
    await this.mouse("mousePressed", point, { button, buttons: button === "right" ? 2 : 1, clickCount: 1 })
    await this.mouse("mouseReleased", point, { button, buttons: 0, clickCount: 1 })
  }

  async moveMouseAway() {
    await this.mouse("mouseMoved", { x: 1, y: 1 })
  }

  /** A key press with modifiers, such as `press("p", ["meta"])`. */
  async press(key, modifiers = []) {
    const mask = modifiers.reduce((sum, name) => sum | MODIFIERS[name], 0)
    const known = KEYS[key]
    const isChar = !known && key.length === 1
    const code = known?.code ?? (isChar ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`) : key)
    const keyCode = known?.keyCode ?? (isChar ? key.toUpperCase().charCodeAt(0) : 0)
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mask }
    // A plain character also produces text; a chord with Command or Ctrl does not.
    const text = isChar && !(mask & (MODIFIERS.meta | MODIFIERS.ctrl)) ? key : undefined
    const down = { type: text ? "keyDown" : "rawKeyDown", ...base }
    if (text) down.text = text
    await this.client.send("Input.dispatchKeyEvent", down)
    await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }

  async type(text) {
    await this.client.send("Input.insertText", { text })
  }

  /**
   * Waits until the page is still: fonts loaded, no finite animation or
   * transition running, no layout change for a few frames, and nothing
   * marked as loading in view. Spinners and skeletons that stay are
   * reported, so a shot of a half-loaded screen says so.
   */
  async settle({ timeoutMs = 15_000 } = {}) {
    const probe = `(async () => {
      await document.fonts.ready
      // A hidden tab gets no frames; the timeout keeps the probe from hanging there.
      const frame = () => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 250) })
      const visible = (element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
          && getComputedStyle(element).visibility !== "hidden"
      }
      const running = document.getAnimations().filter((animation) => {
        if (animation.playState !== "running") return false
        const timing = animation.effect?.getComputedTiming?.()
        return timing && Number.isFinite(timing.endTime)
      }).length
      const loading = [...document.querySelectorAll('[aria-busy="true"], [data-spinner], .animate-spin, .animate-pulse, [data-slot="skeleton"], [class*="skeleton" i], [role="progressbar"]')]
        .filter(visible)
        .map((element) => (element.getAttribute("aria-label") || element.className?.baseVal || element.className || element.tagName).toString().slice(0, 80))
      // Loading placeholders that say so in words, such as "Loading sessions...".
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const text = walker.currentNode.nodeValue.trim()
        const parent = walker.currentNode.parentElement
        if (/^Loading\b/i.test(text) && parent && parent.tagName !== "SCRIPT" && parent.tagName !== "STYLE" && visible(parent)) loading.push(text.slice(0, 80))
      }
      let signature = ""
      for (let index = 0; index < 3; index += 1) {
        await frame()
        signature += document.body.innerHTML.length + ":" + document.body.scrollHeight + ";"
      }
      const stable = signature.split(";").filter(Boolean).every((entry, _, all) => entry === all[0])
      return { fonts: document.fonts.status, running, loading, stable }
    })()`
    const deadline = Date.now() + timeoutMs
    let last = null
    let quietSince = null
    while (Date.now() < deadline) {
      last = { ...await this.evaluate(probe), requests: this.pendingRequests() }
      if (process.env.SHOTS_DEBUG) console.log(JSON.stringify(last))
      const quiet = last.fonts === "loaded" && last.running === 0 && last.loading.length === 0 && last.stable && last.requests.length === 0
      if (quiet) {
        quietSince ??= Date.now()
        // Still for 600 ms: long enough for a delayed popover, a debounced
        // render, or a request that a finished one triggers.
        if (Date.now() - quietSince >= 600) return { settled: true, loading: [] }
      } else {
        quietSince = null
      }
      await wait(100)
    }
    return { settled: false, loading: last?.loading ?? [], running: last?.running ?? 0, requests: last?.requests ?? [] }
  }

  async screenshot(file) {
    const { data } = await this.client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
    writeFileSync(file, Buffer.from(data, "base64"))
  }

  close() {
    this.client.close()
  }
}

// --- Shots -----------------------------------------------------------------

const MAIN_PROMPT = DESIGN_SESSIONS[0].turns[0].prompt
const FIX_PROMPT = DESIGN_SESSIONS[0].turns[1].prompt
const MAIN_TITLE = DESIGN_SESSIONS[0].title

/** Opens the app at `query` and waits until the sidebar lists the seeded sessions. */
const openApp = async (page, ctx, query = "") => {
  await page.navigate(`${ctx.url}/${query}`)
  await page.waitFor(`!document.getElementById("initial-loading") && !!document.querySelector('[data-session-row="${ctx.ids.main}"]')`, { timeoutMs: 60_000, what: "the sidebar's seeded sessions" })
  await page.moveMouseAway()
  // The sidebar's Chats block shows "Loading sessions..." for a moment and
  // shifts every row below it, so nothing is clicked before the page is still.
  await page.settle()
}

const openMainSession = async (page, ctx) => {
  await openApp(page, ctx, `?session=${ctx.ids.main}`)
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(FIX_PROMPT)})`, { what: "the main conversation" })
}

/**
 * Scrolls the chat with the mouse wheel until the element holding `text`
 * sits `offset` pixels below the top of the viewport.
 */
const scrollChatTo = async (page, text, offset) => {
  const find = `(() => {
    const walker = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (!walker.currentNode.nodeValue.includes(${JSON.stringify(text)})) continue
      const rect = walker.currentNode.parentElement.getBoundingClientRect()
      return { top: rect.top, x: rect.left + 40, y: Math.min(innerHeight - 200, Math.max(200, rect.top)) }
    }
    return null
  })()`
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const target = await page.evaluate(find)
    if (!target) {
      // Not rendered yet: the list renders the tail first, so wheel up.
      await page.mouse("mouseWheel", { x: 700, y: 400 }, { deltaX: 0, deltaY: -2000 })
      await wait(300)
      continue
    }
    const delta = target.top - offset
    if (Math.abs(delta) < 2) return
    await page.mouse("mouseWheel", { x: target.x, y: target.y }, { deltaX: 0, deltaY: delta })
    await wait(400)
  }
  throw new Error(`Could not scroll the chat to "${text.slice(0, 40)}"`)
}

/**
 * Opens `surface` in the right context panel, or closes the panel when
 * `surface` is null, through the rail's toggle buttons.
 */
const setContextPanel = async (page, surface) => {
  const pressed = await page.evaluate(`[...document.querySelectorAll("[data-context-surface][aria-pressed=true]")].map((button) => button.dataset.contextSurface)`)
  if (surface === null) {
    for (const open of pressed) await page.click(`[data-context-surface="${open}"]`)
  } else if (!pressed.includes(surface)) {
    await page.click(`[data-context-surface="${surface}"]`)
  }
  await page.moveMouseAway()
  await page.waitFor(surface === null
    ? `!document.querySelector("[data-context-surface][aria-pressed=true]")`
    : `!!document.querySelector('[data-context-surface="${surface}"][aria-pressed=true]')`, { what: `the context panel ${surface ?? "closed"}` })
}

/** Shots in order; each starts from a fresh load of the app. */
const SHOTS = [
  {
    name: "01-draft",
    async run(page, ctx) {
      await openApp(page, ctx)
      await page.hover("[data-sidebar-row-key]", { text: "relay-desk" })
      await page.click("button[aria-label=\"New draft session\"]")
      // The draft as a user usually sees it: the Session card beside it, no panel open.
      await setContextPanel(page, null)
    },
  },
  {
    name: "02-chat",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await scrollChatTo(page, MAIN_PROMPT.slice(0, 40), 90)
      // A few words typed, not sent: Send in its enabled state. 01-draft
      // keeps the empty composer for the disabled one.
      await page.click('[data-chat-input="true"] .cm-content')
      await page.type("Чи можна покрити це тестом?")
      await page.waitFor(`document.querySelector('[data-chat-input="true"] .cm-content')?.textContent.includes("тестом")`, { what: "the typed draft" })
      await page.moveMouseAway()
    },
    // The composer keeps a draft per session; the shots after this one in the
    // same browser context must see an empty composer again.
    async cleanup(page) {
      await page.click('[data-chat-input="true"] .cm-content')
      // Headless Chrome takes no select-all chord from synthetic keys, so the
      // draft goes back one character at a time.
      await page.press("End")
      for (let index = 0; index < 40; index += 1) await page.press("Backspace")
      await page.waitFor(`!document.querySelector('[data-chat-input="true"] .cm-content')?.textContent.includes("тестом")`, { what: "the cleared draft" })
    },
  },
  {
    name: "03-chat-tools",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await scrollChatTo(page, FIX_PROMPT, 90)
      // Tool calls render collapsed; open the first edit to show its diff.
      await page.click("main *", { text: "Edit File", exact: true })
      await page.moveMouseAway()
      // The diff renders inside the shadow root of a diffs-container.
      await page.waitFor(`[...document.querySelectorAll("main diffs-container")].some((element) => element.getBoundingClientRect().height > 100)`, { what: "the edit's diff" })
      await scrollChatTo(page, FIX_PROMPT, 90)
    },
  },
  {
    name: "04-settings-appearance",
    async run(page, ctx) {
      await openApp(page, ctx, `?session=${ctx.ids.main}&settings=appearance`)
      await page.locate("[role=dialog]", { text: "Color mode" })
    },
  },
  {
    name: "05-settings-sessions",
    async run(page, ctx) {
      await openApp(page, ctx, `?session=${ctx.ids.main}&settings=sessions`)
      await page.locate("[role=dialog]", { text: "Sessions" })
    },
  },
  {
    name: "06-model-picker",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await page.click(".model-controls__model-trigger")
      await page.moveMouseAway()
      await page.locate("[role=menu] input[placeholder=\"Search models\"]")
    },
  },
  {
    name: "07-search",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await page.click("button[aria-label=\"Search sessions\"]")
      await page.waitFor(`document.activeElement?.getAttribute("aria-label") === "Search sessions..."`, { what: "the session search field" })
      await page.type("повтор")
      await page.waitFor(`document.body.innerText.includes("matches")`, { what: "search results" })
    },
  },
  {
    name: "08-git",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, "git")
      // A file in the Git list opens the Changes view with its diff.
      await page.click("[role=list][aria-label=\"Changed files\"] [role=button]", { text: "retry.ts" })
      await page.moveMouseAway()
      await page.waitFor(`document.body.innerText.includes("Changed: 3") && [...document.querySelectorAll("diffs-container")].some((element) => element.getBoundingClientRect().height > 100)`, { what: "the Changes view with the diff of retry.ts" })
    },
  },
  {
    name: "09-files",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, "editor")
      await page.click("*", { text: "src", exact: true })
      await page.click("*", { text: "api", exact: true })
      await page.click("*", { text: "client.ts", exact: true })
      await page.moveMouseAway()
    },
  },
  {
    name: "10-menu",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await page.click(`[data-session-row="${ctx.ids["sidebar-scroll"]}"] [data-session-row-main]`, { button: "right" })
      await page.locate("[role=menu]")
    },
  },
  {
    name: "11-dialog",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await page.press("k", [MOD])
      await page.press("h")
      await page.locate("[role=dialog]")
    },
  },
  {
    name: "12-narrow",
    viewport: NARROW_VIEWPORT,
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, null)
      await scrollChatTo(page, MAIN_PROMPT.slice(0, 40), 90)
    },
  },
  {
    // A docked panel with tiles in it: the stat cards and Session Totals on
    // the panel's own colour. A panel fill that eats the tiles' tone step
    // went unseen while no shot had one.
    name: "13-context",
    async run(page, ctx) {
      await openMainSession(page, ctx)
      await setContextPanel(page, "context")
      await page.waitFor(`document.body.innerText.includes("Session Totals")`, { what: "the session context's Session Totals" })
    },
  },
]

const selectShots = (only) => {
  if (!only) return SHOTS
  const picked = SHOTS.filter((shot) => only.some((item) => shot.name === item || shot.name.startsWith(`${item}-`)))
  if (picked.length === 0) throw new Error(`--only matched no shot; names are ${SHOTS.map((shot) => shot.name).join(", ")}`)
  return picked
}

// Carets blink, so a focused composer would differ from run to run. The
// composer is CodeMirror, which draws its own caret layer.
const STEADY_CSS = "*, *::before, *::after { caret-color: transparent !important; } .cm-cursorLayer { visibility: hidden !important; }"

/**
 * Runs before the app: the page clock starts at `now` and moves on in real
 * time, and Math.random is a seeded generator, so choices the app makes at
 * random (the draft screen's greeting) come out the same on every run.
 */
const clockScript = (now) => `(() => {
  let seed = 0x5eed
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  const RealDate = Date
  const offset = ${now} - RealDate.now()
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args) }
    static now() { return RealDate.now() + offset }
  }
  globalThis.Date = FixedDate
})()`

/** Shoots every selected screen in one theme, in a browser context of its own. */
const browserInfo = async (chromePort) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // Not listening yet.
    }
    await wait(200)
  }
  throw new Error(`Chrome did not open its debugging port ${chromePort}`)
}

const shootTheme = async ({ chromePort, theme, shots, ctx, outDir }) => {
  const browser = await browserInfo(chromePort)
  const root = new CdpClient(browser.webSocketDebuggerUrl)
  await root.connect()
  const { browserContextId } = await root.send("Target.createBrowserContext", { disposeOnDetach: false })
  const results = []
  try {
    const page = await Page.open(chromePort, browserContextId)
    await page.client.send("Page.addScriptToEvaluateOnNewDocument", { source: clockScript(ctx.now) })
    await page.client.send("Emulation.setTimezoneOverride", { timezoneId: TIMEZONE })
    await page.client.send("Emulation.setLocaleOverride", { locale: LOCALE })
    await page.client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `addEventListener("DOMContentLoaded", () => { const style = document.createElement("style"); style.textContent = ${JSON.stringify(STEADY_CSS)}; document.head.append(style) })`,
    })
    mkdirSync(join(outDir, theme), { recursive: true })
    for (const shot of shots) {
      const viewport = shot.viewport ?? VIEWPORT
      const file = join(outDir, theme, `${shot.name}.png`)
      const startedAt = Date.now()
      try {
        await page.client.send("Page.bringToFront")
        await page.setViewport(viewport)
        await page.setTheme(theme)
        await shot.run(page, ctx)
        const settled = await page.settle()
        await page.screenshot(file)
        if (shot.cleanup) await shot.cleanup(page, ctx)
        results.push({ name: shot.name, theme, file: `${theme}/${shot.name}.png`, viewport, settled: settled.settled, loading: settled.loading, ms: Date.now() - startedAt })
        log(`${theme}/${shot.name}${settled.settled ? "" : ` (not settled: ${settled.loading.join(", ") || `${settled.running} animations, requests ${settled.requests.join(" ")}`})`}`)
      } catch (error) {
        await page.screenshot(join(outDir, theme, `${shot.name}.failed.png`)).catch(() => undefined)
        results.push({ name: shot.name, theme, error: error.message, viewport })
        log(`${theme}/${shot.name} FAILED: ${error.message}`)
      }
    }
    page.close()
  } finally {
    await root.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined)
    root.close()
  }
  return results
}

// --- Main ------------------------------------------------------------------

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()
  const ports = await startStack()
  const seed = await ensureSeed(options, ports)
  restoreState(STATE, join(SEED, "state"))
  const now = fixedNow()
  stampTimes(seed.ids, now)
  writeProject(ports.fixturePort, { uncommitted: true })
  const server = await startServer(ports)
  log(`server ${server.url}, seeded in ${Math.round((Date.now() - startedAt) / 1000)}s`)

  const chromePort = await reservePort()
  const profile = resolveProfileDir(null, "ui-shots")
  const chrome = launchChrome({ chrome: resolveChrome(options.chrome), profileDir: profile.dir, port: chromePort, headless: true, extraArgs: ["--window-size=1454,841", "--hide-scrollbars", `--lang=${LOCALE}`] })
  profile.removeAfter(chrome)
  cleanups.push(async () => {
    if (chrome.exitCode !== null) return
    chrome.kill("SIGTERM")
    for (let attempt = 0; attempt < 20 && chrome.exitCode === null; attempt += 1) await wait(250)
    if (chrome.exitCode === null) chrome.kill("SIGKILL")
  })

  const shots = selectShots(options.only)
  const outDir = join(ROOT, options.label)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const ctx = { url: server.url, ids: seed.ids, now }
  const results = []
  for (const theme of options.themes) {
    results.push(...await shootTheme({ chromePort, theme, shots, ctx, outDir }))
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
    label: options.label,
    createdAt: new Date().toISOString(),
    seconds,
    bundle: server.bundle.served,
    seed: seed.key,
    shots: results,
  }, null, 2))
  const failed = results.filter((result) => result.error)
  const unsettled = results.filter((result) => !result.error && !result.settled)
  log(`${results.length - failed.length} of ${results.length} shots in ${outDir} (${seconds}s)${unsettled.length ? `; not settled: ${unsettled.map((result) => `${result.theme}/${result.name}`).join(", ")}` : ""}`)

  if (options.hold) {
    log(`holding: server ${server.url}, chrome debugging port ${chromePort}, sessions ${JSON.stringify(seed.ids)}`)
    await new Promise(() => {})
  }
  if (failed.length > 0) throw new Error(`${failed.length} shots failed: ${failed.map((result) => `${result.theme}/${result.name}`).join(", ")}`)
}

let stopping = false
const stop = async (code) => {
  if (stopping) return
  stopping = true
  await runCleanups()
  process.exit(code)
}
process.once("SIGINT", () => { void stop(130) })
process.once("SIGTERM", () => { void stop(143) })

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => stop(0), (error) => {
    console.error(`[shots] failed: ${error.stack ?? error.message}`)
    void stop(1)
  })
}

