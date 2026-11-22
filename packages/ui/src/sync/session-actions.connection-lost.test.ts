import { describe, expect, test } from "bun:test"
import { useConfigStore } from "@/stores/useConfigStore"
import { ConnectionLostError } from "./connection-lost-error"
import { waitForConnectionOrThrow } from "./session-actions"

/**
 * The reply gate refuses before a request is made, so callers have to be able
 * to tell that apart from a server-side failure: #6677 showed a form answer
 * reported as "could not submit" when nothing had been sent.
 */
const refusal = async (lastDisconnectReason: string | null): Promise<ConnectionLostError | null> => {
  const before = useConfigStore.getState()
  useConfigStore.setState({
    isConnected: false,
    hasEverConnected: true,
    lastDisconnectReason,
    probeConnection: async () => false,
  })
  try {
    await waitForConnectionOrThrow()
    return null
  } catch (caught) {
    if (caught instanceof ConnectionLostError) return caught
    throw caught
  } finally {
    useConfigStore.setState({
      isConnected: before.isConnected,
      hasEverConnected: before.hasEverConnected,
      lastDisconnectReason: before.lastDisconnectReason,
      probeConnection: before.probeConnection,
    })
  }
}

describe("waitForConnectionOrThrow", () => {
  test("rejects with ConnectionLostError, keeping the disconnect reason", async () => {
    const error = await refusal("1006")

    expect(error).toBeInstanceOf(ConnectionLostError)
    expect(error).toMatchObject({ reason: "1006", everConnected: true })
    expect(error?.message).toBe("Connection lost (1006). Please wait for reconnection.")
  }, 20_000)

  test("rejects without a reason when the disconnect named none", async () => {
    const error = await refusal(null)

    expect(error).toBeInstanceOf(ConnectionLostError)
    expect(error).toMatchObject({ reason: null, everConnected: true })
    expect(error?.message).toBe("Connection lost. Please wait for reconnection.")
  }, 20_000)
})

describe("ConnectionLostError", () => {
  test("keeps the English message for callers that show it as is", () => {
    const error = new ConnectionLostError({ reason: null, everConnected: false })
    expect(error).toMatchObject({ reason: null, everConnected: false })
    expect(error.message).toBe("Connection lost (never connected). Please wait for reconnection.")
  })
})
