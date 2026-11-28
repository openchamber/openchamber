import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

const HEARTBEAT_INTERVAL_MS = 15_000
const MOBILE_HEARTBEAT_INTERVAL_MS = 30_000
const STALE_AFTER_MISSED_HEARTBEAT_MS = 5_000

export const messageStreamHeartbeatIntervalMs = (): number =>
  isMobileSurfaceRuntime() ? MOBILE_HEARTBEAT_INTERVAL_MS : HEARTBEAT_INTERVAL_MS

export const messageStreamStaleAfterMs = (): number =>
  messageStreamHeartbeatIntervalMs() + STALE_AFTER_MISSED_HEARTBEAT_MS

export const globalEventWsQuery = (lastEventId: string | undefined, heartbeatIntervalMs: number) => {
  const heartbeat = String(heartbeatIntervalMs)
  return lastEventId ? { heartbeat, lastEventId } : { heartbeat }
}
