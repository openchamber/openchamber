#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import process from "node:process"

const HELP = `Usage: bun run profile:browser -- [options]

Options:
  --url <url>             OpenChamber URL (default: http://localhost:3000)
  --duration <seconds>    Recording duration after Enter (default: 60)
  --output <directory>    Artifact directory (default: artifacts/browser-profile-<time>)
  --chrome <path>         Chrome/Chromium executable
  --profile-dir <path>    Reusable isolated Chrome profile
  --headless              Run without a visible browser
  --no-prompt             Start after a 5 second preparation delay
  --help                  Show this help

The command records a Chrome performance trace, a redacted HAR, browser metrics,
and OpenChamber's numeric sync counters. It never records response bodies.`

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000",
    duration: 60,
    output: null,
    chrome: null,
    profileDir: join(homedir(), ".openchamber", "browser-profile"),
    headless: false,
    prompt: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") return { ...options, help: true }
    if (value === "--headless") options.headless = true
    else if (value === "--no-prompt") options.prompt = false
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--duration") options.duration = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = argv[++index]
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isFinite(options.duration) || options.duration <= 0) {
    throw new Error("--duration must be a positive number")
  }
  new URL(options.url)
  return options
}

const chromeCandidates = () => {
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Comet.app/Contents/MacOS/Comet",
      "/Applications/Dia.app/Contents/MacOS/Dia",
      "/Applications/Helium.app/Contents/MacOS/Helium",
    ]
  }
  if (platform() === "win32") {
    return [
      join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    ]
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
}

const resolveChrome = (explicit) => {
  if (explicit) {
    const candidate = resolve(explicit)
    if (!existsSync(candidate)) throw new Error(`Chrome executable not found: ${candidate}`)
    return candidate
  }
  const candidate = chromeCandidates().find((path) => path && existsSync(path))
  if (!candidate) throw new Error("Chrome/Chromium was not found. Pass its path with --chrome.")
  return candidate
}

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.unref()
  server.on("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      reject(new Error("Could not reserve a Chrome debugging port"))
      return
    }
    const port = address.port
    server.close(() => resolvePort(port))
  })
})

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

const waitForJson = async (url, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch (error) {
      lastError = error
    }
    await wait(100)
  }
  throw new Error(`Chrome debugging endpoint did not start: ${lastError?.message ?? url}`)
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  async connect() {
    await new Promise((resolveConnect, reject) => {
      this.socket.addEventListener("open", resolveConnect, { once: true })
      this.socket.addEventListener("error", reject, { once: true })
    })
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {})
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject: reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.listeners.set(method, listeners)
    return () => listeners.delete(listener)
  }

  once(method, timeoutMs = 15_000) {
    return new Promise((resolveEvent, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      const unsubscribe = this.on(method, (params) => {
        clearTimeout(timeout)
        unsubscribe()
        resolveEvent(params)
      })
    })
  }

  close() {
    this.socket.close()
  }
}

const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api[-_]?key|x-openchamber/i
const SENSITIVE_QUERY = /token|secret|password|auth|key|code|credential/i

const redactHeaders = (headers = {}) => Object.entries(headers).map(([name, value]) => ({
  name,
  value: SENSITIVE_HEADER.test(name) ? "[REDACTED]" : String(value),
}))

const redactUrl = (value) => {
  try {
    const url = new URL(value)
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(name)) url.searchParams.set(name, "[REDACTED]")
    }
    return url.toString()
  } catch {
    return value
  }
}

const redactTraceJson = (key, value) => {
  if (SENSITIVE_HEADER.test(key)) return "[REDACTED]"
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return redactUrl(value)
  return value
}

const createHar = (records, pageUrl, startedAt) => ({
  log: {
    version: "1.2",
    creator: { name: "OpenChamber browser profiler", version: "1" },
    pages: [{ startedDateTime: startedAt, id: "page_1", title: "OpenChamber profile", pageTimings: {} }],
    entries: [...records.values()].map((record) => {
      const start = record.wallTime ? new Date(record.wallTime * 1000).toISOString() : startedAt
      const duration = record.finishedAt && record.startedAt
        ? Math.max(0, (record.finishedAt - record.startedAt) * 1000)
        : 0
      return {
        pageref: "page_1",
        startedDateTime: start,
        time: duration,
        request: {
          method: record.request?.method ?? "GET",
          url: redactUrl(record.request?.url ?? pageUrl),
          httpVersion: "HTTP/1.1",
          headers: redactHeaders(record.request?.headers),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: record.request?.postData ? Buffer.byteLength(record.request.postData) : 0,
        },
        response: {
          status: record.response?.status ?? 0,
          statusText: record.response?.statusText ?? (record.failed ? "Failed" : ""),
          httpVersion: record.response?.protocol ?? "",
          headers: redactHeaders(record.response?.headers),
          cookies: [],
          content: {
            size: record.encodedDataLength ?? 0,
            mimeType: record.response?.mimeType ?? "",
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: record.encodedDataLength ?? -1,
        },
        cache: {},
        timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: duration, receive: 0, ssl: -1 },
        _resourceType: record.type ?? null,
        _failed: record.failed ?? null,
      }
    }),
  },
})

