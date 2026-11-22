import { describe, expect, test } from "bun:test"

import type { Message, UserMessage } from "./model"
import { readPromptOrigin } from "./prompt-origin"

const written: UserMessage = { id: "msg_prompt", sessionID: "ses_child", role: "user", time: { created: 10 } }
const prompt = (metadata: UserMessage["metadata"]): UserMessage => ({ ...written, metadata })

describe("readPromptOrigin", () => {
  test("reads the sending session and its title", () => {
    expect(readPromptOrigin(prompt({ openchamber: { promptedBy: { sessionID: "ses_parent", title: "PR triage" } } })))
      .toEqual({ sessionID: "ses_parent", title: "PR triage" })
  })

  test("keeps the session when the title is missing or unusable", () => {
    expect(readPromptOrigin(prompt({ openchamber: { promptedBy: { sessionID: "ses_parent" } } })))
      .toEqual({ sessionID: "ses_parent" })
    expect(readPromptOrigin(prompt({ openchamber: { promptedBy: { sessionID: "ses_parent", title: 42 } } })))
      .toEqual({ sessionID: "ses_parent" })
  })

  test("a message the user wrote has no origin", () => {
    expect(readPromptOrigin(written)).toBeUndefined()
    expect(readPromptOrigin(prompt({ openchamber: { promptedBy: { sessionID: " " } } }))).toBeUndefined()
    const synthetic: Message = {
      id: "msg_synthetic",
      sessionID: "ses_child",
      role: "synthetic",
      time: { created: 10 },
      text: "x",
      metadata: { openchamber: { promptedBy: { sessionID: "ses_parent" } } },
    }
    expect(readPromptOrigin(synthetic)).toBeUndefined()
  })
})
