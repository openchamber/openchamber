import { create } from "zustand"
import { useConfigStore } from "@/stores/useConfigStore"
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch"


const OPENCODE_STARTUP_SEND_WAIT_MS = 180_000

type OpenCodeStartupState = {
  waitingSends: number
}

export const useOpenCodeStartupStore = create<OpenCodeStartupState>()(() => ({ waitingSends: 0 }))

type ConnectionState = { isConnected: boolean; hasEverConnected: boolean }

export const isOpenCodeStarting = (state: ConnectionState = useConfigStore.getState()): boolean =>
  !state.isConnected && !state.hasEverConnected

export class OpenCodeStartupError extends Error {}

const changeWaitingSends = (delta: number) => {
  useOpenCodeStartupStore.setState((state) => ({ waitingSends: Math.max(0, state.waitingSends + delta) }))
}

function untilFirstConnection(
  timeoutMs: number,
  failures: { timeout: string; runtimeChanged: string },
): Promise<void> {
  const runtimeKey = getRuntimeKey()
  return new Promise<void>((resolve, reject) => {
    const cleanups: Array<() => void> = []
    const finish = (error?: Error) => {
      for (const cleanup of cleanups) cleanup()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new OpenCodeStartupError(failures.timeout)), timeoutMs)
    cleanups.push(() => clearTimeout(timer))
    cleanups.push(subscribeRuntimeEndpointChanged(() => {
      finish(new OpenCodeStartupError(failures.runtimeChanged))
    }))
    cleanups.push(useConfigStore.subscribe((state) => {
      if (getRuntimeKey() !== runtimeKey) {
        finish(new OpenCodeStartupError(failures.runtimeChanged))
      } else if (state.isConnected) {
        finish()
      }
    }))
  })
}

export async function waitForOpenCodeStartup(timeoutMs = OPENCODE_STARTUP_SEND_WAIT_MS): Promise<void> {
  if (!isOpenCodeStarting()) return
  changeWaitingSends(1)
  try {
    await untilFirstConnection(timeoutMs, {
      timeout: "OpenCode did not start in time. The message was not sent.",
      runtimeChanged: "Message was not sent because the runtime changed.",
    })
  } finally {
    changeWaitingSends(-1)
  }
}

export const openCodeStartupSignal = {
  isStarting: (): boolean => isOpenCodeStarting(),
  waitForConnection: async (timeoutMs = OPENCODE_STARTUP_SEND_WAIT_MS): Promise<void> => {
    if (!isOpenCodeStarting()) return
    await untilFirstConnection(timeoutMs, {
      timeout: "OpenCode did not start in time.",
      runtimeChanged: "The runtime changed while OpenCode was starting.",
    })
  },
}

let heldSendsTail: Promise<void> | null = null

export function runAfterOpenCodeStartup<T>(send: () => Promise<T>, timeoutMs = OPENCODE_STARTUP_SEND_WAIT_MS): Promise<T> {
  if (!heldSendsTail && !isOpenCodeStarting()) return send()
  const previous = heldSendsTail
  const turn = (async () => {
    await waitForOpenCodeStartup(timeoutMs)
    await previous
    return send()
  })()
  const settled = turn.then(() => undefined, () => undefined)
  heldSendsTail = settled
  void settled.then(() => {
    if (heldSendsTail === settled) heldSendsTail = null
  })
  return turn
}
