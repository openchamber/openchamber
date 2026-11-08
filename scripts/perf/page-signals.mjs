/**
 * What the browser reports about a page without a trace or a profiler, cheap
 * enough to run inside a timed window: long tasks and layout shifts from
 * `PerformanceObserver`, and the requests the page started over CDP.
 *
 * An entry type the browser does not support reads null, never zero.
 */

import { evaluateValue } from "./cdp.mjs"
import { round } from "./metrics.mjs"

const GLOBAL = "__openchamberPageSignals"

/** Installed before application code; counts only between `start()` and `stop()`. */
export const buildPageSignalsSource = () => `(() => {
  const supported = PerformanceObserver.supportedEntryTypes ?? []
  const state = { recording: false, longTasks: [], layoutShift: 0 }
  const observe = (type, onEntry) => {
    if (!supported.includes(type)) return false
    new PerformanceObserver((list) => {
      if (state.recording) for (const entry of list.getEntries()) onEntry(entry)
    }).observe({ type, buffered: false })
    return true
  }
  const longTasks = observe("longtask", (entry) => state.longTasks.push(entry.duration))
  const layoutShift = observe("layout-shift", (entry) => { state.layoutShift += entry.value })
  globalThis.${GLOBAL} = {
    start: () => { state.recording = true; state.longTasks = []; state.layoutShift = 0 },
    stop: () => new Promise((resolve) => {
      // Observers deliver in a later task, so the last entries arrive after this call.
      setTimeout(() => {
        state.recording = false
        resolve({
          longTaskCount: longTasks ? state.longTasks.length : null,
          longestTaskMs: longTasks ? state.longTasks.reduce((max, value) => Math.max(max, value), 0) : null,
          layoutShift: layoutShift ? state.layoutShift : null,
        })
      }, 50)
    }),
  }
})()`

/** Counts requests the page starts; `data:` and `blob:` URLs are not requests. */
const countRequests = (client) => {
  let requests = 0
  const unsubscribe = client.on("Network.requestWillBeSent", ({ request }) => {
    if (!/^(data|blob):/.test(String(request?.url))) requests += 1
  })
  return () => {
    unsubscribe()
    return requests
  }
}

/** Starts recording on a page whose document has the source above. `stop()` resolves the signals. */
export const startPageSignals = async (client) => {
  const stopRequests = countRequests(client)
  await evaluateValue(client, `globalThis.${GLOBAL}?.start()`)
  return {
    stop: async () => {
      const requests = stopRequests()
      const page = await evaluateValue(client, `globalThis.${GLOBAL}?.stop() ?? null`)
      if (!page) throw new Error("The page signals were never installed; the document loaded before the source was added.")
      return { ...page, longestTaskMs: page.longestTaskMs === null ? null : round(page.longestTaskMs), layoutShift: page.layoutShift === null ? null : round(page.layoutShift, 4), requests }
    },
  }
}
