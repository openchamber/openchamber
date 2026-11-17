import assert from "node:assert/strict"
import { test } from "node:test"

import { runStep, StepFailure } from "./steps.mjs"

test("message request failures use the scenario's session and can be cleared", async () => {
  const calls = []
  const ctx = {
    vars: { b: "ses-target" },
    page: { client: { send: async (...args) => { calls.push(args) } } },
  }
  await runStep({ do: "network.block", urls: ["*/session/{b}/message*"] }, ctx)
  await runStep({ do: "network.allow" }, ctx)
  assert.deepEqual(calls, [
    ["Network.enable"],
    ["Network.setBlockedURLs", { urls: ["*/session/ses-target/message*"] }],
    ["Network.setBlockedURLs", { urls: [] }],
  ])
})

test("a missing session variable cannot silently block the wrong request", async () => {
  const ctx = { vars: {}, page: { client: { send: async () => {} } } }
  await assert.rejects(
    runStep({ do: "network.block", urls: ["*/session/{missing}/message*"] }, ctx),
    StepFailure,
  )
})
