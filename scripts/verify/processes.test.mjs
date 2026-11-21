import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { createStandProcesses, processDescendants, readProcesses, reapStaleStands } from "./processes.mjs"

const idle = "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)"
const temp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))
const alive = (pid) => readProcesses().some((record) => record.pid === pid && !record.state?.startsWith("Z"))
const childAt = async (cwd, env, title) => {
  const child = spawn(process.execPath, ["-e", `${title ? `/* ${title} */\n` : ""}${idle}`], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "ignore"] })
  await new Promise((done, reject) => child.stdout.once("data", done).once("error", reject))
  return child
}
const cleanup = async (owner, children, dirs) => {
  try { await owner?.stop() } finally {
    await owner?.release()
    for (const child of children) {
      const exited = child.exitCode === null && child.signalCode === null ? new Promise((done) => child.once("exit", done)) : null
      try { process.kill(child.pid, "SIGKILL") } catch {}
      await exited
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test("the process snapshot identifies this process and its checkout", () => {
  const own = readProcesses().find((record) => record.pid === process.pid)
  assert.ok(own?.started)
  if (process.platform !== "win32") assert.equal(own.cwd, process.cwd())
})

test("a reused parent PID cannot adopt older Windows processes or their children", () => {
  const records = [
    { pid: 10, parent: 1, started: "2026-11-17T12:00:00.000Z" },
    { pid: 20, parent: 10, started: "2026-11-17T08:00:00.000Z" },
    { pid: 21, parent: 20, started: "2026-11-17T12:01:00.000Z" },
    { pid: 30, parent: 10, started: "2026-11-17T12:00:00.000Z" },
    { pid: 31, parent: 30, started: "2026-11-17T12:00:01.000Z" },
    { pid: 40, parent: 31, started: "2026-11-17T11:59:59.000Z" },
  ]
  assert.deepEqual([...processDescendants(records, new Set([10]))], [10, 30, 31])
})

test("process identities do not depend on the caller's locale", { skip: process.platform === "win32" }, () => {
  const module = pathToFileURL(join(import.meta.dirname, "processes.mjs")).href
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `import {readProcesses} from ${JSON.stringify(module)};console.log(Boolean(readProcesses().find(p=>p.pid===process.pid)?.started))`], {
    env: { ...process.env, LC_ALL: "uk_UA.UTF-8", LANG: "uk_UA.UTF-8" },
    encoding: "utf8",
  })
  assert.equal(output.trim(), "true")
})

test("registry updates publish complete JSON by rename rather than truncating the live owner", async (t) => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const write = fs.writeFileSync
  const rename = fs.renameSync
  let publications = 0
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    assert.equal(String(file).replaceAll("\\", "/").includes("/owners/") && String(file).endsWith(".json"), false, "A killed runner must leave the previous complete owner record readable")
    return write(file, ...args)
  })
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).replaceAll("\\", "/").includes("/owners/")) {
      assert.ok(JSON.parse(readFileSync(from, "utf8")).runner)
      if (existsSync(to)) assert.ok(JSON.parse(readFileSync(to, "utf8")).runner)
      publications += 1
    }
    return rename(from, to)
  })
  syncBuiltinESMExports()
  let owner
  try {
    owner = createStandProcesses({ checkout, root })
    owner.setUiPort(12345)
    owner.remember()
    assert.ok(publications >= 4)
  } finally {
    await cleanup(owner, [], [root, checkout])
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("POSIX cwd recovery finds detached descendants after their launcher's exit", { skip: process.platform === "win32" }, async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const owner = createStandProcesses({ checkout, root })
  const children = []
  try {
    const escaped = await childAt(root)
    children.push(escaped)
    const launcher = spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: root, detached: true, stdio: "ignore" })
    owner.track(launcher, { label: "exited launcher" })
    await new Promise((done) => launcher.exitCode !== null ? done() : launcher.once("exit", done))
    await owner.stop()
    assert.equal(alive(escaped.pid), false)
  } finally {
    await cleanup(owner, children, [root, checkout])
  }
})