const metricMap = (metrics = []) => Object.fromEntries(metrics.map(({ name, value }) => [name, value]))

const evaluateValue = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value ?? null
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const chrome = resolveChrome(options.chrome)
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const output = resolve(options.output ?? join("artifacts", `browser-profile-${timestamp}`))
  const profileDir = resolve(options.profileDir)
  await mkdir(output, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  const port = await reservePort()
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ]
  if (options.headless) chromeArgs.unshift("--headless=new", "--disable-gpu")

  const chromeProcess = spawn(chrome, chromeArgs, { stdio: "ignore" })
  let client
  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json`)
    const target = targets.find((entry) => entry.type === "page")
    if (!target?.webSocketDebuggerUrl) throw new Error("Chrome page target was not found")
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
      client.send("Performance.enable"),
    ])

    const loaded = client.once("Page.loadEventFired", 30_000)
    await client.send("Page.navigate", { url: options.url })
    await loaded
    await evaluateValue(client, `localStorage.setItem("openchamber_sync_perf", "1")`)
    const reloaded = client.once("Page.loadEventFired", 30_000)
    await client.send("Page.reload", { ignoreCache: false })
    await reloaded

    if (options.prompt && !options.headless && process.stdin.isTTY) {
      const readline = createInterface({ input: process.stdin, output: process.stdout })
      console.log(`\nChrome opened ${options.url}. Prepare the sessions and screen you want to measure.`)
      await readline.question("Press Enter to start recording... ")
      readline.close()
    } else {
      console.log("Waiting 5 seconds before recording...")
      await wait(5_000)
    }

    await evaluateValue(client, `window.__openchamberSyncPerformance?.reset()`)
    const records = new Map()
    const traceEvents = []
    const startedAt = new Date().toISOString()
    const unsubscribers = [
      client.on("Network.requestWillBeSent", (event) => {
        records.set(event.requestId, {
          request: event.request,
          type: event.type,
          startedAt: event.timestamp,
          wallTime: event.wallTime,
        })
      }),
      client.on("Network.responseReceived", (event) => {
        const record = records.get(event.requestId)
        if (record) record.response = event.response
      }),
      client.on("Network.loadingFinished", (event) => {
        const record = records.get(event.requestId)
        if (record) {
          record.finishedAt = event.timestamp
          record.encodedDataLength = event.encodedDataLength
        }
      }),
      client.on("Network.loadingFailed", (event) => {
        const record = records.get(event.requestId)
        if (record) {
          record.finishedAt = event.timestamp
          record.failed = event.errorText
        }
      }),
      client.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...(value ?? []))),
    ]

    const beforeMetrics = metricMap((await client.send("Performance.getMetrics")).metrics)
    const beforeHeap = await client.send("Runtime.getHeapUsage")
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      categories: [
        "devtools.timeline",
        "v8.execute",
        "blink.user_timing",
        "loading",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
      ].join(","),
    })

    console.log(`Recording for ${options.duration} seconds. Use OpenChamber normally during this window.`)
    await wait(options.duration * 1000)
    const afterMetrics = metricMap((await client.send("Performance.getMetrics")).metrics)
    const afterHeap = await client.send("Runtime.getHeapUsage")
    const syncCounters = await evaluateValue(client, `window.__openchamberSyncPerformance?.getSnapshot() ?? null`)
    const traceComplete = client.once("Tracing.tracingComplete", 30_000)
    await client.send("Tracing.end")
    await traceComplete
    for (const unsubscribe of unsubscribers) unsubscribe()

    const longTasks = traceEvents.filter((event) => event.name === "RunTask" && Number(event.dur) >= 50_000)
    const summary = {
      recordedAt: startedAt,
      url: redactUrl(options.url),
      durationSeconds: options.duration,
      requests: records.size,
      failedRequests: [...records.values()].filter((record) => record.failed).length,
      transferredBytes: [...records.values()].reduce((total, record) => total + (record.encodedDataLength ?? 0), 0),
      longTasksOver50ms: longTasks.length,
      longestTaskMs: longTasks.reduce((max, event) => Math.max(max, Number(event.dur) / 1000), 0),
      performanceMetricsBefore: beforeMetrics,
      performanceMetricsAfter: afterMetrics,
      heapBefore: beforeHeap,
      heapAfter: afterHeap,
      syncCounters,
      privacy: "Headers and sensitive URL parameters are redacted. Response bodies are not captured.",
    }

    await Promise.all([
      writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents }, redactTraceJson)),
      writeFile(join(output, "network.har"), JSON.stringify(createHar(records, options.url, startedAt), null, 2)),
      writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2)),
    ])
    console.log(`\nProfile saved to ${output}`)
    console.log(`Long tasks over 50 ms: ${summary.longTasksOver50ms}; requests: ${summary.requests}`)
  } finally {
    client?.close()
    if (!chromeProcess.killed) chromeProcess.kill("SIGTERM")
  }
}

main().catch((error) => {
  console.error(`Browser profiling failed: ${error.message}`)
  process.exitCode = 1
})
