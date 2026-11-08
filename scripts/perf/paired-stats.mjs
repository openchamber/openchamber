/**
 * Paired before/after statistics for `profile:compare`.
 *
 * Each pair is one before block and one after block run next to each other, so
 * machine drift lands on both. The test is Wilcoxon signed-rank on the
 * per-pair differences, the estimate is Hodges-Lehmann, and the interval comes
 * from the sorted Walsh averages: none of them assume a distribution, and one
 * odd pair moves them by one rank.
 *
 * A compare that looks at its result after every pair inflates false positives,
 * so verdicts come only at the planned looks, each at Pocock's constant level
 * for five looks (5% overall).
 */

export const LOOKS = [8, 12, 18, 26, 40]
export const LOOK_CONFIDENCE = 0.9842
export const DEFAULT_CONFIDENCE = 0.95
/** Fewer pairs cannot reach a 95% interval: [min, max] of 5 pairs covers 94%. */
export const MIN_PAIRS = 6
/** A change inside this share of the before value counts as `same`. */
export const EQUIVALENCE = 0.05

const LOOK_Z = 2.41

/** Ways each sum of a subset of `ranks` (whole numbers) can occur, by DP over the ranks. */
const rankSumCounts = (ranks) => {
  const maximum = ranks.reduce((total, rank) => total + rank, 0)
  let counts = new Array(maximum + 1).fill(0)
  counts[0] = 1
  for (const rank of ranks) {
    const next = counts.slice()
    for (let total = rank; total <= maximum; total += 1) next[total] += counts[total - rank]
    counts = next
  }
  return counts
}

const cumulative = (counts, n) => {
  const total = 2 ** n
  let sum = 0
  return counts.map((count) => {
    sum += count
    return sum / total
  })
}

/** Largest c with P(T ≤ c) ≤ alpha/2, or null when no interval reaches the level. */
export const criticalRank = (n, confidence) => {
  const tail = (1 - confidence) / 2
  const distribution = cumulative(rankSumCounts(Array.from({ length: n }, (_, index) => index + 1)), n)
  let critical = null
  for (let value = 0; value < distribution.length && distribution[value] <= tail; value += 1) critical = value
  return critical
}

const walshAverages = (values) => {
  const averages = []
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left; right < values.length; right += 1) averages.push((values[left] + values[right]) / 2)
  }
  return averages.sort((a, b) => a - b)
}

export const medianOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length / 2
  return Number.isInteger(middle) ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)]
}

/** Two-sided signed-rank p value, over the actual ranks: tied magnitudes share their average rank. */
export const signedRankP = (differences) => {
  const nonzero = differences.filter((value) => value !== 0)
  const n = nonzero.length
  if (n === 0) return 1
  const ordered = nonzero.map((value) => ({ value, magnitude: Math.abs(value) })).sort((a, b) => a.magnitude - b.magnitude)
  // Doubled, so a half rank stays a whole number for the DP.
  const ranks = []
  let positive = 0
  for (let index = 0; index < n;) {
    let end = index
    while (end + 1 < n && ordered[end + 1].magnitude === ordered[index].magnitude) end += 1
    const rank = index + end + 2
    for (let tied = index; tied <= end; tied += 1) {
      ranks.push(rank)
      if (ordered[tied].value > 0) positive += rank
    }
    index = end + 1
  }
  const total = ranks.reduce((sum, rank) => sum + rank, 0)
  return Math.min(1, 2 * cumulative(rankSumCounts(ranks), n)[Math.min(positive, total - positive)])
}

const unique = (values) => new Set(values).size

/**
 * Compares `pairs` of `{ before, after }`. A metric with a zero or a negative
 * value has no ratio, so it compares differences; `change` is a percentage for
 * ratios and the raw difference otherwise. `count` marks a metric that counts
 * something, as opposed to a measurement.
 *
 * `direction` is "lower", "higher" or "same" (after against before), null when
 * the interval overlaps the bound or there are too few pairs for one.
 */
export const comparePairs = (pairs, { confidence = DEFAULT_CONFIDENCE, equivalence = EQUIVALENCE, count = false } = {}) => {
  const n = pairs.length
  if (n === 0) return null
  const befores = pairs.map((pair) => pair.before)
  const afters = pairs.map((pair) => pair.after)
  const ratio = [...befores, ...afters].every((value) => value > 0)
  const differences = pairs.map(({ before, after }) => (ratio ? Math.log(after / before) : after - before))
  const bound = ratio ? Math.log(1 + equivalence) : equivalence * Math.abs(medianOf(befores))
  const present = (value) => (ratio ? (Math.exp(value) - 1) * 100 : value)
  const toDirection = (lower, upper) => {
    if (upper < 0) return "lower"
    if (lower > 0) return "higher"
    return lower >= -bound && upper <= bound ? "same" : null
  }

  // A count that holds one value on each side has nothing left to estimate. A
  // rounded measurement can hold one value too, by chance, so it stays a sample.
  if (n >= 2 && count && unique(befores) === 1 && unique(afters) === 1) {
    const difference = differences[0]
    return { n, exact: true, ratio, difference, change: present(difference), lower: present(difference), upper: present(difference), p: 0, direction: difference === 0 ? "same" : difference < 0 ? "lower" : "higher", confidence: 1, differences, bound }
  }

  const averages = walshAverages(differences)
  const estimate = medianOf(averages)
  const critical = n >= MIN_PAIRS ? criticalRank(n, confidence) : null
  const reached = critical !== null
  const low = averages[reached ? critical : 0]
  const high = averages[averages.length - 1 - (reached ? critical : 0)]
  return {
    n, exact: false, ratio, difference: estimate, change: present(estimate), lower: present(low), upper: present(high),
    p: signedRankP(differences), direction: reached ? toDirection(low, high) : null, confidence: reached ? confidence : null, differences, bound,
  }
}

/** Pairs needed for an interval that clears either the bound or zero, from a robust spread. */
export const pairsNeeded = (comparison) => {
  const { differences, difference, bound } = comparison
  const middle = medianOf(differences)
  const spread = 1.4826 * medianOf(differences.map((value) => Math.abs(value - middle)))
  if (spread === 0) return comparison.n
  const margin = Math.max(Math.abs(difference), bound - Math.abs(difference))
  return Math.ceil((LOOK_Z * spread / margin) ** 2)
}

/**
 * What a planned look decides about a scenario's primary metric: `done` when it
 * has a verdict or no valid pairs, `underpowered` when the pairs a verdict needs
 * exceed what the run can afford, `continue` otherwise.
 */
export const decideLook = (comparison, { affordablePairs = LOOKS.at(-1) } = {}) => {
  if (!comparison || comparison.direction) return "done"
  const limit = Math.min(affordablePairs, LOOKS.at(-1))
  if (comparison.n >= LOOKS.at(-1)) return "underpowered"
  return comparison.n >= LOOKS[1] && pairsNeeded(comparison) > limit ? "underpowered" : "continue"
}

/** Holm step-down over p values: which of them hold at family-wise `alpha`. */
export const holmPasses = (values, alpha = 0.05) => {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const passes = new Array(values.length).fill(false)
  for (let position = 0; position < order.length; position += 1) {
    if (order[position].value > alpha / (order.length - position)) break
    passes[order[position].index] = true
  }
  return passes
}
