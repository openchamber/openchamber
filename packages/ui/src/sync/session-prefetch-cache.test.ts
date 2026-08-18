import { afterEach, describe, expect, test } from "bun:test"
import {
  clearDirectorySessionPrefetch,
  clearRuntimeSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"

const runtimes = ["prefetch-runtime-a", "prefetch-runtime-b"]

afterEach(() => {
  for (const runtimeKey of runtimes) clearRuntimeSessionPrefetch(runtimeKey)
})

describe("session prefetch cache", () => {
  test("isolates colliding directory and session IDs by runtime", () => {
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 10, complete: false, runtimeKey: runtimes[0] })
    setSessionPrefetch({ directory: "/repo", sessionID: "session", limit: 20, complete: true, runtimeKey: runtimes[1] })

    expect(getSessionPrefetch("/repo", "session", runtimes[0])?.limit).toBe(10)
    expect(getSessionPrefetch("/repo", "session", runtimes[1])?.limit).toBe(20)
  })

  test("clears only the owning runtime and directory", () => {
    setSessionPrefetch({ directory: "/repo-a", sessionID: "session", limit: 10, complete: false, runtimeKey: runtimes[0] })
    setSessionPrefetch({ directory: "/repo-b", sessionID: "session", limit: 20, complete: false, runtimeKey: runtimes[0] })
    setSessionPrefetch({ directory: "/repo-a", sessionID: "session", limit: 30, complete: false, runtimeKey: runtimes[1] })

    clearDirectorySessionPrefetch("/repo-a", runtimes[0])

    expect(getSessionPrefetch("/repo-a", "session", runtimes[0])).toBe(undefined)
    expect(getSessionPrefetch("/repo-b", "session", runtimes[0])?.limit).toBe(20)
    expect(getSessionPrefetch("/repo-a", "session", runtimes[1])?.limit).toBe(30)
  })

  test("bounds retained metadata globally", () => {
    for (let index = 0; index <= 200; index += 1) {
      setSessionPrefetch({
        directory: "/repo",
        sessionID: `session-${index}`,
        limit: index,
        complete: false,
        runtimeKey: runtimes[0],
      })
    }

    expect(getSessionPrefetch("/repo", "session-0", runtimes[0])).toBe(undefined)
    expect(getSessionPrefetch("/repo", "session-200", runtimes[0])?.limit).toBe(200)
  })
})
