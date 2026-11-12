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

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const base = ["--dir", options.dir, "--port", String(options.port)]
  let sessionId = options.session
  if (!sessionId) {
    const created = await runSessionCli(["create", ...base, "--title", options.title ?? `perf: long ${options.turns}`])
    sessionId = created.sessionId
  }
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
  const messages = await runSessionCli(["messages", ...base, "--session", sessionId, "--limit", String(checked), "--role", "assistant"])
  const assistant = (messages?.messages ?? []).length
  if (assistant < checked) throw new Error(`Only ${assistant} of the last ${checked} turns got an assistant reply; check the fixture provider.`)
  // Only the last turns are checked, so the count says so: a bare "20" next
  // to 120 turns reads as 100 missing replies.
  const summary = { sessionId, turns: options.turns, lastTurnsChecked: checked, lastTurnsAnswered: assistant, seconds: Math.round((Date.now() - startedAt) / 1000) }
  if (options.json) console.log(JSON.stringify(summary))
  else console.log(`Session ${sessionId}: ${options.turns} turns in ${summary.seconds}s; the last ${checked} all answered`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
