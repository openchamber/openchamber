/**
 * Renderer-side recorder for `profile:soak`, attached over CDP to the
 * installed desktop app started with `--remote-debugging-port`.
 *
 * Kept deliberately light so a recording of many minutes does not become the
 * load it measures: the Network domain (every request with the code that sent
 * it, every realtime frame with its event type), `Performance.getMetrics` once
 * a second (main-thread task, script, style and layout time, heap, DOM), and
 * optionally a sampling CPU profile of the whole window.
 */

import { createWriteStream } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { CdpClient } from "./cdp.mjs"
import { metricMap } from "./metrics.mjs"

const listPages = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await response.json()
  return targets.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl && !entry.url.startsWith("devtools://"))
}

/** Up to three frames of the stack that started a request: who asked. */
const initiatorOf = (initiator) => {
  if (!initiator) return null
  const frames = []
  let stack = initiator.stack
  while (stack && frames.length < 3) {
    for (const frame of stack.callFrames ?? []) {
      if (frames.length >= 3) break
      const file = String(frame.url ?? "").split("/").pop()
      frames.push(`${frame.functionName || "(anonymous)"}@${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`)
    }
    stack = stack.parent
  }
  return { type: initiator.type, frames }
}

/**
 * The event name a realtime frame carries. Frames nest (`{type: "event",
 * payload: {type: "session.updated", ...}}`), so the innermost type names it.
 */
export const frameKind = (payload) => {
  if (!payload) return "empty"
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return payload.length > 0 && payload.length < 40 ? `text:${payload}` : "text"
  }
  // A frame is JSON of unknown shape; read it as plain records.
  const names = []
  let node = parsed
  for (let depth = 0; depth < 4 && node instanceof Object; depth += 1) {
    if (Array.isArray(node)) {
      names.push(`[${node.length}]`)
      node = node[0]
      continue
    }
    const name = [node.type, node.event].find((value) => value instanceof String || Object.prototype.toString.call(value) === "[object String]")
    if (name !== undefined) names.push(String(name))
    node = node.payload ?? node.data ?? node.properties?.info ?? null
  }
  return names.length > 0 ? names.join(">") : "json"
}

/**
 * Counts DOM mutations by the element they hit, described by its nearest
 * labelled ancestors, so "what changes on screen while idle" has an answer.
 * Installed once per document; the recorder reads it at the end.
 */
const MUTATION_PROBE = `(() => {
  if (window.__soakMutations) return;
  const counts = new Map();
  const describe = (node) => {
    const parts = [];
    let element = node.nodeType === 1 ? node : node.parentElement;
    for (let depth = 0; element && depth < 5; depth += 1, element = element.parentElement) {
      const label = element.getAttribute("data-testid") || element.getAttribute("aria-label") || element.getAttribute("data-slot")
        || (element.getAttribute("class") || "").split(" ").filter(Boolean).slice(0, 2).join(".");
      parts.push(element.tagName.toLowerCase() + (label ? "[" + label.replace(/\\d+/g, "#").slice(0, 40) + "]" : ""));
    }
    return parts.join(" < ");
  };
  const start = () => {
    new MutationObserver((records) => {
      for (const record of records) {
        const key = record.type + (record.attributeName ? ":" + record.attributeName : "") + " @ " + describe(record.target);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
  window.__soakMutations = { startedAt: Date.now(), reset: () => { counts.clear(); window.__soakMutations.startedAt = Date.now(); }, read: () => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60) };
})()`

