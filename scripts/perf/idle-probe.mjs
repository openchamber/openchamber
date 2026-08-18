/**
 * Page-side idle instrumentation.
 *
 * `buildIdleProbeSource()` returns a self-contained script installed with
 * `Page.addScriptToEvaluateOnNewDocument`, so it wraps the scheduling APIs
 * before any application module runs. The probe attributes wall time to the
 * call site that scheduled the work, which is what identifies a background
 * loop that keeps running while the user is idle.
 *
 * Design constraints:
 * - The probe must not change observable behaviour: every wrapper forwards
 *   arguments and return values unchanged, and preserves handle identity so
 *   `clearInterval`/`cancelAnimationFrame` keep working.
 * - Stack capture happens at schedule time, not at fire time, and stops after
 *   a bounded number of captures so instrumentation cannot become the
 *   bottleneck it is measuring.
 */

export const IDLE_PROBE_GLOBAL = "__openchamberIdleProbe"

const probeFactory = function installOpenchamberIdleProbe(globalName, stackCaptureBudget) {
  if (globalThis[globalName]) return

  const now = () => performance.now()
  const sites = new Map()
  let stackCaptures = 0
  let recording = false

  const siteFromStack = (kind) => {
    if (stackCaptures >= stackCaptureBudget) return `${kind} <stack budget exhausted>`
    stackCaptures += 1
    const stack = new Error().stack ?? ""
    const lines = stack.split("\n")
    for (const line of lines) {
      // Skip the Error line and every frame belonging to the probe itself.
      if (!line.includes("http")) continue
      if (line.includes("installOpenchamberIdleProbe")) continue
      const match = line.match(/\(?((?:https?:)\/\/[^\s)]+)\)?$/)
      const location = match ? match[1] : line.trim()
      const name = line.trim().replace(/^at\s+/, "").split(" (")[0]
      return `${kind} ${name} @ ${location}`
    }
    return `${kind} <unknown>`
  }

  const record = (site, elapsedMs) => {
    if (!recording) return
    let entry = sites.get(site)
    if (!entry) {
      entry = { site, calls: 0, totalMs: 0, maxMs: 0 }
      sites.set(site, entry)
    }
    entry.calls += 1
    entry.totalMs += elapsedMs
    if (elapsedMs > entry.maxMs) entry.maxMs = elapsedMs
  }

  const counters = {
    setTimeoutScheduled: 0,
    setIntervalScheduled: 0,
    rafScheduled: 0,
    idleCallbackScheduled: 0,
    listenersAdded: 0,
    listenersRemoved: 0,
    mutationRecords: 0,
    resizeEntries: 0,
    intersectionEntries: 0,
    fetches: 0,
    postMessages: 0,
  }
  const listenerTypes = new Map()
  const bump = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount)

  const wrapCallback = (callback, site) => {
    if (typeof callback !== "function") return callback
    return function instrumentedIdleProbeCallback(...args) {
      const started = now()
      try {
        return callback.apply(this, args)
      } finally {
        record(site, now() - started)
      }
    }
  }

  const nativeSetTimeout = globalThis.setTimeout
  const nativeSetInterval = globalThis.setInterval
  const nativeRaf = globalThis.requestAnimationFrame
  const nativeIdle = globalThis.requestIdleCallback

  globalThis.setTimeout = function setTimeout(handler, timeout, ...rest) {
    counters.setTimeoutScheduled += 1
    if (typeof handler !== "function") return nativeSetTimeout.call(this, handler, timeout, ...rest)
    const site = siteFromStack(`setTimeout(${Number(timeout) || 0})`)
    return nativeSetTimeout.call(this, wrapCallback(handler, site), timeout, ...rest)
  }

  globalThis.setInterval = function setInterval(handler, timeout, ...rest) {
    counters.setIntervalScheduled += 1
    if (typeof handler !== "function") return nativeSetInterval.call(this, handler, timeout, ...rest)
    const site = siteFromStack(`setInterval(${Number(timeout) || 0})`)
    return nativeSetInterval.call(this, wrapCallback(handler, site), timeout, ...rest)
  }

  if (typeof nativeRaf === "function") {
    globalThis.requestAnimationFrame = function requestAnimationFrame(callback) {
      counters.rafScheduled += 1
      if (typeof callback !== "function") return nativeRaf.call(this, callback)
      const site = siteFromStack("requestAnimationFrame")
      return nativeRaf.call(this, wrapCallback(callback, site))
    }
  }

  if (typeof nativeIdle === "function") {
    globalThis.requestIdleCallback = function requestIdleCallback(callback, options) {
      counters.idleCallbackScheduled += 1
      if (typeof callback !== "function") return nativeIdle.call(this, callback, options)
      const site = siteFromStack("requestIdleCallback")
      return nativeIdle.call(this, wrapCallback(callback, site), options)
    }
  }

  // Listener accounting explains the growing "JS event listeners" curve.
  const nativeAdd = EventTarget.prototype.addEventListener
  const nativeRemove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    counters.listenersAdded += 1
    bump(listenerTypes, String(type), 1)
    return nativeAdd.call(this, type, listener, options)
  }
  EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
    counters.listenersRemoved += 1
    bump(listenerTypes, String(type), -1)
    return nativeRemove.call(this, type, listener, options)
  }

  const wrapObserver = (Original, kind, countEntries) => {
    if (typeof Original !== "function") return Original
    const Wrapped = function ObserverWrapper(callback, ...rest) {
      const site = siteFromStack(kind)
      const instrumented = typeof callback === "function"
        ? function instrumentedObserverCallback(entries, observer) {
          countEntries(entries)
          const started = now()
          try {
            return callback.call(this, entries, observer)
          } finally {
            record(site, now() - started)
          }
        }
        : callback
      return new Original(instrumented, ...rest)
    }
    Wrapped.prototype = Original.prototype
    return Wrapped
  }

  globalThis.MutationObserver = wrapObserver(globalThis.MutationObserver, "MutationObserver", (entries) => {
    counters.mutationRecords += entries?.length ?? 0
  })
  globalThis.ResizeObserver = wrapObserver(globalThis.ResizeObserver, "ResizeObserver", (entries) => {
    counters.resizeEntries += entries?.length ?? 0
  })
  globalThis.IntersectionObserver = wrapObserver(globalThis.IntersectionObserver, "IntersectionObserver", (entries) => {
    counters.intersectionEntries += entries?.length ?? 0
  })

  const nativeFetch = globalThis.fetch
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function fetch(...args) {
      counters.fetches += 1
      return nativeFetch.apply(this, args)
    }
  }

  const nativePostMessage = globalThis.postMessage
  if (typeof nativePostMessage === "function") {
    globalThis.postMessage = function postMessage(...args) {
      counters.postMessages += 1
      return nativePostMessage.apply(this, args)
    }
  }

  globalThis[globalName] = {
    start() {
      recording = true
      sites.clear()
      for (const key of Object.keys(counters)) counters[key] = 0
    },
    stop() {
      recording = false
    },
    snapshot() {
      return {
        stackCaptures,
        stackBudgetExhausted: stackCaptures >= stackCaptureBudget,
        counters: { ...counters },
        listenerTypes: [...listenerTypes.entries()]
          .map(([type, net]) => ({ type, net }))
          .filter((entry) => entry.net !== 0)
          .sort((left, right) => right.net - left.net)
          .slice(0, 25),
        sites: [...sites.values()]
          .sort((left, right) => right.totalMs - left.totalMs)
          .slice(0, 40)
          .map((entry) => ({
            site: entry.site,
            calls: entry.calls,
            totalMs: Number(entry.totalMs.toFixed(2)),
            maxMs: Number(entry.maxMs.toFixed(2)),
          })),
      }
    },
  }
}

export const buildIdleProbeSource = (stackCaptureBudget = 200_000) =>
  `(${probeFactory.toString()})(${JSON.stringify(IDLE_PROBE_GLOBAL)}, ${stackCaptureBudget});`
