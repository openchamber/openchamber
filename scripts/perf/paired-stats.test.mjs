import assert from "node:assert/strict"
import { test } from "node:test"

import { comparePairs, criticalRank, decideLook, holmPasses, LOOK_CONFIDENCE, pairsNeeded, signedRankP } from "./paired-stats.mjs"

const pairsOf = (entries) => entries.map(([before, after]) => ({ before, after }))
// Noise that is not a straight line, so the Walsh averages spread.
const jitter = [0.9, 1.1, 1, 1.05, 0.95, 1.02, 0.98, 1.08]
const scaled = (factor) => jitter.map((noise, index) => [100 * jitter[(index + 3) % 8], 100 * factor * noise])

test("critical ranks reach the level exactly where the signed-rank table says", () => {
  assert.equal(criticalRank(5, 0.95), null)
  assert.equal(criticalRank(6, 0.95), 0)
  assert.equal(criticalRank(8, 0.95), 3)
  assert.equal(criticalRank(8, LOOK_CONFIDENCE), 1)
})

test("the signed-rank p value matches the table and survives ties", () => {
  assert.equal(signedRankP([1, 2, 3, 4, 5, 6]), 2 / 64)
  assert.equal(signedRankP([0, 0, 0]), 1)
  assert.ok(signedRankP([1, 1, 1, -1, -1, -1]) >= 0.5)
  assert.equal(signedRankP([1, -1, -1, -2, -2, -2, -2, -2]), 0.03125)
})

test("a clear change has a direction and its size, in percent", () => {
  const comparison = comparePairs(pairsOf(jitter.map((noise) => [100 * noise, 50 * noise])))
  assert.equal(comparison.direction, "lower")
  assert.equal(Math.round(comparison.change), -50)
})

test("two equal sides inside the bound read as same, and spread that overlaps it reads as nothing", () => {
  const tight = [1, -1, 0.5, -0.5, 0.8, -0.8, 0.2, -0.2].map((offset) => [100, 100 + offset])
  assert.equal(comparePairs(pairsOf(tight)).direction, "same")
  assert.equal(comparePairs(pairsOf(scaled(1))).direction, null)
})

test("below six pairs there is an estimate and no verdict", () => {
  const comparison = comparePairs(pairsOf([[100, 50], [110, 55], [90, 45], [105, 52], [95, 48]]))
  assert.equal(comparison.direction, null)
  assert.equal(comparison.confidence, null)
  assert.ok(comparison.change < -40)
})

test("a count that holds one value per side compares exactly, from two pairs", () => {
  const moved = comparePairs(pairsOf([[24, 4], [24, 4]]), { count: true })
  assert.equal(moved.exact, true)
  assert.equal(moved.direction, "lower")
  const still = comparePairs(pairsOf([[0, 0], [0, 0]]), { count: true })
  assert.equal(still.direction, "same")
  assert.equal(still.change, 0)
})

test("a measurement that repeats by chance is no exact count, whole numbers included", () => {
  for (const pair of [[87, 87.1], [100, 90]]) {
    const comparison = comparePairs(pairsOf([pair, pair]))
    assert.equal(comparison.exact, false)
    assert.equal(comparison.direction, null)
  }
})

test("zeros fall back to differences, never an infinite ratio", () => {
  const comparison = comparePairs(pairsOf([[0, 2], [1, 3], [0, 2.5], [1, 3.5], [0, 1.5], [1, 2.5], [0, 2], [1, 3]]))
  assert.equal(comparison.ratio, false)
  assert.equal(comparison.direction, "higher")
  assert.equal(comparison.change, 2)
})

test("a look stops on a verdict, gives up when more pairs will not help, and goes on otherwise", () => {
  const clear = comparePairs(pairsOf(jitter.map((noise) => [100 * noise, 50 * noise])), { confidence: LOOK_CONFIDENCE })
  assert.equal(decideLook(clear), "done")
  assert.equal(decideLook(null), "done")
  const noisy = comparePairs(pairsOf(scaled(1.0)), { confidence: LOOK_CONFIDENCE })
  assert.equal(decideLook(noisy), "continue")
  const wild = comparePairs(pairsOf(Array.from({ length: 12 }, (_, index) => [100, index % 2 ? 30 : 300])), { confidence: LOOK_CONFIDENCE })
  assert.ok(pairsNeeded(wild) > 40)
  assert.equal(decideLook(wild), "underpowered")
  assert.equal(decideLook({ ...noisy, n: 40 }), "underpowered")
  const twelve = comparePairs(pairsOf(Array.from({ length: 12 }, (_, index) => [100, index % 2 ? 94 : 106.4])), { confidence: LOOK_CONFIDENCE })
  assert.equal(decideLook(twelve), "continue")
  assert.equal(decideLook(twelve, { affordablePairs: 14 }), "underpowered")
})

test("Holm tightens the first test and relaxes the next", () => {
  assert.deepEqual(holmPasses([0.01, 0.04, 0.2]), [true, false, false])
  assert.deepEqual(holmPasses([0.01, 0.02, 0.04]), [true, true, true])
  assert.deepEqual(holmPasses([0.04, 0.04, 0.04]), [false, false, false])
})
