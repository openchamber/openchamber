import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const pathOf = (path) => String(path ?? "").replace(/ \(deleted\)$/, "").replaceAll("\\", "/")
const inside = (path, root) => pathOf(path) === root || pathOf(path).startsWith(`${root}/`)
const keyOf = (record) => `${record.pid}:${record.started}`
const live = (record) => record && !record.state?.startsWith("Z")
// Windows retains the creator PID after exit, even when that PID is reused.
const parentOf = (record, byPid) => {
  const parent = byPid.get(record?.parent)
  return parent && Date.parse(parent.started) <= Date.parse(record.started) ? parent : undefined
}
const json = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return null }
}
const saveOwner = (file, owner) => {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(owner))
  renameSync(temporary, file)
}

/** OS identities, including birth time: a reused PID never inherits ownership. */
export const readProcesses = () => {
  if (process.platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $_.CreationDate } | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} }) | ConvertTo-Json -Compress"
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(text).map((record) => ({ ...record, command: record.command ?? "" }))
  }
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" }, maxBuffer: 16 * 1024 * 1024 })
  const records = text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: +match[1], parent: +match[2], group: +match[3], state: match[4], started: match[5], command: match[6] }] : []
  })
  if (process.platform === "linux") {
    for (const record of records) {
      try { record.cwd = pathOf(readlinkSync(`/proc/${record.pid}/cwd`)) } catch {}
    }
  } else {
    // lsof exits 1 when some processes disappear during the snapshot.
    let output
    try { output = execFileSync("lsof", ["-a", "-p", records.map((record) => record.pid).join(","), "-d", "cwd", "-Fn"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }) } catch (error) {
      if (error.status !== 1) throw error
      output = String(error.stdout ?? "")
    }
    const byPid = new Map(records.map((record) => [record.pid, record]))
    let current
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) current = byPid.get(+line.slice(1))
      if (line.startsWith("n") && current) current.cwd = pathOf(line.slice(1))
    }
  }
  return records
}

const ancestors = (records, pid) => {
  const byPid = new Map(records.map((record) => [record.pid, record]))
  const seen = new Set()
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    pid = parentOf(byPid.get(pid), byPid)?.pid
  }
  return seen
}

const matching = (records, identities) => {
  const keys = new Set(identities.map(keyOf))
  return records.filter((record) => live(record) && keys.has(keyOf(record)))
}

export const processDescendants = (records, selected) => {
  const byPid = new Map(records.map((record) => [record.pid, record]))
  let added = true
  while (added) {
    added = false
    for (const record of records) {
      if (selected.has(parentOf(record, byPid)?.pid) && !selected.has(record.pid)) { selected.add(record.pid); added = true }
    }
  }
  return selected
}

const treeMembers = (records, trees, members, evidence) => {
  const byPid = new Map(records.map((record) => [record.pid, record]))
  const selected = new Set(matching(records, [...trees, ...members]).map((record) => record.pid))
  for (const tree of trees) {
    const leader = byPid.get(tree.pid)
    if (!tree.group || (leader && keyOf(leader) !== keyOf(tree))) continue
    if (!leader && !matching(records, [...evidence, ...members]).some((record) => record.group === tree.pid)) continue
    for (const record of records) if (record.group === tree.pid) selected.add(record.pid)
  }
  return processDescendants(records, selected)
}

const owned = (records, owner, { trees = owner.trees, rootPaths = true, members = trees === owner.trees ? owner.members : [] } = {}) => {
  const protectedPids = ancestors(records, process.pid)
  const selected = treeMembers(records, trees, members, owner.members)
  const otherTrees = trees === owner.trees ? [] : owner.trees.filter((tree) => !trees.includes(tree))
  const excluded = treeMembers(records, otherTrees, [], owner.members)
  if (rootPaths) {
    for (const record of records) {
      if (inside(record.cwd, owner.root) || pathOf(record.command).includes(`${owner.root}/`)
        || (trees === owner.trees && owner.profiles?.some((profile) => pathOf(record.command).includes(pathOf(profile))))) selected.add(record.pid)
    }
  }
  processDescendants(records, selected)
  return records.filter((record) => live(record) && selected.has(record.pid) && !protectedPids.has(record.pid) && !excluded.has(record.pid))
}

