#!/usr/bin/env node
/**
 * Builds a long session for switch and render captures.
 *
 * Session-switch cost depends on how much history a session carries, and a
 * development workspace rarely has a session with a hundred turns of code and
 * prose. This creates one through the supported `openchamber session` CLI
 * against the fixture provider, so the history is identical every time it is
 * rebuilt: turns cycle through the prose, code-fence and non-Latin fixture
 * documents at seeding speed.
 *
 *   node scripts/perf/seed-long-session.mjs --port 4599 --dir <project> --turns 120 --title "perf: long 120"
 *
 * The server must have been started with the fixture provider's configuration
 * (see DOCUMENTATION.md). Prints the session id, and with --json the summary.
 */

import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const cliPath = join(repoRoot, "packages/web/bin/cli.js")

const HELP = `Usage: node scripts/perf/seed-long-session.mjs --port <port> --dir <path> [options]

Options:
  --port <port>     OpenChamber server port (required)
  --dir <path>      Project directory the session belongs to (required)
  --turns <n>       Number of prompt/response turns (default: 120)
  --title <text>    Session title (default: "perf: long <turns>")
  --models <list>   Comma-separated models cycled per turn
                    (default: perf/stream-20000cps,perf/code-20000cps,perf/unicode-20000cps)
  --session <id>    Append turns to this session instead of creating one
  --json            Print a JSON summary
  --help            Show this help`

const parseArgs = (argv) => {
  const options = {
    port: null,
    dir: null,
    turns: 120,
    title: null,
    models: ["perf/stream-20000cps", "perf/code-20000cps", "perf/unicode-20000cps"],
    session: null,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") { console.log(HELP); process.exit(0) }
    else if (value === "--port") options.port = argv[++index]
    else if (value === "--dir") options.dir = resolve(argv[++index])
    else if (value === "--turns") options.turns = Number(argv[++index])
    else if (value === "--title") options.title = argv[++index]
    else if (value === "--models") options.models = String(argv[++index]).split(",").map((model) => model.trim()).filter(Boolean)
    else if (value === "--session") options.session = argv[++index]
    else if (value === "--json") options.json = true
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!options.port || !options.dir) throw new Error("--port and --dir are required")
  if (!Number.isInteger(options.turns) || options.turns < 1) throw new Error("--turns must be a positive integer")
  return options
}

const runSessionCli = (args, timeoutMs = 120_000) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [cliPath, "session", ...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`session ${args[0]} timed out`)) }, timeoutMs)
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("error", (error) => { clearTimeout(timer); reject(error) })
  child.on("close", (code) => {
    clearTimeout(timer)
    if (code !== 0) { reject(new Error(`session ${args[0]} exited with ${code}: ${stderr.trim() || stdout.trim()}`)); return }
    try { resolveRun(JSON.parse(stdout)) } catch { reject(new Error(`session ${args[0]} returned unparseable output: ${stdout.slice(0, 300)}`)) }
  })
})


/**
 * Assistant replies that belong to the current run (#2157): the messages
 * after the pre-run boundary (the latest assistant message that existed
 * before this invocation sent anything), in the chronological order the
 * session CLI returns. A null boundary (fresh session) counts everything.
 * If the boundary has scrolled out of the fetched window, everything in
 * the window is newer than it, so everything counts.
 */
export const countRunReplies = (messages, boundaryId) => {
  const list = Array.isArray(messages) ? messages : []
  if (!boundaryId) return list.length
  const index = list.findIndex((message) => message?.id === boundaryId)
  return index < 0 ? list.length : list.length - index - 1
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const base = ["--dir", options.dir, "--port", String(options.port)]
  let sessionId = options.session
  if (!sessionId) {
    const created = await runSessionCli(["create", ...base, "--title", options.title ?? `perf: long ${options.turns}`])
    sessionId = created.sessionId
  }
  // Per-run validation boundary (#2157): the latest assistant reply that
  // already exists before this invocation sends anything. On a reused
  // --session, historical replies must not count toward this run's check.
  const boundaryResult = await runSessionCli(["messages", ...base, "--session", sessionId, "--limit", "1", "--role", "assistant"])
  const boundaryMessages = boundaryResult?.messages ?? []
  const boundaryId = boundaryMessages.length > 0 ? (boundaryMessages[boundaryMessages.length - 1]?.id ?? null) : null
  const startedAt = Date.now()
  for (let turn = 1; turn <= options.turns; turn += 1) {
    const model = options.models[(turn - 1) % options.models.length]
    await runSessionCli(["send", ...base, "--session", sessionId, "--prompt", `Turn ${turn}: explain the next part.`, "--model", model, "--wait", "--timeout", "120"])
    if (!options.json && (turn % 10 === 0 || turn === options.turns)) console.log(`${turn}/${options.turns} turns`)
  }
  // A provider that rejected the requests would leave a session of user
  // messages only, which renders nothing like real history. The CLI pages
  // messages (`--all` still returns 10, and a large `--limit` trips the
  // server's cap), so this checks the most recent turns, which a broken
  // provider could not have answered either.
  const checked = Math.min(options.turns, 20)
  // Fetch one extra message when a boundary exists: if the boundary is
  // still inside the window it is the (checked + 1)-th, and the checked
  // newest are this run's; if it scrolled out, the whole window is new.
  const fetchLimit = boundaryId ? checked + 1 : checked
  const messages = await runSessionCli(["messages", ...base, "--session", sessionId, "--limit", String(fetchLimit), "--role", "assistant"])
  const assistant = countRunReplies(messages?.messages ?? [], boundaryId)
  if (assistant < checked) throw new Error(`Only ${assistant} of this run's last ${checked} turns got an assistant reply; check the fixture provider.`)
  // Only the last turns are checked, so the count says so: a bare "20" next
  // to 120 turns reads as 100 missing replies. The count is scoped to this
  // run's replies (#2157); boundaryMessageId records the scope explicitly
  // (null on a fresh session, where every reply is this run's).
  const summary = { sessionId, turns: options.turns, lastTurnsChecked: checked, lastTurnsAnswered: assistant, boundaryMessageId: boundaryId, seconds: Math.round((Date.now() - startedAt) / 1000) }
  if (options.json) console.log(JSON.stringify(summary))
  else console.log(`Session ${sessionId}: ${options.turns} turns in ${summary.seconds}s; the last ${checked} all answered`)
}

// Guarded so the regression test (seed-long-session.test.mjs) can import
// countRunReplies without running a seed.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
