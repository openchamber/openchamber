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

/**
 * `RunTask` events of the renderer main thread (`CrRendererMain`), the thread
 * that input, React and layout share. Other threads also emit `RunTask`; a
 * frame-budget count over all of them would mix compositor and IO work into
 * a figure about responsiveness. Falls back to every task, flagged, when the
 * trace carries no thread names.
 */
export const mainThreadTasks = (traceEvents) => {
  const mainThreads = new Set(traceEvents
    .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
    .map((event) => `${event.pid}:${event.tid}`))
  const tasks = traceEvents.filter((event) => event.name === "RunTask" && Number(event.dur) > 0
    && (mainThreads.size === 0 || mainThreads.has(`${event.pid}:${event.tid}`)))
  return { tasks, identified: mainThreads.size > 0 }
}

/**
 * Frame-budget view of main-thread tasks: how many tasks overran one frame at
 * 120 Hz (8.33 ms) and at 60 Hz (16.7 ms). Long tasks (50 ms) are what a user
 * calls a freeze; these are what a user calls jank while text streams.
 */
export const summarizeFrameBudget = (traceEvents) => {
  const { tasks, identified } = mainThreadTasks(traceEvents)
  const durations = tasks.map((event) => Number(event.dur) / 1000)
  return {
    mainThreadIdentified: identified,
    mainThreadTaskCount: durations.length,
    tasksOver8msCount: durations.filter((duration) => duration > 8.33).length,
    tasksOver16msCount: durations.filter((duration) => duration > 16.7).length,
  }
}

/**
 * Longest main-thread task overlapping a window given in trace microseconds.
 * Null when the trace has no tasks at all, so a missing instrument never reads
 * as a quiet window.
 */
export const longestTaskInWindow = (traceEvents, startMicros, endMicros) => {
  const { tasks } = mainThreadTasks(traceEvents)
  if (tasks.length === 0) return null
  const inWindow = tasks.filter((event) => event.ts < endMicros && event.ts + Number(event.dur) > startMicros)
  return {
    longestMs: round(inWindow.reduce((max, event) => Math.max(max, Number(event.dur) / 1000), 0)),
    tasks: inWindow.length,
    tasksOver16msCount: inWindow.filter((event) => Number(event.dur) / 1000 > 16.7).length,
  }
}

/**
 * Attributes recorded CPU time to threads, and within each thread to the
 * trace events that spent it.
 *
 * The main thread is one of many: a renderer also runs a compositor thread,
 * raster and garbage-collection workers, and the GPU process draws what they
 * produce. None of that appears in a main-thread profile, yet all of it is in
 * the CPU figure a user reads off a process monitor.
 *
 * Time is exclusive, so a task's cost is not counted again in the tasks it
 * contains, and it is thread CPU time (`tdur`) where Chrome recorded it, which
 * leaves out the time a thread spent descheduled or blocked.
 */
export const summarizeThreads = (traceEvents, { topThreads = 12, topEvents = 8 } = {}) => {
  const threadNames = new Map()
  const processNames = new Map()
  const byThread = new Map()
  for (const event of traceEvents) {
    if (event.name === "thread_name" && event.args?.name) threadNames.set(`${event.pid}:${event.tid}`, event.args.name)
    else if (event.name === "process_name" && event.args?.name) processNames.set(event.pid, event.args.name)
    if (event.ph !== "X" || !(Number(event.dur) >= 0)) continue
    const key = `${event.pid}:${event.tid}`
    const events = byThread.get(key) ?? []
    events.push(event)
    byThread.set(key, events)
  }

  const threads = []
  for (const [key, events] of byThread) {
    // Parents sort before the children they enclose.
    events.sort((left, right) => left.ts - right.ts || right.dur - left.dur)
    const cost = (event) => Number(event.tdur ?? event.dur)
    const totals = new Map()
    const open = []
    let cpuMicros = 0
    const close = (entry) => {
      const exclusive = Math.max(0, cost(entry.event) - entry.childCost)
      totals.set(entry.event.name, (totals.get(entry.event.name) ?? 0) + exclusive)
    }
    for (const event of events) {
      while (open.length > 0 && open.at(-1).end <= event.ts) close(open.pop())
      if (open.length === 0) cpuMicros += cost(event)
      else open.at(-1).childCost += cost(event)
      open.push({ event, end: event.ts + Number(event.dur), childCost: 0 })
    }
    while (open.length > 0) close(open.pop())

    const [pid] = key.split(":")
    threads.push({
      process: processNames.get(Number(pid)) ?? `pid ${pid}`,
      thread: threadNames.get(key) ?? `tid ${key.split(":")[1]}`,
      cpuMs: round(cpuMicros / 1000),
      events: [...totals.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, topEvents)
        .map(([name, micros]) => ({ name, cpuMs: round(micros / 1000) })),
    })
  }
  return threads.sort((left, right) => right.cpuMs - left.cpuMs).slice(0, topThreads)
}
