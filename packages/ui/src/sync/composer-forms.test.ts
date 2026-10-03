import { describe, expect, test } from "bun:test"
import type { FormRequest, Session } from "@/lib/opencode/model"

import { LOCATION_SCOPED_FORM_SESSION_ID, collectComposerForms } from "./sync-context"

// SAFETY: subtree scoping reads only `id` and `parentID`; the other session fields are never touched here.
const session = (id: string, parentID?: string): Session => ({ id, parentID }) as Session
const form = (id: string, sessionID: string): FormRequest => ({ id, sessionID, title: id, fields: [{ key: "answer", type: "boolean" }] })

describe("composer forms", () => {
  const empty: FormRequest[] = []
  const own = form("form_own", "ses_root")
  const child = form("form_child", "ses_child")
  const elicitation = form("form_mcp", LOCATION_SCOPED_FORM_SESSION_ID)
  const sessions = [session("ses_root"), session("ses_child", "ses_root"), session("ses_other")]

  test("a location-scoped form follows the session subtree's own forms", () => {
    const result = collectComposerForms(
      sessions,
      { ses_root: [own], ses_child: [child], [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation] },
      "ses_root",
      empty,
    )
    expect(result).toEqual([own, child, elicitation])
  })

  test("a location-scoped form reaches a session with no forms of its own", () => {
    const result = collectComposerForms(sessions, { [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation] }, "ses_other", empty)
    expect(result).toEqual([elicitation])
  })

  test("without a session there is nothing to show it from", () => {
    expect(collectComposerForms(sessions, { [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation] }, null, empty)).toBe(empty)
  })

  test("the shared empty list survives when neither kind is pending", () => {
    expect(collectComposerForms(sessions, { [LOCATION_SCOPED_FORM_SESSION_ID]: [] }, "ses_root", empty)).toBe(empty)
  })
})
