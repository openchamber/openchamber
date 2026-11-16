import { expect, test } from "bun:test"
import {
  clearLastActiveSession,
  leaveLastActiveSessionToMainWindow,
  persistLastActiveSession,
  readLastActiveSession,
} from "./last-session-cache"

class TestStorage implements Storage {
  readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

// Its own file: the switch is module state and stays on for the process.
test("a window that left the pointer to the main window neither moves nor clears it", () => {
  const storage = new TestStorage()
  persistLastActiveSession("runtime", { sessionId: "main-window", directory: "/repo" }, storage)

  leaveLastActiveSessionToMainWindow()
  persistLastActiveSession("runtime", { sessionId: "mini-chat", directory: "/other" }, storage)
  clearLastActiveSession("runtime", storage)

  expect(readLastActiveSession("runtime", storage)).toEqual({ sessionId: "main-window", directory: "/repo" })
})
