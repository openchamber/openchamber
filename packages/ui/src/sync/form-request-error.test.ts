import { describe, expect, test } from "bun:test"
import { isFormRequestNotFoundError } from "./form-request-error"

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
