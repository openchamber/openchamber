import assert from "node:assert/strict"
import { execFileSync, execSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import fs from "node:fs"
import { constants, getPriority, setPriority, tmpdir } from "node:os"
import os from "node:os"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { gitIn, startStand } from "./stand.mjs"
import { reservePort } from "../perf/cdp.mjs"
import { startFixture } from "../perf/isolated-server.mjs"
import { prioritizeWindowsProcess } from "./windows-priority.mjs"
import { fixtureCommand } from "../perf/shell-command.mjs"

test("fixture commands preserve exact output, file bytes, append and nonzero exit through the host shell", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-verify-shell-"))
  const file = "marker.txt"
  const output = "marker ' \" $((6*7)) %PATH% & | < > \u001b[?1000h\n"
  try {
    assert.equal(execSync(fixtureCommand({ output, file, content: "one\n" }, root), { cwd: root, encoding: "utf8" }), output)
    execSync(fixtureCommand({ file, content: "two", append: true }, root), { cwd: root })
    assert.equal(fs.readFileSync(join(root, file), "utf8"), "one\ntwo")
    assert.equal(execSync(fixtureCommand({ read: file }, root), { cwd: root, encoding: "utf8" }), "one\ntwo")
    assert.throws(() => execSync(fixtureCommand({ output: "verify-command-failed\n", fail: true }, root), { cwd: root }), (error) => {
      assert.equal(error.status, 1)
      assert.equal(error.stdout.toString(), "verify-command-failed\n")
      return true
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a gated fixture command emits and writes only after the gate file exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-verify-gate-"))
  const child = spawn(fixtureCommand({ gate: "gate", output: "released\n", file: "done" }, root), { cwd: root, shell: true })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`command exited ${code}`)))
  })
  try {
    assert.equal(fs.existsSync(join(root, "done")), false)
    fs.writeFileSync(join(root, "gate"), "go")
    await exited
    assert.equal(output, "released\n")
    assert.equal(fs.readFileSync(join(root, "done"), "utf8"), "ready")
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Windows priority failures clean up the owned stand", { skip: process.platform !== "win32" }, async (t) => {
  const logs = mkdtempSync(join(tmpdir(), "verify-priority-logs-"))
  const mkdtemp = fs.mkdtempSync
  let root
  let cleanup
  t.mock.method(fs, "mkdtempSync", (...args) => {
    const dir = mkdtemp(...args)
    if (String(args[0]).includes("oc-verify-")) root = dir
    return dir
  })
  t.mock.method(os, "setPriority", () => { throw Object.assign(new Error("Priority denied"), { code: "EPERM" }) })
  syncBuiltinESMExports()
  try {
    await assert.rejects(startStand({ log: () => {}, logsDir: logs, onStop: (stop) => { cleanup = stop } }), { code: "EPERM" })
    assert.ok(root)
    assert.equal(fs.existsSync(root), false)
  } finally {
    await cleanup?.()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(logs, { recursive: true, force: true })
  }
})

test("Windows verification processes explicitly retain High priority", { skip: process.platform !== "win32" }, () => {
  const previous = getPriority()
  try {
    prioritizeWindowsProcess()
    assert.equal(getPriority(), constants.priority.PRIORITY_HIGH)
  } finally {
    setPriority(previous)
  }
})

test("the installed virtualizer patch can build its first layout", () => {
  const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url))
  const { Virtualizer } = createRequire(uiRequire.resolve("@tanstack/react-virtual"))("@tanstack/virtual-core")
  const list = new Virtualizer({
    count: 2,
    estimateSize: () => 20,
    getScrollElement: () => null,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
    initialRect: { width: 200, height: 100 },
  })
  assert.deepEqual(list.getVirtualItems().map(({ index, start, end }) => ({ index, start, end })), [
    { index: 0, start: 0, end: 20 },
    { index: 1, start: 20, end: 40 },
  ])
})

test("the fixture CLI recognizes a native filesystem entrypoint", () => {
  const fixture = fileURLToPath(new URL("../perf/fixture-provider.mjs", import.meta.url))
  const output = execFileSync(process.execPath, [fixture, "4601", "--print-config"], { encoding: "utf8" })
  assert.equal(JSON.parse(output).provider.perf.options.baseURL, "http://127.0.0.1:4601/v1")
})

test("the isolated Git environment supports the platform's null config", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-verify-git-"))
  try {
    gitIn(root, ["init", "-q", "-b", "main"])
    assert.equal(gitIn(root, ["branch", "--show-current"]).trim(), "main")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Windows fixture shutdown tolerates repeated cleanup before the exit event", { skip: process.platform !== "win32" }, async () => {
  const fixture = await startFixture({ port: await reservePort() })
  try {
    await fixture.stop()
    await fixture.stop()
  } finally {
    await fixture.stop()
  }
})
