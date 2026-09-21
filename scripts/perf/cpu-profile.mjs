/**
 * Aggregation helpers for `Profiler.stop()` CPU profiles.
 *
 * The sampling profiler answers "which functions burned the main thread while
 * nobody touched the app", which is the question the idle report exists to
 * answer. Self time is derived from the sample stream rather than from
 * `hitCount`, because sample deltas carry the actual elapsed time.
 */

const frameLabel = (callFrame) => {
  const name = callFrame.functionName || "(anonymous)"
  const url = callFrame.url || "(native)"
  const shortUrl = url.replace(/^https?:\/\/[^/]+/, "")
  return `${name} @ ${shortUrl}:${callFrame.lineNumber + 1}`
}

/**
 * @param {{nodes: Array, samples: Array<number>, timeDeltas: Array<number>}} profile
 * @param {number} topCount
 */
export const summarizeCpuProfile = (profile, topCount = 25) => {
  const nodes = new Map()
  for (const node of profile?.nodes ?? []) nodes.set(node.id, node)

  const samples = profile?.samples ?? []
  const timeDeltas = profile?.timeDeltas ?? []

  const selfMicros = new Map()
  let totalMicros = 0
  let idleMicros = 0
  let gcMicros = 0
  let programMicros = 0

  for (let index = 0; index < samples.length; index += 1) {
    // `timeDeltas[i]` is the interval preceding sample `i`.
    const delta = Math.max(0, Number(timeDeltas[index] ?? 0))
    totalMicros += delta
    const node = nodes.get(samples[index])
    if (!node) continue
    const name = node.callFrame?.functionName
    if (name === "(idle)") {
      idleMicros += delta
      continue
    }
    if (name === "(garbage collector)") gcMicros += delta
    if (name === "(program)") programMicros += delta
    const label = frameLabel(node.callFrame ?? {})
    selfMicros.set(label, (selfMicros.get(label) ?? 0) + delta)
  }

  const busyMicros = totalMicros - idleMicros
  const toMs = (micros) => Number((micros / 1000).toFixed(2))

  return {
    sampleCount: samples.length,
    totalMs: toMs(totalMicros),
    idleMs: toMs(idleMicros),
    busyMs: toMs(busyMicros),
    busyPercent: totalMicros > 0 ? Number(((busyMicros / totalMicros) * 100).toFixed(2)) : 0,
    garbageCollectorMs: toMs(gcMicros),
    programMs: toMs(programMicros),
    topSelfTime: [...selfMicros.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, topCount)
      .map(([label, micros]) => ({
        function: label,
        selfMs: toMs(micros),
        percentOfBusy: busyMicros > 0 ? Number(((micros / busyMicros) * 100).toFixed(2)) : 0,
      })),
  }
}
