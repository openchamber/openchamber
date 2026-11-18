import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
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
