import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { acquireSlot, releaseSlot, slotLimit, takeSlot } from "./slots.mjs"

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oc-verify-slots-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("a third stand waits until one of two running ones finishes", async (t) => {
  const dir = scratch(t)
  const alive = new Set([11, 12, 13])
  const isAlive = (pid) => alive.has(pid)
  const first = await acquireSlot({ log: () => undefined, dir, slots: 2, pid: 11, isAlive })
  await acquireSlot({ log: () => undefined, dir, slots: 2, pid: 12, isAlive })
  const messages = []
  let waits = 0
  const third = acquireSlot({ log: (line) => messages.push(line), dir, slots: 2, pid: 13, isAlive, wait: async () => { waits += 1; if (waits === 3) first() } })
  await third
  assert.equal(waits, 3)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /processes 11, 12/)
  assert.deepEqual(takeSlot({ dir, slots: 2, pid: 14, isAlive: (pid) => alive.has(pid) || pid === 14 }), { holders: [13, 12] })
})

test("a slot left by a process that is gone is taken over", (t) => {
  const dir = scratch(t)
  writeFileSync(join(dir, "slot-1"), "999")
  writeFileSync(join(dir, "slot-2"), "not a pid")
  assert.deepEqual(takeSlot({ dir, slots: 2, pid: 21, isAlive: () => false }), { file: join(dir, "slot-1") })
  assert.deepEqual(takeSlot({ dir, slots: 2, pid: 22, isAlive: (pid) => pid === 21 }), { file: join(dir, "slot-2") })
})

test("a run gives back only a slot it still holds", (t) => {
  const dir = scratch(t)
  const { file } = takeSlot({ dir, slots: 1, pid: 31, isAlive: () => true })
  writeFileSync(file, "32")
  releaseSlot({ file, pid: 31 })
  assert.deepEqual(takeSlot({ dir, slots: 1, pid: 33, isAlive: () => true }), { holders: [32] })
})

test("while another process is looking at the slots, a run steps back instead of deciding", (t) => {
  const dir = scratch(t)
  mkdirSync(join(dir, "guard"))
  assert.equal(takeSlot({ dir, slots: 2, pid: 41, isAlive: () => true }), null)
})

test("the limit falls back to the default for a missing or invalid setting", () => {
  assert.equal(slotLimit(undefined), 2)
  assert.equal(slotLimit("0"), 2)
  assert.equal(slotLimit("four"), 2)
  assert.equal(slotLimit("4"), 4)
})
