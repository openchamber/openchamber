import { describe, expect, test } from "bun:test"

import { sessionsToClearFromView } from "./notification-store"

const answer = (json: string) => new Response(json, { headers: { "content-type": "application/json" } })

describe("sessions a view reports as cleared", () => {
  test("returns the subagent ids the server cleared", async () => {
    expect(await sessionsToClearFromView(answer('{"clearedSessionIds":["ses_child","ses_grandchild"]}'), "ses_parent"))
      .toEqual(["ses_child", "ses_grandchild"])
  })

  test("leaves out the viewed session and repeats", async () => {
    expect(await sessionsToClearFromView(answer('{"clearedSessionIds":["ses_parent","ses_child","ses_child"]}'), "ses_parent"))
      .toEqual(["ses_child"])
  })

  test("answers nothing for an answer without that list", async () => {
    expect(await sessionsToClearFromView(answer('{"success":true,"sessionId":"ses_parent","viewed":true}'), "ses_parent")).toEqual([])
    expect(await sessionsToClearFromView(answer('{"clearedSessionIds":["ses_child",7,""]}'), "ses_parent")).toEqual([])
    expect(await sessionsToClearFromView(new Response("not json", { status: 500 }), "ses_parent")).toEqual([])
  })
})
