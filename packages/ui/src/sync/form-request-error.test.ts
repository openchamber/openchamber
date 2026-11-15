import { describe, expect, test } from "bun:test"
import { AgentUnavailableError } from "@/lib/opencode/agent-unavailable-error"
import { normalizeOpencodeError } from "@/lib/opencode/client"
import { agentUnavailableFrom, isFormAlreadySettledError, isFormRequestNotFoundError } from "./form-request-error"

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

describe("isFormAlreadySettledError", () => {
  // The bodies OpenCode 2.3.0 returns with HTTP 409 (protocol/src/errors.ts), as the client turns them into errors.
  test("matches the already-settled tag and no other 409", () => {
    const settled = normalizeOpencodeError("session.form.cancel", { _tag: "FormAlreadySettledError", id: "frm_1", message: "Form already settled: frm_1" })
    expect(settled.status).toBe(409)
    expect(isFormAlreadySettledError(settled)).toBe(true)
    expect(isFormAlreadySettledError(normalizeOpencodeError("session.form.cancel", { _tag: "SessionBusyError", message: "busy" }))).toBe(false)
    expect(isFormAlreadySettledError(Object.assign(new Error("conflict"), { status: 409 }))).toBe(false)
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