const terminate = async (owner, save, options) => {
  options = { ...options, members: options?.trees ? [] : owner.members }
  for (const [signal, budget] of [["SIGTERM", 1500], ["SIGKILL", 4000]]) {
    let targets = owned(readProcesses(), owner, options)
    if (!targets.length) return
    options.members.push(...targets)
    owner.members = [...new Map([...owner.members, ...targets].map((record) => [keyOf(record), { pid: record.pid, started: record.started }])).values()]
    save()
    for (const record of targets.reverse()) {
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(record.pid), "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 })
        else process.kill(record.pid, signal)
      } catch (error) {
        if (process.platform !== "win32" && error.code !== "ESRCH") throw error
      }
    }
    const deadline = Date.now() + budget
    do {
      await wait(100)
      targets = owned(readProcesses(), owner, options)
      if (!targets.length) return
    } while (Date.now() < deadline)
  }
  const remaining = owned(readProcesses(), owner, options)
  if (remaining.length) throw new Error(`Stand processes did not stop: ${remaining.map((record) => record.pid).join(", ")}; ownership retained for the next run`)
}

const registryAt = (checkout) => join(checkout, "tmp/verify/owners")
const temporaryDirectory = (dir, pattern) => {
  dir = String(dir ?? "")
  if (!pattern.test(basename(dir))) return false
  try {
    const parent = pathOf(realpathSync(dirname(dir)))
    return parent === pathOf(realpathSync(tmpdir())) || (process.platform === "darwin" && parent === "/private/tmp")
  } catch { return false }
}
const validRoot = (root) => temporaryDirectory(root, /^oc-verify-[a-zA-Z0-9]+$/)

/** Ownership is written before readiness, and outlives a removed stand root. */
export const createStandProcesses = ({ checkout, root }) => {
  const registry = registryAt(checkout)
  mkdirSync(registry, { recursive: true })
  const file = join(registry, `${basename(root)}.json`)
  const runner = readProcesses().find((record) => record.pid === process.pid)
  if (!runner) throw new Error("Could not identify the verification runner")
  const owner = { checkout: pathOf(realpathSync(checkout)), root: pathOf(realpathSync(root)), runner: { pid: runner.pid, started: runner.started }, trees: [], members: [], uiPort: null, profiles: [] }
  const save = () => saveOwner(file, owner)
  save()
  // Windows TerminateProcess cannot run a JS signal handler. EOF on this pipe
  // also reaches a detached guardian when the runner exits without finally.
  const guardian = spawn(process.execPath, [fileURLToPath(new URL("./process-guardian.mjs", import.meta.url)), file], {
    detached: true,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: Object.fromEntries(["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
  })
  guardian.stdin.on("error", () => {})
  const guardianExit = new Promise((done) => guardian.once("exit", done).once("error", done))
  guardian.unref()
  guardian.stdin.unref?.()
  const guardRecord = readProcesses().find((record) => record.pid === guardian.pid)
  if (guardRecord) owner.guardian = { pid: guardRecord.pid, started: guardRecord.started }
  save()
  return {
    launch(executable, args, { label, ...options }) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./launch-process.mjs", import.meta.url)), join(owner.root, "process"), executable, ...args], {
        ...options,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      })
      child.on("error", () => {})
      child.on("message", (message) => { if (message.type === "target.exit") child.targetExitCode = message.code })
      this.track(child, { label })
      return child
    },
    track(child, { label, group = true, profile } = {}) {
      let record
      let records
      try {
        records = readProcesses()
        record = records.find((record) => record.pid === child.pid)
      } catch (error) {
        child.kill("SIGKILL")
        throw error
      }
      if (record) owner.trees.push({ pid: record.pid, started: record.started, group, label })
      if (profile) owner.profiles.push(profile)
      owner.members = owned(records, owner).map((member) => ({ pid: member.pid, started: member.started }))
      save()
    },
    setUiPort(port) { owner.uiPort = port; save() },
    remember() {
      const members = owned(readProcesses(), owner)
      owner.members = members.map((record) => ({ pid: record.pid, started: record.started }))
      save()
    },
    stopTree(child) {
      const trees = owner.trees.filter((tree) => tree.pid === child?.pid)
      return terminate(owner, save, { trees, rootPaths: true })
    },
    stop: () => terminate(owner, save),
    async release() {
      rmSync(file, { force: true })
      guardian.stdin.end()
      const done = await Promise.race([guardianExit.then(() => true), wait(2000).then(() => false)])
      if (!done) {
        guardian.kill("SIGKILL")
        await guardianExit
      }
    },
  }
}

