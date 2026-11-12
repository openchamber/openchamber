import { create } from "zustand"
import { useConfigStore } from "@/stores/useConfigStore"
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch"

/**
 * The app shell and composer are usable before OpenCode is ready. A message
 * sent in that window waits here and goes out the moment OpenCode connects,
 * instead of failing with "Connection lost".
 *
 * Only the first connection of the page waits. Once OpenCode has connected,
 * a later disconnect keeps the short reconnect grace of
 * `waitForConnectionOrThrow`, so a dead server still fails a send quickly.
 */

/** Longer than the app's own startup retries take to give up. */
const OPENCODE_STARTUP_SEND_WAIT_MS = 180_000

type OpenCodeStartupState = {
  /** Sends waiting for OpenCode's first connection; the composer can show it. */
  waitingSends: number
}

export const useOpenCodeStartupStore = create<OpenCodeStartupState>()(() => ({ waitingSends: 0 }))

type ConnectionState = { isConnected: boolean; hasEverConnected: boolean }

/** True while this page has not yet connected to OpenCode. */
export const isOpenCodeStarting = (state: ConnectionState = useConfigStore.getState()): boolean =>
  !state.isConnected && !state.hasEverConnected

export class OpenCodeStartupError extends Error {}

const changeWaitingSends = (delta: number) => {
  useOpenCodeStartupStore.setState((state) => ({ waitingSends: Math.max(0, state.waitingSends + delta) }))
}

/**
 * Resolves when the page first connects to OpenCode. Rejects with `failures`
 * when the runtime changes meanwhile or OpenCode does not start in `timeoutMs`.
 */
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

/**
 * Resolves at once unless OpenCode is still starting; then resolves when it
 * connects. Rejects when the runtime changes meanwhile or OpenCode does not
 * start within `timeoutMs`, so the caller restores the message.
 */
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

/**
 * A read made while OpenCode was starting may have failed only because
 * OpenCode was not there yet. The session message loader uses this to read
 * again once it connects instead of showing that failure. It is not a held send, so the
 * composer's "Waiting for OpenCode" note does not count it.
 */
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

/** The last send held through startup; null once every held send settled. */
let heldSendsTail: Promise<void> | null = null

/**
 * Runs a send once OpenCode has started, in the order sends were made. Every
 * send held through startup would otherwise go out on the same connection
 * notification and race: a later message could reach OpenCode first, and
 * each would fetch the session's project knowledge before the other reported
 * it delivered. A held send starts only after the one before it settled, that
 * is, was handed to OpenCode or failed. A send made while held sends are
 * still going out queues behind them too.
 */
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
