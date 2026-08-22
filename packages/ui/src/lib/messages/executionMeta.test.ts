import { describe, expect, test } from "bun:test"

import {
  START_FROM_ANSWER_DEFAULT_INSTRUCTIONS,
  composeStartSessionFromAnswerMessage,
} from "./executionMeta"

describe("composeStartSessionFromAnswerMessage", () => {
  test("keeps the selected answer as the prompt content", () => {
    const answer = "Use the approved implementation plan."

    expect(composeStartSessionFromAnswerMessage(`  ${START_FROM_ANSWER_DEFAULT_INSTRUCTIONS}  `, answer)).toBe(
      `${START_FROM_ANSWER_DEFAULT_INSTRUCTIONS}\n\n` +
        "This message below comes from an AI agent in another session. Here is the content of the message:\n" +
        answer,
    )
  })
})
