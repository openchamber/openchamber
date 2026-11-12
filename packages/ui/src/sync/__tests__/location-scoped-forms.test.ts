import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "../location-scoped-forms"

// An MCP elicitation form names no session, only the location that asked it.

const elicitation = (id: string): FormRequest => ({
  id,
  sessionID: LOCATION_SCOPED_FORM_SESSION_ID,
  title: "azure-devops is requesting input",
  fields: [{ key: "project", type: "string" }],
})

const settled = (id: string): SyncEvent => ({
  type: "form.settled",
  properties: { sessionID: LOCATION_SCOPED_FORM_SESSION_ID, formID: id },
})

describe("a cancelled elicitation with several directories open", () => {
  let childStores: ChildStoreManager
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame

  beforeEach(() => {
    // Settling a form dismisses its toast, and the toast library schedules that on a frame.
    globalThis.requestAnimationFrame = (callback) => {
      queueMicrotask(() => callback(0))
      return 0
    }
    childStores = new ChildStoreManager()
    childStores.ensureChild("/a", { bootstrap: false })
    childStores.ensureChild("/b", { bootstrap: false })
  })

  afterEach(() => {
    childStores.disposeAll()
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
  })

  test("leaves the store that held it", () => {
    const storeA = childStores.getChild("/a")
    const storeB = childStores.getChild("/b")
    if (!storeA || !storeB) throw new Error("expected both directory stores")
    storeA.setState({ form: { [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation("frm_a")] } })
    storeB.setState({ form: { [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation("frm_b")] } })

    handleEvent("/a", settled("frm_a"), childStores, createEventRoutingIndex(), getRuntimeKey())

    expect(storeA.getState().form[LOCATION_SCOPED_FORM_SESSION_ID]).toEqual([])
    expect(storeB.getState().form[LOCATION_SCOPED_FORM_SESSION_ID]).toEqual([elicitation("frm_b")])
  })
})