test("an exited process-group leader does not skip its signal-resistant children", { skip: process.platform === "win32" }, async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const outside = temp("verify-owner-outside-")
  const owner = createStandProcesses({ checkout, root })
  let childPid
  const launcher = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process')
    process.on('SIGTERM',()=>process.exit(0))
    const child=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{cwd:${JSON.stringify(outside)},stdio:['ignore','pipe','ignore']})
    child.stdout.once('data',()=>console.log(child.pid))
    setInterval(()=>{},1000)
  `], { cwd: root, detached: true, stdio: ["ignore", "pipe", "ignore"] })
  try {
    childPid = await new Promise((done) => launcher.stdout.once("data", (chunk) => done(Number(String(chunk).trim()))))
    owner.track(launcher, { label: "API wrapper" })
    launcher.kill("SIGTERM")
    await new Promise((done) => launcher.exitCode !== null ? done() : launcher.once("exit", done))
    await owner.stop()
    assert.equal(alive(childPid), false)
  } finally {
    await cleanup(owner, [{ pid: launcher.pid }, { pid: childPid }].filter((child) => child.pid), [root, checkout, outside])
  }
})

test("the managed leader retains ownership of children spawned after registration", async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const outside = temp("verify-owner-outside-")
  const owner = createStandProcesses({ checkout, root })
  let childPid
  const launcher = owner.launch(process.execPath, ["-e", `
    const {spawn}=require('node:child_process')
    const fs=require('node:fs')
    const release=${JSON.stringify(join(outside, "release"))}
    const watcher=fs.watch(${JSON.stringify(outside)},()=>{
      if(!fs.existsSync(release))return
      watcher.close()
      const child=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{cwd:${JSON.stringify(outside)},stdio:['ignore','pipe','ignore']})
      child.stdout.once('data',()=>{console.log(child.pid);process.exit(0)})
    })
    console.log('waiting for registration')
  `], { cwd: outside, label: "API" })
  try {
    await new Promise((done) => launcher.stdout.once("data", done))
    const spawned = new Promise((done) => launcher.stdout.once("data", (chunk) => done(Number(String(chunk).trim()))))
    writeFileSync(join(outside, "release"), "go")
    childPid = await spawned
    await new Promise((done) => launcher.targetExitCode !== undefined ? done() : launcher.once("message", done))
    await owner.stop()
    assert.equal(alive(childPid), false)
  } finally {
    await cleanup(owner, [{ pid: launcher.pid }, { pid: childPid }].filter((child) => child.pid), [root, checkout, outside])
  }
})

test("stopping only the API preserves Vite and its descendants in the same stand", async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const owner = createStandProcesses({ checkout, root })
  const api = owner.launch(process.execPath, ["-e", idle], { cwd: root, label: "API" })
  const vite = owner.launch(process.execPath, ["-e", idle], { cwd: root, label: "Vite" })
  try {
    await Promise.all([api, vite].map((child) => new Promise((done) => child.stdout.once("data", done))))
    const uiProcesses = readProcesses().filter((record) => record.pid === vite.pid || record.parent === vite.pid)
    assert.ok(uiProcesses.length >= 2)
    await owner.stopTree(api)
    assert.equal(alive(api.pid), false)
    const current = new Set(readProcesses().map((record) => `${record.pid}:${record.started}`))
    for (const record of uiProcesses) assert.equal(current.has(`${record.pid}:${record.started}`), true)
  } finally {
    await cleanup(owner, [api, vite], [root, checkout])
  }
})

test("the guardian reaps a stand after its runner is killed without a JS exit handler", { timeout: 30_000 }, async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const module = pathToFileURL(join(import.meta.dirname, "processes.mjs")).href
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createStandProcesses} from ${JSON.stringify(module)}
    import {spawn} from 'node:child_process'
    const owner=createStandProcesses({checkout:${JSON.stringify(checkout)},root:${JSON.stringify(root)}})
    const child=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{cwd:${JSON.stringify(root)},detached:true,stdio:['ignore','pipe','ignore']})
    child.stdout.once('data',()=>{owner.track(child,{label:'API'});console.log(JSON.stringify({pid:child.pid}))})
    setInterval(()=>{},1000)
  `], { stdio: ["ignore", "pipe", "pipe"] })
  let childPid
  let watcher
  let guardianPid
  try {
    childPid = await new Promise((done, reject) => {
      launcher.stdout.once("data", (chunk) => done(JSON.parse(String(chunk)).pid))
      launcher.once("error", reject)
      launcher.once("exit", (code) => reject(new Error(`Lifecycle parent exited early: ${code}`)))
    })
    const registry = join(checkout, "tmp/verify/owners")
    const file = join(registry, readdirSync(registry).find((name) => name.endsWith(".json")))
    guardianPid = JSON.parse(readFileSync(file, "utf8")).guardian.pid
    const cleaned = new Promise((done) => {
      watcher = watch(registry, () => { if (!existsSync(file)) done() })
    })
    launcher.kill("SIGKILL")
    await new Promise((done) => launcher.signalCode !== null || launcher.exitCode !== null ? done() : launcher.once("exit", done))
    await cleaned
    assert.equal(alive(childPid), false)
    assert.equal(existsSync(root), false)
  } finally {
    watcher?.close()
    await cleanup(null, [{ pid: launcher.pid }, { pid: childPid }, { pid: guardianPid }].filter((child) => child.pid), [root, checkout])
  }
})

