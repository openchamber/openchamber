#!/usr/bin/env node
/**
 * Fully automated streaming capture for OpenChamber.
 *
 * Where `profile:idle` measures what the app does when nothing happens, this
 * command measures the opposite: what it costs to receive and render a live
 * assistant response. It creates a session, opens it in a real browser, sends a
 * prompt through the supported `openchamber session` CLI, and records until the
 * session reports itself idle again.
 *
 * The streaming path is judged by responsiveness rather than by totals: a
 * response that renders in one 4-second block and one that renders in eighty
 * 50 ms blocks move the same bytes, but only the second stays interactive. The
 * report therefore leads with the long-task distribution, frame production, and
 * per-token render cost, not with elapsed wall time.
 *
 * No input is synthesised. The only stimulus is the prompt, dispatched over the
 * CLI, so everything recorded is the application reacting to its own event
 * stream.
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { buildIdleProbeSource, IDLE_PROBE_GLOBAL } from "./perf/idle-probe.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { growthPerSecond, metricMap, round, summarizeLongTasks, summarizeTraceEvents } from "./perf/metrics.mjs"
import { expandProjects, expandSessionLists } from "./perf/scenario.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cliPath = join(repoRoot, "packages/web/bin/cli.js")

const DEFAULT_PROMPT = "Write a technical explanation of how a bytecode virtual machine executes"
  + " a function call, about 800 words. Include three fenced code blocks in different languages"
  + " and a markdown table comparing stack and register machines. Do not use any tools."

const HELP = `Usage: bun run profile:session -- [options]

Records what OpenChamber costs while an assistant response streams in.

Options:
  --url <url>              OpenChamber URL (default: http://localhost:3000)
  --port <port>            OpenChamber CLI port (default: from --url)
  --dir <path>             Session directory (default: repository root)
  --session <id>           Reuse this session instead of creating one
  --expand-projects        Expand every project in the sidebar before recording
  --expand-sessions        Click every "Show more sessions" control before
                           recording, so all session rows are mounted
  --view-session <id>      Display this session while the prompt streams into
                           another one. Measures what an idle session costs
                           while a different session is active in the
                           background.
  --prompt <text>          Prompt to send (default: a long markdown+code answer)
  --model <provider/model> Model override (default: configured selection)
  --agent <id>             Agent override (default: configured selection)
  --settle <seconds>       Wait after load before recording (default: 12)
  --timeout <seconds>      Give up waiting for idle (default: 600)
  --tail <seconds>         Keep recording after idle (default: 5)
  --output <directory>     Artifact directory
  --label <text>           Human label stored in the summary
  --chrome <path>          Chrome/Chromium executable
  --profile-dir <path>     Reusable isolated Chrome profile
  --headed                 Show the browser (default: headless)
  --sampling-interval <us> CPU sampler interval (default: 200)
  --baseline <directory>   Compare against a previous run directory
  --budget-long-tasks <n>  Fail when long tasks exceed this count
  --budget-longest <ms>    Fail when the longest task exceeds this
  --keep-session           Do not report the session as disposable
  --json                   Print the summary as JSON instead of a table
  --help                   Show this help

Exit code is non-zero when any provided budget is exceeded.`

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000",
    port: null,
    dir: repoRoot,
    session: null,
    viewSession: null,
    expandProjects: false,
    expandSessions: false,
    prompt: DEFAULT_PROMPT,
    model: null,
    agent: null,
    settle: 12,
    timeout: 600,
    tail: 5,
    output: null,
    label: null,
    chrome: null,
    profileDir: join(homedir(), ".openchamber", "browser-profile-google-chrome"),
    headless: true,
    samplingInterval: 200,
    baseline: null,
    budgetLongTasks: null,
    budgetLongest: null,
    keepSession: false,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help") return { ...options, help: true }
    else if (value === "--headed") options.headless = false
    else if (value === "--json") options.json = true
    else if (value === "--keep-session") options.keepSession = true
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--port") options.port = argv[++index]
    else if (value === "--dir") options.dir = argv[++index]
    else if (value === "--session") options.session = argv[++index]
    else if (value === "--view-session") options.viewSession = argv[++index]
    else if (value === "--expand-projects") options.expandProjects = true
    else if (value === "--expand-sessions") options.expandSessions = true
    else if (value === "--prompt") options.prompt = argv[++index]
    else if (value === "--model") options.model = argv[++index]
    else if (value === "--agent") options.agent = argv[++index]
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--timeout") options.timeout = Number(argv[++index])
    else if (value === "--tail") options.tail = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--profile-dir") options.profileDir = argv[++index]
    else if (value === "--sampling-interval") options.samplingInterval = Number(argv[++index])
    else if (value === "--baseline") options.baseline = argv[++index]
    else if (value === "--budget-long-tasks") options.budgetLongTasks = Number(argv[++index])
    else if (value === "--budget-longest") options.budgetLongest = Number(argv[++index])
    else throw new Error(`Unknown option: ${value}`)
  }
  const parsed = new URL(options.url)
  options.port = options.port ?? parsed.port ?? "3000"
  options.dir = resolve(options.dir)
  return options
}

/**
 * Runs an `openchamber session` subcommand and returns its parsed JSON.
 * The CLI is the supported automation entry point, so the harness drives the
 * same path a scripted user would rather than reaching into internal APIs.
 */
