import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { comparePrimary, compareResultDirs } from "./compare-runs.mjs"

const writeRuns = (root, scenario, runs) => runs.forEach((data, index) => {
  const directory = join(root, `${scenario}-${index + 1}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "idle-summary.json"), JSON.stringify(data))
})

const idle = (busy, extra = {}) => ({ metrics: { mainThreadBusyPercent: busy }, frameLiveness: { framesPerSecond: 60 }, ...extra })
const row = (table, label) => table.split("\n").find((line) => line.startsWith(`| ${label} |`))

const primaryRow = (table, label) => row(table, `**${label}**`)
const before = [1.0, 1.2, 1.4, 1.1, 1.3, 1.25, 1.15, 1.35]
const scaled = (factor) => before.map((value) => idle(value * factor))

test("the primary metric gets a verdict from paired runs: better, WORSE, same or none", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  try {
    writeRuns(join(root, "before"), "idle", scaled(1))
    writeRuns(join(root, "same"), "idle", before.map((value, index) => idle(value * (1 + (index % 2 ? 0.01 : -0.01) * ((index % 3) + 1) / 3))))
    writeRuns(join(root, "faster"), "idle", scaled(0.5))
    writeRuns(join(root, "slower"), "idle", scaled(1.7))
    writeRuns(join(root, "spread"), "idle", [0.9, 1.6, 0.8, 1.5, 1.0, 1.7, 0.85, 1.6].map((value) => idle(value)))
    writeRuns(join(root, "few"), "idle", [0.5, 0.6, 0.7].map((value) => idle(value)))
    const verdict = (side) => primaryRow(compareResultDirs(join(root, "before"), join(root, side)), "main-thread busy %")
    assert.match(verdict("same"), /\| 8 \| same \|$/)
    assert.match(verdict("faster"), /-50% \[-50% … -50%\] \| 8 \| better \|$/)
    assert.match(verdict("slower"), /\| 8 \| WORSE \|$/)
    assert.match(verdict("spread"), /\| 8 \|  \|$/)
    assert.match(verdict("few"), /\| 3 \|  \|$/)
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
    assert.match(primaryRow(table, "main-thread busy %"), /\| 1 \/ 1 \(1\) \|/)
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
    assert.match(primaryRow(table, "panel-open worst frame ms"), /\| 32 \/ 34 \(3\) \| 17 \/ 18 \(3\) \| -46\.9% .* \| 1 \|  \|$/)
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

test("secondaries read only after the primary has a verdict, and exact counts always read", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  const withCounts = (busy, tasks, requests) => idle(busy, { metrics: { mainThreadBusyPercent: busy, tasksPerSecond: tasks }, pageSignals: { requests } })
  try {
    writeRuns(join(root, "before"), "idle", before.map((value) => withCounts(value, value * 10, 12)))
    writeRuns(join(root, "moved"), "idle", before.map((value) => withCounts(value / 2, value * 2, 3)))
    writeRuns(join(root, "unmoved"), "idle", [0.9, 1.6, 0.8, 1.5, 1.0, 1.7, 0.85, 1.6].map((value, index) => withCounts(value, before[index] * 2, 3)))
    const moved = compareResultDirs(join(root, "before"), join(root, "moved"))
    assert.match(row(moved, "tasks/s"), /\| better \|$/)
    assert.match(row(moved, "requests"), /-75% exact \| 8 \| better \|$/)
    const unmoved = compareResultDirs(join(root, "before"), join(root, "unmoved"))
    assert.match(row(unmoved, "tasks/s"), /\| 8 \|  \|$/)
    assert.match(row(unmoved, "requests"), /\| better \|$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Holm counts every secondary, the ones that did not move too", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  const run = (busy, script, style) => idle(busy, { metrics: { mainThreadBusyPercent: busy, tasksPerSecond: script, scriptPercent: style, recalcStylePerSecond: style, layoutsPerSecond: style } })
  const base = [1.0, 1.2, 1.4, 1.1, 1.3, 1.25]
  try {
    writeRuns(join(root, "before"), "idle", base.map((value) => run(value, value, value)))
    // Six pairs reach p = 0.03125 at best: alone that passes, against four other tests it does not.
    writeRuns(join(root, "after"), "idle", base.map((value, index) => run(value / 2, value / 2, value * (index % 2 ? 1.2 : 0.8))))
    assert.doesNotMatch(row(compareResultDirs(join(root, "before"), join(root, "after")), "tasks/s"), /better/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a look reads the primary of one scenario", () => {
  const root = mkdtempSync(join(tmpdir(), "compare-runs-"))
  try {
    writeRuns(join(root, "before"), "idle", scaled(1))
    writeRuns(join(root, "after"), "idle", scaled(0.5))
    const { label, comparison } = comparePrimary(join(root, "before"), join(root, "after"), "idle")
    assert.equal(label, "main-thread busy %")
    assert.equal(comparison.direction, "lower")
    assert.equal(comparePrimary(join(root, "before"), join(root, "after"), "stream"), null)
    assert.equal(comparePrimary(join(root, "before"), join(root, "after"), "idle", { throughPair: 6 }).comparison.n, 6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
