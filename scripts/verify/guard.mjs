import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const PRELOAD = fileURLToPath(new URL("./network-guard.cjs", import.meta.url)).replaceAll("\\", "/")

// Nothing listens there. Bun's native client, curl and git go through it.
const DEAD_PROXY = "http://127.0.0.1:9"
const proxies = Object.fromEntries(["http_proxy", "https_proxy", "all_proxy"].flatMap((name) => [[name, DEAD_PROXY], [name.toUpperCase(), DEAD_PROXY]]))
const LOCAL_HOSTS = "localhost,127.0.0.1,::1"

/** The environment that loads the guard into every Node and Bun process started with it. */
export const guardEnv = (logFile) => ({
  ...proxies,
  no_proxy: LOCAL_HOSTS,
  NO_PROXY: LOCAL_HOSTS,
  OPENCHAMBER_VERIFY_GUARD_LOG: logFile,
  NODE_OPTIONS: `--require="${PRELOAD}"`,
  BUN_OPTIONS: `--preload=${PRELOAD}`,
})

// macOS: the kernel refuses every way out for the whole process tree, native
// programs included.
const SANDBOX = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))'

export const guardedCommand = (executable, args) => (process.platform === "darwin"
  ? { executable: "/usr/bin/sandbox-exec", args: ["-p", SANDBOX, executable, ...args] }
  : { executable, args })

const readRecords = (logFile) => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])

/** Reads each hosted-model request once, so it is charged to the scenario it happened in. */
export const createGuardReader = (logFile) => {
  let seen = 0
  return () => {
    const records = readRecords(logFile)
    const fresh = records.slice(seen)
    seen = records.length
    return fresh.filter((record) => record.type === "model")
  }
}

/** The process that serves OpenCode loaded the guard, at or after `since`. */
export const openCodeArmed = (logFile, since) => readRecords(logFile).some((record) => record.type === "armed" && record.at >= since && record.argv.includes("serve"))

export const describeHostedRequests = (requests) => `asked a hosted model, which the stand refused: ${[...new Set(requests.map(({ host, model }) => `provider ${host}, model ${model ?? "unknown"}`))].join("; ")}`