const runSessionCli = (args, { timeoutMs = 900_000 } = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [cliPath, "session", ...args, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => {
    child.kill("SIGTERM")
    reject(new Error(`session ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`))
  }, timeoutMs)
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("error", (error) => { clearTimeout(timer); reject(error) })
  child.on("close", (code) => {
    clearTimeout(timer)
    if (code !== 0) {
      reject(new Error(`session ${args[0]} exited with ${code}: ${stderr.trim() || stdout.trim()}`))
      return
    }
    try {
      resolvePromise(JSON.parse(stdout))
    } catch {
      reject(new Error(`session ${args[0]} returned unparseable output: ${stdout.slice(0, 400)}`))
    }
  })
})

/**
 * Reads what the page actually rendered for the session under test.
 *
 * A streaming capture is only meaningful if the recorded page was showing the
 * session that streamed. Opening a session that belongs to a directory the app
 * is not currently viewing produces a perfectly quiet, perfectly useless
 * profile, so the run verifies rendering rather than assuming it.
 */
const countRenderedMessages = async (client) => {
  const raw = await evaluateValue(client, `JSON.stringify({
    messages: document.querySelectorAll("[data-message-id]").length,
    characters: document.body.innerText.length,
  })`)
  try {
    return JSON.parse(raw ?? "{}")
  } catch {
    return { messages: 0, characters: 0 }
  }
}

/**
 * Snapshots the animations the page is running right now.
 *
 * Compositing work shows up in a trace as `Layerize`/`Commit`/`PrePaint` with
 * no indication of what caused it. `document.getAnimations()` names the
 * culprits directly, which turns "the compositor is busy" into a specific list
 * of elements and keyframes.
 */
const snapshotAnimations = async (client) => {
  const raw = await evaluateValue(client, `JSON.stringify((() => {
    if (typeof document.getAnimations !== "function") return []
    const describe = (animation) => {
      const target = animation.effect && animation.effect.target
      const identity = target
        ? \`\${target.tagName.toLowerCase()}\${target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\\s+/).slice(0, 4).join(".") : ""}\`
        : "(no target)"
      const keyframe = animation.animationName
        || (animation.effect && animation.effect.getKeyframes && animation.effect.getKeyframes().length ? "transition/keyframes" : "unknown")
      return \`\${animation.playState} \${keyframe} on \${identity}\`
    }
    const counts = new Map()
    for (const animation of document.getAnimations()) {
      const key = describe(animation)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([description, count]) => ({ description, count }))
  })())`)
  try {
    return JSON.parse(raw ?? "[]")
  } catch {
    return []
  }
}

