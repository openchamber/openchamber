import { describe, expect, test } from "bun:test"

import { loadSessionMessagePage } from "../session-message-loader"

describe("loadSessionMessagePage", () => {
  test("coalesces imperative and reactive requests for the same runtime session page", async () => {
    let calls = 0
    let release: ((value: string) => void) | undefined
    const request = () => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const input = {
      runtimeKey: "runtime-a",
      directory: "/repo",
      sessionID: "ses_1",
      request,
    }
    const imperative = loadSessionMessagePage(input)
    const reactive = loadSessionMessagePage(input)

    expect(calls).toBe(1)
    release?.("page")
    expect(await imperative).toBe("page")
    expect(await reactive).toBe("page")
  })

  test("keeps cursor and runtime pages independent", async () => {
    let calls = 0
    const request = async () => ++calls

    await Promise.all([
      loadSessionMessagePage({ runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", request }),
      loadSessionMessagePage({ runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", before: "msg_20", request }),
      loadSessionMessagePage({ runtimeKey: "runtime-b", directory: "/repo", sessionID: "ses_1", request }),
    ])

    expect(calls).toBe(3)
  })

  test("clears a failed request so the next attempt can retry", async () => {
    let calls = 0
    const request = async () => {
      calls += 1
      if (calls === 1) throw new Error("not ready")
      return "recovered"
    }

    const input = { runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", request }
    await expect(loadSessionMessagePage(input)).rejects.toThrow("not ready")
    const recovered = await loadSessionMessagePage(input)
    expect(recovered).toBe("recovered")
    expect(calls).toBe(2)
  })
})
