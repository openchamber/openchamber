import assert from "node:assert/strict"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

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

const styleContext = (value) => ({
  vars: {},
  vocabulary: { canvas: { selector: "body" } },
  page: {
    query: () => value === null ? "[]" : "[{}]",
    evaluate: async (expression) => runInNewContext(expression, {
      getComputedStyle: () => ({ getPropertyValue: (property) => property === "background-color" ? value : "" }),
    }),
  },
})

test("style reads the computed property and trims CSS whitespace", async () => {
  await runStep(
    { do: "style", on: "canvas", property: "background-color", equals: "rgb(21, 23, 32)" },
    styleContext(" rgb(21, 23, 32) "),
  )
})

test("style rejects a wrong color or a missing element with the observed value", async () => {
  for (const value of ["rgb(0, 0, 0)", null]) {
    await assert.rejects(
      runStep(
        { do: "style", on: "canvas", property: "background-color", equals: "rgb(21, 23, 32)", timeout: 0.001 },
        styleContext(value),
      ),
      (error) => error instanceof StepFailure && error.message.includes(JSON.stringify(value)),
    )
  }
})

test("style requires an explicit expected value", async () => {
  await assert.rejects(
    runStep({ do: "style", on: "canvas", property: "background-color" }, styleContext("")),
    StepFailure,
  )
})