const REPORTED_METRICS = [
  { key: "longTaskCount", label: "Long tasks (>50ms)", unit: "", lowerIsBetter: true },
  { key: "longestTaskMs", label: "Longest task", unit: "ms", lowerIsBetter: true },
  { key: "taskP95Ms", label: "Task p95", unit: "ms", lowerIsBetter: true },
  { key: "taskP99Ms", label: "Task p99", unit: "ms", lowerIsBetter: true },
  { key: "blockedPercent", label: "Time in long tasks", unit: "%", lowerIsBetter: true },
  { key: "mainThreadBusyPercent", label: "Main-thread busy", unit: "%", lowerIsBetter: true },
  { key: "recalcStylePerSecond", label: "Style recalcs/sec", unit: "", lowerIsBetter: true },
  { key: "layoutsPerSecond", label: "Layouts/sec", unit: "", lowerIsBetter: true },
  { key: "framesPerSecond", label: "Animation frames/sec", unit: "", lowerIsBetter: false },
  { key: "streamSeconds", label: "Stream duration", unit: "s", lowerIsBetter: true },
  { key: "renderedCharacters", label: "Rendered characters", unit: "", lowerIsBetter: false },
  { key: "busyMsPerKilochar", label: "Busy per 1k chars", unit: "ms", lowerIsBetter: true },
  { key: "recalcStylePerKilochar", label: "Style recalcs per 1k", unit: "", lowerIsBetter: true },
  { key: "nodeGrowth", label: "DOM node growth", unit: "", lowerIsBetter: true },
  { key: "listenerGrowth", label: "Listener growth", unit: "", lowerIsBetter: true },
  { key: "heapGrowthMbPerSecond", label: "Heap growth", unit: "MB/s", lowerIsBetter: true },
  { key: "heapMaxMb", label: "Heap max", unit: "MB", lowerIsBetter: true },
]

const formatRow = (label, value, unit) => `${label.padEnd(22)} ${String(value).padStart(12)} ${unit}`

const printReport = (summary, baseline) => {
  const { metrics } = summary
  console.log(`\nStreaming profile — ${summary.metrics.streamSeconds}s response at ${summary.url}`)
  if (summary.label) console.log(`Label: ${summary.label}`)
  console.log(`Session: ${summary.sessionId}${summary.model ? `  Model: ${summary.model}` : ""}`)
  console.log("")
  for (const metric of REPORTED_METRICS) {
    const current = metrics[metric.key]
    if (!baseline) {
      console.log(formatRow(metric.label, current, metric.unit))
      continue
    }
    const previous = baseline.metrics?.[metric.key]
    const change = Number.isFinite(previous) ? round(current - previous) : null
    const marker = change === null || change === 0
      ? ""
      : (change < 0) === metric.lowerIsBetter ? "  improved" : "  WORSE"
    const changeText = change === null ? "n/a" : `${change > 0 ? "+" : ""}${change}`
    console.log(`${formatRow(metric.label, current, metric.unit).padEnd(42)} was ${String(previous ?? "n/a").padStart(10)}  ${changeText.padStart(9)}${marker}`)
  }

  console.log("\nTop self time while streaming:")
  for (const entry of summary.cpuProfile?.topSelfTime?.slice(0, 15) ?? []) {
    console.log(`  ${String(entry.selfMs).padStart(9)} ms  ${String(entry.percentOfBusy).padStart(5)}%  ${entry.function}`)
  }

  if (summary.runningAnimations?.length) {
    console.log("\nAnimations running mid-stream:")
    for (const entry of summary.runningAnimations.slice(0, 12)) {
      console.log(`  ${String(entry.count).padStart(4)}x  ${entry.description}`)
    }
  } else {
    console.log("\nAnimations running mid-stream: none")
  }

  console.log("\nWhere recorded time went (timeline trace):")
  for (const entry of summary.traceBreakdown?.slice(0, 14) ?? []) {
    console.log(`  ${String(entry.totalMs).padStart(9)} ms  ${String(entry.count).padStart(6)}x  max ${String(entry.maxMs).padStart(7)} ms  ${entry.name}`)
  }

  const streamEntries = summary.streamPerformance?.entries ?? []
  if (streamEntries.length > 0) {
    console.log("\nApplication stream counters (total ms / count):")
    for (const entry of [...streamEntries].sort((left, right) => right.total - left.total).slice(0, 12)) {
      console.log(`  ${String(round(entry.total)).padStart(9)} ms  ${String(entry.count).padStart(6)}x  max ${String(round(entry.max)).padStart(7)} ms  ${entry.metric}`)
    }
  }

  console.log("\nTop scheduled-work call sites while streaming:")
  for (const entry of summary.scheduledWork?.sites?.slice(0, 10) ?? []) {
    console.log(`  ${String(entry.totalMs).padStart(9)} ms  ${String(entry.calls).padStart(6)}x  ${entry.site}`)
  }
}

