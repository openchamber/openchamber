import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export const LIVE_STATUS_TTL_MS = 15_000

type RuntimeLiveStatus = {
  runtimeKey: string
  directory: string
  sessionId: string
  status: SessionStatus
  expiresAt: number
}

const liveStatusByRuntime = new Map<string, RuntimeLiveStatus>()

const keyFor = (runtimeKey: string, directory: string) => `${runtimeKey}\n${directory}`

export function rememberRuntimeLiveStatus(params: {
  runtimeKey: string
  directory: string | null | undefined
  sessionId: string | null | undefined
  status: SessionStatus | null | undefined
}) {
  if (!params.runtimeKey || !params.directory || !params.sessionId || !params.status) return
  if (params.status.type === "idle") return

  liveStatusByRuntime.set(keyFor(params.runtimeKey, params.directory), {
    runtimeKey: params.runtimeKey,
    directory: params.directory,
    sessionId: params.sessionId,
    status: params.status,
    expiresAt: Date.now() + LIVE_STATUS_TTL_MS,
  })
}

export function getRuntimeLiveStatusSeed(runtimeKey: string, directory: string): RuntimeLiveStatus | null {
  const entry = liveStatusByRuntime.get(keyFor(runtimeKey, directory))
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    liveStatusByRuntime.delete(keyFor(runtimeKey, directory))
    return null
  }
  return entry
}
