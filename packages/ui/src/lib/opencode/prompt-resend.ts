import { isUndeliveredTransportFailure } from "@/lib/relay/transport-error"
import { captureRuntimeInstance, getRuntimeKey } from "@/lib/runtime-switch"
import { delay } from "@/lib/timing/delay"

const UNDELIVERED_RESEND_DELAYS_MS = [500, 1_000, 2_000, 4_000]
const UNDELIVERED_RESEND_WINDOW_MS = 10_000

type PendingSend = { readonly isCurrent: () => boolean; readonly settled: Promise<void> }

const pendingSends = new Map<string, PendingSend>()
const stopGenerations = new Map<string, number>()

const assertSendRuntime = (runtimeKey: string | undefined, isCurrent: () => boolean): void => {
  if ((runtimeKey && runtimeKey !== getRuntimeKey()) || !isCurrent()) {
    throw new Error("Message was not sent because the runtime changed.")
  }
}

export const captureSendRuntime = (runtimeKey: string | undefined) => {
  const isCurrent = captureRuntimeInstance()
  const assertCanSend = () => assertSendRuntime(runtimeKey, isCurrent)
  assertCanSend()
  return { assertCanSend, isCurrent }
}

export async function inSessionSendOrder<T>(sessionId: string, isCurrent: () => boolean, run: () => Promise<T>): Promise<T> {
  const earlier = pendingSends.get(sessionId)
  const task = (async () => {
    if (earlier?.isCurrent()) await earlier.settled
    return run()
  })()
  const entry: PendingSend = { isCurrent, settled: task.then(() => undefined, () => undefined) }
  pendingSends.set(sessionId, entry)
  try {
    return await task
  } finally {
    if (pendingSends.get(sessionId) === entry) pendingSends.delete(sessionId)
  }
}

export const stopPendingResends = (sessionId: string): void => {
  stopGenerations.set(sessionId, (stopGenerations.get(sessionId) ?? 0) + 1)
}

export async function resendWhileUndelivered<T>(sessionId: string, send: () => Promise<T>, assertCanSend: () => void): Promise<T> {
  const stopGeneration = stopGenerations.get(sessionId) ?? 0
  const deadline = Date.now() + UNDELIVERED_RESEND_WINDOW_MS
  try {
    return await send()
  } catch (error) {
    if (!isUndeliveredTransportFailure(error)) throw error
    let lastError = error
    for (const delayMs of UNDELIVERED_RESEND_DELAYS_MS) {
      if (Date.now() + delayMs > deadline) break
      await delay(delayMs)
      assertCanSend()
      if ((stopGenerations.get(sessionId) ?? 0) !== stopGeneration) break
      try {
        return await send()
      } catch (resendError) {
        if (!isUndeliveredTransportFailure(resendError)) throw resendError
        lastError = resendError
      }
    }
    throw lastError
  }
}
