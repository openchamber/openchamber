/**
 * Metric helpers shared by the idle and streaming profilers.
 *
 * Both commands read the same `Performance.getMetrics` counters and need the
 * same derivations, so the maths lives here and each entry point only decides
 * which numbers to report.
 */

export const round = (value, digits = 2) => Number(Number(value ?? 0).toFixed(digits))

export const metricMap = (metrics = []) => Object.fromEntries(metrics.map(({ name, value }) => [name, value]))

/**
 * Least-squares slope of a sampled series, in units per second. A slope
 * separates a genuine upward trend from the sawtooth that garbage collection
 * produces, which start/end deltas alone cannot distinguish.
 */
export const growthPerSecond = (samples, key) => {
  if (samples.length < 2) return 0
  const meanTime = samples.reduce((total, sample) => total + sample.elapsedSeconds, 0) / samples.length
  const meanValue = samples.reduce((total, sample) => total + (sample[key] ?? 0), 0) / samples.length
  let covariance = 0
  let variance = 0
  for (const sample of samples) {
    const timeDelta = sample.elapsedSeconds - meanTime
    covariance += timeDelta * ((sample[key] ?? 0) - meanValue)
    variance += timeDelta * timeDelta
  }
  return variance === 0 ? 0 : Number((covariance / variance).toFixed(3))
}

/** Percentile of an unsorted numeric series, using nearest-rank. */
export const percentile = (values, fraction) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return round(sorted[rank])
}

// `RunTask` and `RunMicrotasks` are containers: their duration already
// includes the work below them, so counting them would double-count.
const CONTAINER_TRACE_EVENTS = new Set(["RunTask", "RunMicrotasks", "ProfileChunk", "Profile"])

/**
 * Breaks recorded time down by trace event.
 *
 * A CPU sampling profile attributes native work to `(program)`, which hides
 * whether time went to HTML parsing, style recalculation, layout, or paint.
 * The timeline trace names that work explicitly, so this is what turns "76% of
 * busy time is native" into an actionable list.
 */
export const summarizeTraceEvents = (traceEvents, topCount = 15) => {
  const totals = new Map()
  for (const event of traceEvents) {
    if (event.ph !== "X" || !(Number(event.dur) > 0)) continue
    if (CONTAINER_TRACE_EVENTS.has(event.name)) continue
    const entry = totals.get(event.name) ?? { name: event.name, count: 0, totalMs: 0, maxMs: 0 }
    const durationMs = Number(event.dur) / 1000
    entry.count += 1
    entry.totalMs += durationMs
    if (durationMs > entry.maxMs) entry.maxMs = durationMs
    totals.set(event.name, entry)
  }
  return [...totals.values()]
    .sort((left, right) => right.totalMs - left.totalMs)
    .slice(0, topCount)
    .map((entry) => ({ ...entry, totalMs: round(entry.totalMs), maxMs: round(entry.maxMs) }))
}

/**
 * Long tasks block input and animation, so a streaming capture is judged by
 * its task-duration distribution rather than by an average frame rate.
 */
export const summarizeLongTasks = (traceEvents, thresholdMs = 50) => {
  const durations = traceEvents
    .filter((event) => event.name === "RunTask" && Number(event.dur) > 0)
    .map((event) => Number(event.dur) / 1000)
  const long = durations.filter((duration) => duration >= thresholdMs)
  return {
    taskCount: durations.length,
    longTaskCount: long.length,
    longTaskTotalMs: round(long.reduce((total, duration) => total + duration, 0)),
    // Spreading a large array into Math.max overflows the call stack; a trace
    // can easily carry hundreds of thousands of tasks.
    longestTaskMs: round(durations.reduce((max, duration) => Math.max(max, duration), 0)),
    taskP95Ms: percentile(durations, 0.95),
    taskP99Ms: percentile(durations, 0.99),
  }
}
