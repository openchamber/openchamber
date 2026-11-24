import { spawn, spawnSync } from "node:child_process"
import { networkInterfaces, userInfo } from "node:os"

const INSIDE = "OPENCHAMBER_VERIFY_NAMESPACE"
const LOOPBACK_UP = 'ip link set lo up && exec "$@"'

/** Nothing but loopback has an address, so no process here can leave the machine. */
export const hasOnlyLoopback = () => Object.values(networkInterfaces()).flat().every((address) => address.internal)

const asUser = () => {
  const { uid, gid } = userInfo()
  return ["sudo", "-n", "unshare", "--net", "sh", "-c", `ip link set lo up && exec setpriv --reuid=${uid} --regid=${gid} --init-groups env -i "$@"`, "sh"]
}

const environment = (env) => Object.entries(env).map(([name, value]) => `${name}=${value}`)

/** The commands that enter a namespace without a network, the one without root first. */
export const namespaceCommands = (command, env) => [
  ["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "sh", "-c", LOOPBACK_UP, "sh", ...command],
  [...asUser(), ...environment(env), ...command],
]

/**
 * Linux: plays the run in a network namespace that holds only loopback, so the
 * kernel refuses every way out for the runner and all it starts, Chrome and
 * native programs included. Answers the exit code of the run it handed over
 * to, or null when this process is the one to play it.
 */
export const enterNamespace = async () => {
  if (process.platform !== "linux") return null
  if (process.env[INSIDE]) {
    if (!hasOnlyLoopback()) throw new Error("The verify run still reaches a network inside its namespace")
    return null
  }
  const env = { ...process.env, [INSIDE]: "1" }
  const works = namespaceCommands(["true"], { PATH: process.env.PATH }).findIndex(([executable, ...args]) => spawnSync(executable, args, { stdio: "ignore" }).status === 0)
  if (works < 0) throw new Error("The verify stand needs a network namespace on Linux, so that nothing it starts can reach a hosted model. Allow unprivileged user namespaces or passwordless sudo.")
  const [executable, ...args] = namespaceCommands([process.execPath, ...process.execArgv, ...process.argv.slice(1)], env)[works]
  const child = spawn(executable, args, { env, stdio: "inherit" })
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
  return new Promise((done, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => done(code ?? (signal === "SIGINT" ? 130 : 143)))
  })
}
