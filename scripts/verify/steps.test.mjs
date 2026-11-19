import assert from "node:assert/strict"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

import { runStep, StepFailure } from "./steps.mjs"

test("clipboard line checks accept native newlines but preserve order, contents and strict text checks", async () => {
  const ctx = { vars: {}, page: { evaluate: async () => "first\r\nsecond\r\n" } }
  await runStep({ do: "clipboard", containsLines: ["first", "second"] }, ctx)
  for (const containsLines of [["second", "first"], ["first", "changed"]]) {
    await assert.rejects(runStep({ do: "clipboard", containsLines, timeout: 0.001 }, ctx), /consecutive lines/)
  }
  await assert.rejects(runStep({ do: "clipboard", contains: "first\nsecond", timeout: 0.001 }, ctx), /does not contain/)
})

test("settings expect reads saved global flags without allowing global writes", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, method: options?.method ?? "GET" })
    return Response.json({ agentWorkflowToolEnabled: true, agentWorkflowAutoApprove: true })
  })
  const ctx = { stand: { apiUrl: "http://stand" } }
  await runStep({ do: "settings", expect: { agentWorkflowToolEnabled: true, agentWorkflowAutoApprove: true } }, ctx)
  assert.deepEqual(calls, [{ url: "http://stand/api/config/settings", method: "GET" }])
  await assert.rejects(runStep({ do: "settings", values: { agentWorkflowToolEnabled: true } }, ctx), /not profile settings/)
  await assert.rejects(runStep({ do: "settings", expect: {} }, ctx), /at least one field/)
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }))
  await assert.rejects(runStep({ do: "settings", expect: { agentWorkflowToolEnabled: true } }, ctx), /reading settings answered 503/)
})

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

const fieldContext = (values) => ({
  vars: {},
  vocabulary: { message: { selector: "textarea", means: "A draft message." } },
  page: {
    query: () => "document.querySelectorAll('textarea')",
    evaluate: async (expression) => {
      assert.match(expression, /\.value/)
      return values.length > 1 ? values.shift() : values[0]
    },
  },
})

test("field checks the current value and waits for a retained draft", async () => {
  await runStep({ do: "field", on: "message", equals: "Retained draft" }, fieldContext(["", "Retained draft"]))
  await runStep({ do: "field", on: "message", contains: "draft" }, fieldContext(["Retained draft"]))
})

test("field fails for a missing or mismatched input", async () => {
  await assert.rejects(
    runStep({ do: "field", on: "message", equals: "Retained draft", timeout: 0.001 }, fieldContext([null])),
    /no field at message/,
  )
  await assert.rejects(
    runStep({ do: "field", on: "message", equals: "Retained draft", timeout: 0.001 }, fieldContext(["Lost draft"])),
    /expected "Retained draft"/,
  )
})