const hasLiveRunner = (records, targets, checkout) => {
  const ancestorIds = new Set(targets.flatMap((record) => [...ancestors(records, record.pid)]))
  return records.some((record) => ancestorIds.has(record.pid)
    && /scripts[/\\]verify[/\\]run\.mjs/.test(record.command)
    && (pathOf(record.cwd) === checkout || pathOf(record.command).includes(checkout)))
}

// Old runs have stand.json but no registry. Their isolated HOME/data env is
// stronger evidence than a port or "bun run dev:server" in a command line.
const legacyProcesses = (records, info, checkout) => {
  const root = pathOf(info.root)
  const web = `${checkout}/packages/web`
  const candidates = records.filter((record) => (pathOf(record.cwd) === web || pathOf(record.cwd) === checkout)
    && /dev:server|server[/\\]index\.js|vite|fixture-provider\.mjs/.test(record.command))
  const selected = records.filter((record) => inside(record.cwd, root) || pathOf(record.command).includes(`${root}/`))
  if (process.platform !== "win32") {
    for (const record of candidates) {
      let env = ""
      try {
        env = process.platform === "linux" ? readFileSync(`/proc/${record.pid}/environ`, "utf8").replaceAll("\0", " ")
          : execFileSync("ps", ["eww", "-p", String(record.pid), "-o", "command="], { encoding: "utf8" })
      } catch { continue }
      const normalized = pathOf(env)
      if (normalized.includes(`OPENCHAMBER_DATA_DIR=${root}/oc-data`)
        || normalized.includes(`OPENCHAMBER_VITE_CACHE_DIR=${web}/node_modules/.vite-dev-${info.uiPort}`)) selected.push(record)
    }
  }
  const byPid = new Map(records.map((record) => [record.pid, record]))
  for (const record of [...selected]) {
    let parent = parentOf(record, byPid)
    while (parent && pathOf(parent.cwd) === web && !/scripts[/\\]verify[/\\]run\.mjs/.test(parent.command)) {
      selected.push(parent)
      parent = parentOf(parent, byPid)
    }
  }
  return selected
}

/** Reap only this checkout's abandoned runs; live runners and --keep survive. */
export const reapStaleStands = async ({ checkout, log, only }) => {
  checkout = pathOf(realpathSync(checkout))
  const registry = registryAt(checkout)
  const records = readProcesses()
  const owners = existsSync(registry) ? readdirSync(registry).filter((name) => name.endsWith(".json") && (!only || resolve(join(registry, name)) === resolve(only))).map((name) => ({ file: join(registry, name), owner: json(join(registry, name)) })) : []
  const roots = new Set()
  for (const { file, owner } of owners) {
    if (!owner || owner.checkout !== checkout || !validRoot(owner.root)) continue
    roots.add(owner.root)
    if (matching(records, [owner.runner]).length) continue
    const targets = owned(records, owner)
    if (hasLiveRunner(records, targets, checkout)) continue
    if (targets.length) log(`removing leftover stand ${owner.root}: ${targets.map((record) => `${record.pid} ${basename(record.command.split(" ")[0])}`).join(", ")}`)
    await terminate(owner, () => saveOwner(file, owner))
    cleanFiles(owner, checkout)
    rmSync(file, { force: true })
  }
  if (only) return
  const runs = join(checkout, "tmp/verify")
  if (!existsSync(runs)) return
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "owners") continue
    const info = json(join(runs, entry.name, "stand.json"))
    if (!info || !validRoot(info.root) || roots.has(pathOf(info.root))) continue
    const targets = legacyProcesses(records, info, checkout)
    if (!targets.length || hasLiveRunner(records, targets, checkout)) continue
    log(`removing leftover stand ${info.root}: ${targets.map((record) => record.pid).join(", ")}`)
    const owner = { root: pathOf(info.root), trees: targets.map((record) => ({ pid: record.pid, started: record.started })), members: [], uiPort: info.uiPort, profiles: [] }
    await terminate(owner, () => {})
    cleanFiles(owner, checkout)
  }
}

const cleanFiles = (owner, checkout) => {
  if (Number.isInteger(owner.uiPort)) rmSync(join(checkout, `packages/web/node_modules/.vite-dev-${owner.uiPort}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  for (const profile of owner.profiles) {
    if (temporaryDirectory(profile, /^openchamber-perf-verify-[a-zA-Z0-9]+$/)) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  rmSync(resolve(owner.root), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