const attachPage = async ({ target, outputDir, index, cpuProfile, samplingIntervalUs, reload }) => {
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  const label = `page${index}`
  const requestsStream = createWriteStream(join(outputDir, `requests-${label}.jsonl`))
  const framesStream = createWriteStream(join(outputDir, `ws-${label}.jsonl`))
  const metricsStream = createWriteStream(join(outputDir, `renderer-${label}.jsonl`))
  const open = new Map()
  const sockets = new Map()

  const finish = (requestId, extra) => {
    const entry = open.get(requestId)
    if (!entry) return
    open.delete(requestId)
    requestsStream.write(`${JSON.stringify({ ...entry, ...extra })}\n`)
  }

  client.on("Network.requestWillBeSent", (params) => {
    if (open.has(params.requestId)) finish(params.requestId, { redirected: true })
    open.set(params.requestId, {
      t: Math.round(params.wallTime * 1000),
      ts: params.timestamp,
      method: params.request.method,
      url: params.request.url,
      type: params.type ?? null,
      initiator: initiatorOf(params.initiator),
      decoded: 0,
    })
  })
  client.on("Network.responseReceived", (params) => {
    const entry = open.get(params.requestId)
    if (entry) entry.status = params.response.status
  })
  client.on("Network.dataReceived", (params) => {
    const entry = open.get(params.requestId)
    if (entry) entry.decoded += Number(params.dataLength ?? 0)
  })
  client.on("Network.loadingFinished", (params) => {
    const entry = open.get(params.requestId)
    if (entry) finish(params.requestId, { encoded: Number(params.encodedDataLength ?? 0), ms: Math.round((params.timestamp - entry.ts) * 1000) })
  })
  client.on("Network.loadingFailed", (params) => {
    const entry = open.get(params.requestId)
    if (entry) finish(params.requestId, { failed: params.errorText ?? true, ms: Math.round((params.timestamp - entry.ts) * 1000) })
  })
  client.on("Network.webSocketCreated", (params) => {
    sockets.set(params.requestId, params.url)
    framesStream.write(`${JSON.stringify({ t: Date.now(), event: "open", url: params.url, initiator: initiatorOf(params.initiator) })}\n`)
  })
  client.on("Network.webSocketClosed", (params) => {
    framesStream.write(`${JSON.stringify({ t: Date.now(), event: "close", url: sockets.get(params.requestId) ?? null })}\n`)
  })
  const onFrame = (direction) => (params) => {
    const payload = String(params.response?.payloadData ?? "")
    framesStream.write(`${JSON.stringify({ t: Date.now(), dir: direction, url: sockets.get(params.requestId) ?? null, bytes: payload.length, kind: params.response?.opcode === 1 ? frameKind(payload) : `opcode:${params.response?.opcode}` })}\n`)
  }
  client.on("Network.webSocketFrameReceived", onFrame("in"))
  client.on("Network.webSocketFrameSent", onFrame("out"))
  client.on("Network.eventSourceMessageReceived", (params) => {
    framesStream.write(`${JSON.stringify({ t: Date.now(), dir: "sse", bytes: String(params.data ?? "").length, kind: params.eventName || frameKind(params.data) })}\n`)
  })

  await client.send("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 100_000 })
  await client.send("Performance.enable", { timeDomain: "timeTicks" })
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: MUTATION_PROBE }).catch(() => {})
  // Frames of a socket opened before Network.enable are never reported, so the
  // realtime channel is only seen when the window loads under the recorder.
  if (reload) {
    await client.send("Page.reload", {})
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
  }
  await client.send("Runtime.evaluate", { expression: MUTATION_PROBE }).catch(() => {})
  if (cpuProfile) {
    await client.send("Profiler.enable")
    await client.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs })
    await client.send("Profiler.start")
  }

  let stopped = false
  const metricsLoop = (async () => {
    while (!stopped) {
      try {
        const { metrics } = await client.send("Performance.getMetrics", {}, { timeoutMs: 10_000 })
        const map = metricMap(metrics)
        metricsStream.write(`${JSON.stringify({
          t: Date.now(),
          task: map.TaskDuration,
          script: map.ScriptDuration,
          style: map.RecalcStyleDuration,
          layout: map.LayoutDuration,
          styleCount: map.RecalcStyleCount,
          layoutCount: map.LayoutCount,
          heapUsed: map.JSHeapUsedSize,
          heapTotal: map.JSHeapTotalSize,
          nodes: map.Nodes,
          listeners: map.JSEventListeners,
          documents: map.Documents,
        })}\n`)
      } catch {
        // A slow reply skips one sample; the next tick tries again.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
    }
  })()

  return {
    label,
    url: target.url,
    /** Drops what the settle period counted; the recording starts now. */
    markStart: () => client.send("Runtime.evaluate", { expression: "window.__soakMutations?.reset()" }).catch(() => {}),
    stop: async () => {
      stopped = true
      await metricsLoop
      try {
        const { result } = await client.send("Runtime.evaluate", { expression: "window.__soakMutations ? { startedAt: window.__soakMutations.startedAt, top: window.__soakMutations.read() } : null", returnByValue: true })
        if (result?.value) await writeFile(join(outputDir, `mutations-${label}.json`), JSON.stringify({ ...result.value, endedAt: Date.now() }))
      } catch (error) {
        console.warn(`[soak] ${label}: mutation counts were not read: ${error.message}`)
      }
      if (cpuProfile) {
        try {
          const { profile } = await client.send("Profiler.stop", {}, { timeoutMs: 120_000 })
          await writeFile(join(outputDir, `${label}.cpuprofile`), JSON.stringify(profile))
        } catch (error) {
          console.warn(`[soak] ${label}: CPU profile was not saved: ${error.message}`)
        }
      }
      for (const requestId of [...open.keys()]) finish(requestId, { unfinished: true })
      client.close()
      await Promise.all([requestsStream, framesStream, metricsStream].map((stream) => new Promise((done) => stream.end(done))))
    },
  }
}

/** Attaches to every application window the debugging port exposes. */
export const startRendererRecorder = async ({ port, outputDir, cpuProfile, reload, samplingIntervalUs = 1_000 }) => {
  const pages = await listPages(port)
  if (pages.length === 0) throw new Error(`No application window on debugging port ${port}`)
  const recorders = []
  try {
    for (const [index, target] of pages.entries()) {
      recorders.push(await attachPage({ target, outputDir, index, cpuProfile, samplingIntervalUs, reload: reload && index === 0 }))
    }
  } catch (error) {
    await Promise.allSettled(recorders.map((recorder) => recorder.stop()))
    throw error
  }
  return {
    pages: recorders.map(({ label, url }) => ({ label, url })),
    markStart: () => Promise.all(recorders.map((recorder) => recorder.markStart())),
    stop: () => Promise.all(recorders.map((recorder) => recorder.stop())),
  }
}

/**
 * CPU profile of the Electron main process, which hosts the OpenChamber
 * server, through its Node inspector (`--inspect=<port>` at launch).
 */
export const startMainProfile = async ({ port, outputDir, samplingIntervalUs = 2_000 }) => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((entry) => entry.webSocketDebuggerUrl)
  if (!target) throw new Error(`No Node inspector on port ${port}`)
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  await client.send("Profiler.enable")
  await client.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs })
  await client.send("Profiler.start")
  return {
    stop: async () => {
      try {
        const { profile } = await client.send("Profiler.stop", {}, { timeoutMs: 120_000 })
        await writeFile(join(outputDir, "main.cpuprofile"), JSON.stringify(profile))
      } catch (error) {
        console.warn(`[soak] main process CPU profile was not saved: ${error.message}`)
      }
      client.close()
    },
  }
}
