import { describe, expect, test } from "bun:test"
import { AgentUnavailableError } from "@/lib/opencode/client"
import { agentUnavailableFrom, isFormRequestNotFoundError } from "./form-request-error"

describe("isFormRequestNotFoundError", () => {
  test("matches a 404 from form.reply, including a status-only error", () => {
    expect(isFormRequestNotFoundError(Object.assign(new Error("form.reply failed (404): FormNotFoundError"), { status: 404 }))).toBe(true)
    expect(isFormRequestNotFoundError({ status: 404 })).toBe(true)
    expect(isFormRequestNotFoundError("Form request not found")).toBe(true)
  })

  test("does not match a real submit failure", () => {
    expect(isFormRequestNotFoundError(new Error("Form reply failed"))).toBe(false)
    expect(isFormRequestNotFoundError(Object.assign(new Error("unavailable"), { status: 500 }))).toBe(false)
    expect(isFormRequestNotFoundError(null)).toBe(false)
  })
})

describe("agentUnavailableFrom", () => {
  test("names the unavailable agent behind a failed form reply", () => {
    expect(agentUnavailableFrom(new AgentUnavailableError("build", "/test/project"))).toBe("build")
    expect(agentUnavailableFrom(new AgentUnavailableError("codex", undefined))).toBe("codex")
  })

  test("names an unavailable agent wrapped as the error's cause", () => {
    expect(agentUnavailableFrom(new Error("selection.apply failed", { cause: new AgentUnavailableError("build", undefined) }))).toBe("build")
  })

  test("returns null for failures that name no agent", () => {
    expect(agentUnavailableFrom(new Error("plain failure"))).toBe(null)
    expect(agentUnavailableFrom(new Error("boom"))).toBe(null)
    expect(agentUnavailableFrom(null)).toBe(null)
  })
})
