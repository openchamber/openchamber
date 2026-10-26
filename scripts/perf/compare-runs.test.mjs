import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { compareResultDirs } from "./compare-runs.mjs"

const writeRuns = (root, scenario, runs) => runs.forEach((data, index) => {
  const directory = join(root, `${scenario}-${index + 1}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "idle-summary.json"), JSON.stringify(data))
})

const idle = (busy, extra = {}) => ({ metrics: { mainThreadBusyPercent: busy }, frameLiveness: { framesPerSecond: 60 }, ...extra })
const row = (table, label) => table.split("\n").find((line) => line.startsWith(`| ${label} |`))

test("verdicts: inside the before range is noise, outside is better or worse", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  try {
    writeRuns(join(root, "before"), "idle", [idle(1.0), idle(1.2), idle(1.4)])
    writeRuns(join(root, "noise"), "idle", [idle(1.1), idle(1.3), idle(1.3)])
    writeRuns(join(root, "faster"), "idle", [idle(0.5), idle(0.6), idle(0.7)])
    writeRuns(join(root, "slower"), "idle", [idle(2.0), idle(2.1), idle(2.2)])
    assert.match(row(compareResultDirs(join(root, "before"), join(root, "noise")), "main-thread busy %"), /\| noise \|$/)
    assert.match(row(compareResultDirs(join(root, "before"), join(root, "faster")), "main-thread busy %"), /\| better \|$/)
    assert.match(row(compareResultDirs(join(root, "before"), join(root, "slower")), "main-thread busy %"), /\| WORSE \|$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a throttled run is excluded and named, not averaged in", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  try {
    writeRuns(join(root, "before"), "idle", [idle(1.0), idle(1.0)])
    writeRuns(join(root, "after"), "idle", [idle(1.0), idle(0, { frameLiveness: { framesPerSecond: 1 } })])
    const table = compareResultDirs(join(root, "before"), join(root, "after"))
    assert.match(row(table, "main-thread busy %"), /\| 1 \/ 1 \(1\) \|/)
    assert.match(table, /after: excluded 1 of 2 runs: idle-2 \(renderer throttled\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("toggle runs pool measured toggles per type and drop a run that failed validity", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  const toggle = (type, worst, extra = {}) => ({ type, valid: true, warmup: false, frames: { worstFrameMs: worst }, ...extra })
  const run = (worsts, extra = {}) => ({
    session: { mountedMessages: 40 }, frameLiveness: { framesPerSecond: 60 }, metrics: { taskCount: 100 }, toggleValidity: { ok: true, failures: [] },
    toggles: [toggle("panel-open", 400, { warmup: true }), ...worsts.map((worst) => toggle("panel-open", worst))], ...extra,
  })
  const write = (side, name, data) => {
    const directory = join(root, side, name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "toggle-summary.json"), JSON.stringify(data))
  }
  try {
    write("before", "toggle-1", run([30, 32, 34]))
    write("after", "toggle-1", run([17, 17, 18]))
    write("after", "toggle-2", run([90, 90, 90], { toggleValidity: { ok: false, failures: ["1 of 4 toggles invalid"] } }))
    const table = compareResultDirs(join(root, "before"), join(root, "after"))
    assert.match(row(table, "panel-open worst frame ms"), /\| 32 \/ 34 \(3\) \| 17 \/ 18 \(3\) \|.*\| better \|$/)
    assert.match(table, /after: excluded 1 of 2 runs: toggle-2 \(toggle validity failed: 1 of 4 toggles invalid\)/)
    assert.match(row(table, "mounted messages (workload)"), /\| 40 \/ 40 \(1\) \| 40 \/ 40 \(1\) \|/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("sides that differ in building an accessibility tree are flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  const accessibility = (active, forced = false) => ({ accessibility: { recorded: true, forced, active, serializations: active ? 10 : 0, nativeClientCalls: 0 } })
  try {
    writeRuns(join(root, "before"), "idle", [idle(1.0, accessibility(true)), idle(1.0, accessibility(true))])
    writeRuns(join(root, "off"), "idle", [idle(1.0, accessibility(false)), idle(1.0, accessibility(false))])
    writeRuns(join(root, "on"), "idle", [idle(1.0, accessibility(true)), idle(1.0, accessibility(true))])
    assert.match(compareResultDirs(join(root, "before"), join(root, "off")), /ACCESSIBILITY DIFFERS, timings do not compare: accessibility tree before: on \(client\) in 2; after: off in 2/)
    const same = compareResultDirs(join(root, "before"), join(root, "on"))
    assert.doesNotMatch(same, /DIFFERS/)
    assert.match(same, /accessibility tree before: on \(client\) in 2; after: on \(client\) in 2/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
