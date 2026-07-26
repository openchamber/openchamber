import { expect, mock, test } from "bun:test"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

const { assertProviderCircuitClosed, recordProviderError, recordProviderSuccess } = await import("./provider-tracker")

test("isolates provider circuit state by runtime", () => {
  for (let attempt = 0; attempt < 3; attempt += 1) recordProviderError("provider", 503)
  expect(() => assertProviderCircuitClosed("provider")).toThrow()

  runtimeKey = "runtime-b"
  assertProviderCircuitClosed("provider")

  runtimeKey = "runtime-a"
  recordProviderSuccess("provider")
  assertProviderCircuitClosed("provider")
})
