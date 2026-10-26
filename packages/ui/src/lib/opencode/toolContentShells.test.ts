import { describe, expect, test } from "bun:test"

import { projectToolPart } from "./projection"
import { toolContentShellChars } from "./toolContentShells"

const owner = { sessionID: "ses_1", messageID: "msg_1" }

describe("toolContentShellChars", () => {
  test("reads the marker the server puts on a shelled call", () => {
    const part = projectToolPart({
      type: "tool",
      id: "call_1",
      name: "read",
      time: { created: 1, ran: 2, completed: 3 },
      state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "" }], metadata: { openchamberContentShell: { chars: 120 } } },
    }, owner)
    expect(toolContentShellChars(part)).toBe(120)
  })

  test("treats a call without a well-formed marker as whole", () => {
    const whole = projectToolPart({
      type: "tool",
      id: "call_1",
      name: "read",
      time: { created: 1, ran: 2, completed: 3 },
      state: { status: "completed", input: {}, content: [{ type: "text", text: "body" }], metadata: { openchamberContentShell: "yes" } },
    }, owner)
    expect(toolContentShellChars(whole)).toBeNull()
    const running = projectToolPart({
      type: "tool",
      id: "call_2",
      name: "shell",
      time: { created: 1, ran: 2 },
      state: { status: "running", input: {}, metadata: { openchamberContentShell: { chars: 1 } } },
    }, owner)
    expect(toolContentShellChars(running)).toBeNull()
  })
})