test("a stale registry reaps its process tree while a live runner and another checkout survive", async () => {
  const checkout = temp("verify-owner-checkout-")
  const foreignCheckout = temp("verify-owner-foreign-")
  const root = temp("oc-verify-")
  const foreignRoot = temp("oc-verify-")
  const owner = createStandProcesses({ checkout, root })
  const foreign = createStandProcesses({ checkout: foreignCheckout, root: foreignRoot })
  const children = []
  try {
    const ownChild = await childAt(root)
    const otherChild = await childAt(foreignRoot)
    children.push(ownChild, otherChild)
    owner.track(ownChild, { label: "owned" })
    foreign.track(otherChild, { label: "foreign" })
    await reapStaleStands({ checkout, log: () => assert.fail("A live stand was classified as stale") })
    assert.equal(alive(ownChild.pid), true)
    const registry = join(checkout, "tmp/verify/owners")
    const file = join(registry, readdirSync(registry)[0])
    const saved = JSON.parse(readFileSync(file, "utf8"))
    saved.runner.started = "an earlier process with the same PID"
    writeFileSync(file, JSON.stringify(saved))
    const messages = []
    await reapStaleStands({ checkout, log: (message) => messages.push(message) })
    assert.equal(alive(ownChild.pid), false)
    assert.equal(alive(otherChild.pid), true)
    assert.match(messages[0], /removing leftover stand/)
    assert.equal(existsSync(root), false)
    assert.equal(existsSync(file), false)
  } finally {
    await foreign.stop()
    await foreign.release()
    await cleanup(owner, children, [root, foreignRoot, checkout, foreignCheckout])
  }
})

test("a reused tracked PID does not transfer ownership to an unrelated process", async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const other = temp("verify-owner-other-")
  const owner = createStandProcesses({ checkout, root })
  const child = await childAt(other)
  try {
    const registry = join(checkout, "tmp/verify/owners")
    const file = join(registry, readdirSync(registry)[0])
    const saved = JSON.parse(readFileSync(file, "utf8"))
    saved.runner.started = "dead runner"
    saved.trees = [{ pid: child.pid, started: "dead process", group: true }]
    writeFileSync(file, JSON.stringify(saved))
    await reapStaleStands({ checkout, log: () => {} })
    assert.equal(alive(child.pid), true)
  } finally {
    await cleanup(owner, [child], [root, other, checkout])
  }
})

test("a reused group ID with an absent leader does not adopt unrelated children", { skip: process.platform === "win32" }, async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const outside = temp("verify-owner-outside-")
  const owner = createStandProcesses({ checkout, root })
  const launcher = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process')
    const child=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{cwd:${JSON.stringify(outside)},stdio:['ignore','pipe','ignore']})
    child.stdout.once('data',()=>{console.log(child.pid);process.exit(0)})
  `], { cwd: outside, detached: true, stdio: ["ignore", "pipe", "ignore"] })
  let childPid
  try {
    childPid = await new Promise((done) => launcher.stdout.once("data", (chunk) => done(Number(String(chunk).trim()))))
    await new Promise((done) => launcher.exitCode !== null ? done() : launcher.once("exit", done))
    const registry = join(checkout, "tmp/verify/owners")
    const file = join(registry, readdirSync(registry).find((name) => name.endsWith(".json")))
    const saved = JSON.parse(readFileSync(file, "utf8"))
    saved.runner.started = "dead runner"
    saved.trees = [{ pid: launcher.pid, started: "an earlier group leader", group: true }]
    writeFileSync(file, JSON.stringify(saved))
    await reapStaleStands({ checkout, log: () => {} })
    assert.equal(alive(childPid), true)
  } finally {
    await cleanup(owner, [{ pid: launcher.pid }, { pid: childPid }].filter((child) => child.pid), [root, checkout, outside])
  }
})

test("legacy cleanup uses isolated environment evidence for API and Vite wrappers", { skip: process.platform === "win32" }, async () => {
  const checkout = temp("verify-owner-checkout-")
  const root = temp("oc-verify-")
  const web = join(checkout, "packages/web")
  mkdirSync(web, { recursive: true })
  const children = []
  try {
    const api = await childAt(web, { OPENCHAMBER_DATA_DIR: `${root}/oc-data` }, "bun run dev:server")
    const vite = await childAt(web, { OPENCHAMBER_VITE_CACHE_DIR: `${web}/node_modules/.vite-dev-12345` }, "vite")
    const unrelated = await childAt(web)
    children.push(api, vite, unrelated)
    const run = join(checkout, "tmp/verify/old-run")
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, "stand.json"), JSON.stringify({ root, project: `${root}/project`, uiPort: 12345 }))
    await reapStaleStands({ checkout, log: () => {} })
    assert.equal(alive(api.pid), false)
    assert.equal(alive(vite.pid), false)
    assert.equal(alive(unrelated.pid), true)
  } finally {
    await cleanup(null, children, [root, checkout])
  }
})