const evaluateBudgets = (summary, options) => {
  const failures = []
  if (Number.isFinite(options.budgetLongTasks) && summary.metrics.longTaskCount > options.budgetLongTasks) {
    failures.push(`Long tasks ${summary.metrics.longTaskCount} exceeds budget ${options.budgetLongTasks}`)
  }
  if (Number.isFinite(options.budgetLongest) && summary.metrics.longestTaskMs > options.budgetLongest) {
    failures.push(`Longest task ${summary.metrics.longestTaskMs}ms exceeds budget ${options.budgetLongest}ms`)
  }
  return failures
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const chrome = resolveChrome(options.chrome)
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const output = resolve(options.output ?? join("artifacts", `session-profile-${timestamp}`))
  const profileDir = resolve(options.profileDir)
  await mkdir(output, { recursive: true })
  await mkdir(profileDir, { recursive: true })

  const baseline = options.baseline
    ? JSON.parse(await readFile(join(resolve(options.baseline), "session-summary.json"), "utf8"))
    : null

  const cliBase = ["--dir", options.dir, "--port", String(options.port)]

  let sessionId = options.session
  if (!sessionId) {
    const created = await runSessionCli([
      "create", ...cliBase,
      "--title", `perf: ${options.label ?? "streaming capture"}`,
    ])
    sessionId = created.sessionId
    console.log(`Created session ${sessionId}`)
  } else {
    console.log(`Reusing session ${sessionId}`)
  }

  const target = new URL(options.url)
  // The displayed session and the streaming session are deliberately separable:
  // a background session must not make the foreground one expensive.
  target.searchParams.set("session", options.viewSession ?? sessionId)

  const port = await reservePort()
  const chromeProcess = launchChrome({ chrome, profileDir, port, headless: options.headless })
  let client
  try {
    const pageTarget = await createPageTarget(port)
    client = new CdpClient(pageTarget.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Performance.enable"),
      client.send("Profiler.enable"),
      client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
    ])
    await client.send("Network.setBypassServiceWorker", { bypass: true })
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: buildIdleProbeSource() })
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    })

    const traceEvents = []
    // A spread push overflows the call stack once a chunk carries hundreds of
    // thousands of events, which a heavily populated sidebar easily produces.
    const unsubscribeTrace = client.on("Tracing.dataCollected", ({ value }) => {
      for (const event of value ?? []) traceEvents.push(event)
    })

    let loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: target.toString() })
    await loaded
    // The application's own stream counters are opt-in; enabling them before
    // the recorded reload keeps their timeline aligned with the capture.
    await evaluateValue(client, `
      localStorage.setItem("openchamber_sync_perf", "1")
      localStorage.setItem("openchamber_stream_perf", "1")
    `)
    if (options.expandProjects) {
      await expandProjects(client)
      console.log("Expanded every project in the sidebar.")
    }
    loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.reload", { ignoreCache: false })
    await loaded

    console.log(`Opened the session; settling for ${options.settle}s.`)
    await wait(options.settle * 1000)

    if (options.expandSessions) {
      const expanded = await expandSessionLists(client)
      console.log(`Expanded ${expanded} collapsed session lists; settling ${options.settle}s again.`)
      await wait(options.settle * 1000)
    }

    await evaluateValue(client, `globalThis[${JSON.stringify(IDLE_PROBE_GLOBAL)}]?.start()`)
    await evaluateValue(client, `window.__openchamberSyncPerformance?.reset()`)
    await evaluateValue(client, `window.__openchamberStreamPerformance?.setEnabled(true)`)
    await evaluateValue(client, `window.__openchamberStreamPerformance?.reset()`)
    await client.send("Profiler.setSamplingInterval", { interval: options.samplingInterval })
    await client.send("Profiler.start")
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      // `RunTask` is only emitted under the disabled-by-default timeline
      // category. Without it the capture silently reports zero long tasks.
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "blink.user_timing",
      ].join(","),
    })

    const before = metricMap((await client.send("Performance.getMetrics")).metrics)
    const renderedBefore = await countRenderedMessages(client)
    const startedAt = Date.now()

    const sendArgs = [
      "send", ...cliBase,
      "--session", sessionId,
      "--prompt", options.prompt,
      ...(options.model ? ["--model", options.model] : []),
      ...(options.agent ? ["--agent", options.agent] : []),
    ]
    console.log("Dispatching the prompt and recording until the session reports idle.")
    const dispatch = runSessionCli(sendArgs, { timeoutMs: options.timeout * 1000 })

    const samples = []
    let dispatchError = null
    let animationSnapshot = null
    let becameIdle = false
    dispatch.catch((error) => { dispatchError = error })

    const deadline = startedAt + options.timeout * 1000
    let sawBusy = false
    while (Date.now() < deadline) {
      await wait(1_000)
      const current = metricMap((await client.send("Performance.getMetrics")).metrics)
      samples.push({
        elapsedSeconds: round((Date.now() - startedAt) / 1000),
        jsHeapUsedMb: round(Number(current.JSHeapUsedSize ?? 0) / (1024 * 1024)),
        jsEventListeners: Number(current.JSEventListeners ?? 0),
        nodes: Number(current.Nodes ?? 0),
        taskDuration: round(Number(current.TaskDuration ?? 0), 3),
      })
      if (dispatchError) break

      // One mid-stream snapshot is enough to name a continuously running
      // animation, and avoids polling overhead inside the measured window.
      if (animationSnapshot === null && Date.now() - startedAt > 15_000) {
        animationSnapshot = await snapshotAnimations(client)
      }

      // `session status` is the authoritative activity source; polling it
      // avoids inferring completion from render or network quiet periods,
      // which a slow provider would misreport as a finished response.
      const status = await runSessionCli(["status", ...cliBase, "--session", sessionId], { timeoutMs: 30_000 })
        .catch(() => null)
      const type = status?.sessionStatus?.type ?? status?.status
      if (type && type !== "idle") sawBusy = true
      if (sawBusy && type === "idle") { becameIdle = true; break }
    }

    if (dispatchError) throw dispatchError
    if (!becameIdle) console.warn(`WARNING: the session did not report idle within ${options.timeout}s; the capture is truncated.`)

    const streamEndedAt = Date.now()
    if (options.tail > 0) await wait(options.tail * 1000)

    const frameLiveness = await evaluateValue(client, `new Promise((resolveFrames) => {
      let frames = 0
      const startedAtFrames = performance.now()
      const tick = () => {
        frames += 1
        if (performance.now() - startedAtFrames < 1000) requestAnimationFrame(tick)
        else resolveFrames({ framesPerSecond: frames, visibilityState: document.visibilityState })
      }
      requestAnimationFrame(tick)
      setTimeout(() => resolveFrames({ framesPerSecond: frames, visibilityState: document.visibilityState }), 2000)
    })`)

    const elapsedSeconds = (Date.now() - startedAt) / 1000
    const renderedAfter = await countRenderedMessages(client)
    const after = metricMap((await client.send("Performance.getMetrics")).metrics)
    const { profile } = await client.send("Profiler.stop")

    const tracingComplete = client.once("Tracing.tracingComplete", 120_000)
    let traceComplete = true
    try {
      await client.send("Tracing.end")
      await tracingComplete
    } catch (error) {
      traceComplete = false
      void tracingComplete.catch(() => undefined)
      console.warn(`Chrome did not confirm trace completion; using the events collected so far: ${error.message}`)
      await wait(2_000)
    }
    unsubscribeTrace()

    await evaluateValue(client, `globalThis[${JSON.stringify(IDLE_PROBE_GLOBAL)}]?.stop()`)
    const probe = await evaluateValue(client, `globalThis[${JSON.stringify(IDLE_PROBE_GLOBAL)}]?.snapshot() ?? null`)
    const streamPerformance = await evaluateValue(client, `window.__openchamberStreamPerformance?.getSnapshot() ?? null`)
    const syncCounters = await evaluateValue(client, `window.__openchamberSyncPerformance?.getSnapshot() ?? null`)
    const dispatchResult = await dispatch.catch(() => null)

    // Both signals must agree: new message elements in the DOM and the
    // application's own message-list render counters firing.
    const messageListRendered = (streamPerformance?.entries ?? [])
      .some((entry) => entry.metric.startsWith("ui.message_list") && entry.count > 0)
    const renderedStream = options.viewSession
      ? true
      : renderedAfter.messages > renderedBefore.messages && messageListRendered

    const renderedCharacterGrowth = renderedAfter.characters - renderedBefore.characters

    const tasks = summarizeLongTasks(traceEvents)
    const traceBreakdown = summarizeTraceEvents(traceEvents)
    const delta = (name) => Number(after[name] ?? 0) - Number(before[name] ?? 0)
    const perSecond = (name) => round(delta(name) / elapsedSeconds)
    const heapSamples = samples.map((sample) => sample.jsHeapUsedMb)
    const streamSeconds = round((streamEndedAt - startedAt) / 1000)

    const summary = {
      recordedAt: new Date(startedAt).toISOString(),
      label: options.label,
      url: options.url,
      sessionId,
      viewedSessionId: options.viewSession ?? sessionId,
      directory: options.dir,
      prompt: options.prompt,
      model: dispatchResult?.model ? `${dispatchResult.model.providerID}/${dispatchResult.model.modelID}` : options.model,
      agent: dispatchResult?.agent ?? options.agent,
      reachedIdle: becameIdle,
      renderedStream,
      renderedMessagesBefore: renderedBefore.messages,
      renderedMessagesAfter: renderedAfter.messages,
      renderedCharacterGrowth,
      traceComplete,
      disposableSession: !options.keepSession && !options.session,
      metrics: {
        ...tasks,
        blockedPercent: round((tasks.longTaskTotalMs / (elapsedSeconds * 1000)) * 100),
        mainThreadBusyPercent: round((delta("TaskDuration") / elapsedSeconds) * 100),
        recalcStylePerSecond: perSecond("RecalcStyleCount"),
        layoutsPerSecond: perSecond("LayoutCount"),
        framesPerSecond: round(Number(probe?.counters?.rafScheduled ?? 0) / elapsedSeconds),
        // Response length varies between runs even for an identical prompt, so
        // per-second and total figures are not comparable across captures.
        // Normalising by rendered output is what makes two runs contrastable.
        renderedCharacters: renderedCharacterGrowth,
        busyMsPerKilochar: renderedCharacterGrowth > 0
          ? round((delta("TaskDuration") * 1000) / (renderedCharacterGrowth / 1000))
          : 0,
        recalcStylePerKilochar: renderedCharacterGrowth > 0
          ? round(delta("RecalcStyleCount") / (renderedCharacterGrowth / 1000))
          : 0,
        streamSeconds,
        recordedSeconds: round(elapsedSeconds),
        nodeStart: Number(before.Nodes ?? 0),
        nodeEnd: Number(after.Nodes ?? 0),
        nodeGrowth: delta("Nodes"),
        listenerStart: Number(before.JSEventListeners ?? 0),
        listenerEnd: Number(after.JSEventListeners ?? 0),
        listenerGrowth: delta("JSEventListeners"),
        heapStartMb: round(heapSamples.at(0) ?? 0),
        heapEndMb: round(heapSamples.at(-1) ?? 0),
        heapMaxMb: round(heapSamples.reduce((max, value) => Math.max(max, value), 0)),
        heapGrowthMbPerSecond: growthPerSecond(samples, "jsHeapUsedMb"),
      },
      frameLiveness,
      runningAnimations: animationSnapshot ?? [],
      cpuProfile: summarizeCpuProfile(profile),
      traceBreakdown,
      streamPerformance,
      syncCounters,
      scheduledWork: probe,
      samples,
    }

    await writeFile(join(output, "session-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))

    if (tasks.taskCount === 0) {
      console.warn(
        "\nWARNING: the trace contained no RunTask events, so every long-task number below is a"
        + " placeholder zero rather than a measurement. Check the tracing categories before trusting them.",
      )
    }

    if (!renderedStream) {
      console.warn(
        "\nWARNING: the recorded page never rendered the streaming session"
        + ` (message elements ${renderedBefore.messages} -> ${renderedAfter.messages},`
        + ` message-list renders ${messageListRendered ? "fired" : "never fired"}).`
        + "\nThe session most likely belongs to a directory the browser is not viewing."
        + " Pass --dir for the directory the app has open. This capture measures nothing.",
      )
    }

    if (options.json) console.log(JSON.stringify(summary, null, 2))
    else printReport(summary, baseline)
    console.log(`\nSaved to ${output}`)
    if (summary.disposableSession) console.log(`Session ${sessionId} was created by this run and can be deleted.`)

    const failures = evaluateBudgets(summary, options)
    if (failures.length > 0) {
      console.error(`\nBudget failures:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
      process.exitCode = 1
    }
  } finally {
    client?.close()
    if (!chromeProcess.killed) chromeProcess.kill("SIGTERM")
  }
}

main().catch((error) => {
  console.error(`Session profiling failed: ${error.message}`)
  process.exitCode = 1
})
