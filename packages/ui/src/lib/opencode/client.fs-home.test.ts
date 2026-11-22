import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "./client"
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../runtime-url"

/**
 * A desktop window restoring its default host switches the runtime before the
 * client is rebound to it. The home and chats root read in between are kept
 * under the new host's runtime key, so they must come from that host.
 */

const previous = getRuntimeUrlResolver()
beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: "https://previous-host.test" })
  opencodeClient.reconnectToRuntimeBaseUrl()
})
afterEach(() => {
  setRuntimeUrlResolver(previous)
  opencodeClient.reconnectToRuntimeBaseUrl()
})

describe("home lookup across a runtime switch", () => {
  test("asks the host the runtime names now, before the client is rebound", async () => {
    const requested: string[] = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      requested.push(`${url.origin}${url.pathname}`)
      return Response.json({ home: "/Users/me", chatsRoot: "/Users/me/.config/openchamber/chats" })
    })
    try {
      // What switchRuntimeEndpoint does before any endpoint-changed subscriber runs.
      configureRuntimeUrlResolver({ apiBaseUrl: "https://next-host.test" })
      expect((await opencodeClient.getFilesystemHomeInfo()).chatsRoot).toBe("/Users/me/.config/openchamber/chats")
      expect(await opencodeClient.getFilesystemHome()).toBe("/Users/me")
      expect(requested).toEqual(["https://next-host.test/api/fs/home", "https://next-host.test/api/fs/home"])
    } finally {
      fetch.mockRestore()
    }
  })
})
