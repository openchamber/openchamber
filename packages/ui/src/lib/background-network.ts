/**
 * Shared concurrency gate for background network traffic.
 *
 * The browser allows only ~6 concurrent HTTP/1.1 connections per origin, and
 * every runtime (web, desktop loopback, VS Code, mobile host) funnels API
 * traffic through one origin. During startup many subsystems fan out at once —
 * per-directory session/status polls, git checks per project and worktree,
 * command/skill discovery, global session pages — and several of those calls
 * are slow while the OpenCode server is still warming up. Uncapped, they
 * occupy the whole connection pool and interactive traffic (opening a session
 * and fetching its messages) queues for seconds behind them.
 *
 * Session pages use {@link runSessionListNetworkTask}; other poll/prefetch reads
 * and directory initialization use {@link runBackgroundNetworkTask}. The lanes
 * share a fixed aggregate budget, with reserved list capacity so a slow Git or
 * skills request cannot block an empty worktree's session list. GitHub PR
 * status also takes a background slot, in addition to its own fan-out cap.
 * An independent PR budget used to overfill the browser's pool alongside
 * three persistent SSE connections, despite each limiter looking bounded.
 */

import { captureRuntimeInstance, subscribeRuntimeEndpointWillChange } from './runtime-switch'

type NetworkLane = {
  active: number
  waiters: Array<(admitted: boolean) => void>
  activeSessionWaiters: Array<(admitted: boolean) => void>
}
const createLane = (): NetworkLane => ({ active: 0, waiters: [], activeSessionWaiters: [] })
let background = createLane()
let sessionLists = createLane()
const TOTAL_LIMIT = 3
const LANE_LIMIT = 2

// Retire before changed listeners can enqueue the replacement instance's reads.
subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
  if (runtimeKey === previousRuntimeKey) return
  const retired = [background, sessionLists]
  background = createLane()
  sessionLists = createLane()
  for (const lane of retired) {
    for (const waiter of [...lane.activeSessionWaiters, ...lane.waiters]) waiter(false)
    lane.activeSessionWaiters.length = 0
    lane.waiters.length = 0
  }
})

const pump = () => {
  while (background.active + sessionLists.active < TOTAL_LIMIT) {
    // Background reads never occupy the reserved list slot. Either lane may
    // use a second slot, without serializing independent background queries.
    const lane = sessionLists.active < LANE_LIMIT && sessionLists.waiters.length > 0
      ? sessionLists
      : background.active < LANE_LIMIT && (background.activeSessionWaiters.length > 0 || background.waiters.length > 0)
        ? background
        : null
    if (!lane) return
    const next = lane.activeSessionWaiters.shift() ?? lane.waiters.shift()
    if (!next) return
    lane.active += 1
    next(true)
  }
}

async function run<T>(lane: NetworkLane, task: () => Promise<T>, priority: "normal" | "active-session"): Promise<T | undefined> {
  const isCurrent = captureRuntimeInstance()
  const admitted = await new Promise<boolean>((resolve) => {
    if (priority === "active-session") lane.activeSessionWaiters.push(resolve)
    else lane.waiters.push(resolve)
    pump()
  })
  if (!admitted) return undefined
  try {
    if (!isCurrent()) return undefined
    const result = await task()
    return isCurrent() ? result : undefined
  } finally {
    lane.active -= 1
    pump()
  }
}

/** Undefined means retired work, never a successful empty response. */
export const runBackgroundNetworkTask = <T>(task: () => Promise<T>, priority: "normal" | "active-session" = "normal") => run(background, task, priority)
export const runSessionListNetworkTask = <T>(task: () => Promise<T>) => run(sessionLists, task, "normal")

const snapshot = (lane: NetworkLane) => ({ active: lane.active, waiting: lane.waiters.length + lane.activeSessionWaiters.length, limit: LANE_LIMIT })

/** Test-only visibility into both lanes. */
export const getBackgroundNetworkState = () => ({
  ...snapshot(background),
  sessionLists: snapshot(sessionLists),
})
