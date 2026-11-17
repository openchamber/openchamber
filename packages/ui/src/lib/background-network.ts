
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

export const runBackgroundNetworkTask = <T>(task: () => Promise<T>, priority: "normal" | "active-session" = "normal") => run(background, task, priority)
export const runSessionListNetworkTask = <T>(task: () => Promise<T>) => run(sessionLists, task, "normal")

const snapshot = (lane: NetworkLane) => ({ active: lane.active, waiting: lane.waiters.length + lane.activeSessionWaiters.length, limit: LANE_LIMIT })

export const getBackgroundNetworkState = () => ({
  ...snapshot(background),
  sessionLists: snapshot(sessionLists),
})
