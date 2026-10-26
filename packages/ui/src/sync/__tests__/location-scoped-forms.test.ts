import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, SessionStatus } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { LOCATION_SCOPED_FORM_SESSION_ID, routeUnlocatedLocationScopedForm, type DirectoryFormState } from "../location-scoped-forms"

// OpenCode publishes MCP elicitation forms with no location, so these events
// name neither a session nor a directory.

const elicitation = (id: string): FormRequest => ({
  id,
  sessionID: LOCATION_SCOPED_FORM_SESSION_ID,
  title: "azure-devops is requesting input",
  fields: [{ key: "project", type: "string" }],
})

const created = (id: string): SyncEvent => ({ type: "form.created", properties: { form: elicitation(id) } })
const settled = (id: string): SyncEvent => ({
  type: "form.settled",
  properties: { sessionID: LOCATION_SCOPED_FORM_SESSION_ID, formID: id },
})

const directoryState = (
  forms: FormRequest[],
  statuses: Record<string, SessionStatus> = {},
): DirectoryFormState => ({
  form: forms.length > 0 ? { [LOCATION_SCOPED_FORM_SESSION_ID]: forms } : {},
  session_status: statuses,
})

describe("unlocated location-scoped form events", () => {
  const record = () => {
    const redirected: string[] = []
    const resynced: string[] = []
    return {
      redirected,
      resynced,
      redirect: (directory: string) => redirected.push(directory),
      resync: (directory: string) => resynced.push(directory),
    }
  }

  test("an event with a directory, or for a session, is left to normal routing", () => {
    const calls = record()
    const routing = { stores: [["/a", directoryState([elicitation("frm_a")], { ses_a: { type: "busy" } })] as const], activeDirectory: "/a", ...calls }

    expect(routeUnlocatedLocationScopedForm("/a", created("frm_a"), routing)).toBe(false)
    expect(routeUnlocatedLocationScopedForm("/a", settled("frm_a"), routing)).toBe(false)
    expect(routeUnlocatedLocationScopedForm("global", {
      type: "form.settled",
      properties: { sessionID: "ses_a", formID: "frm_a" },
    }, routing)).toBe(false)
    expect(calls.redirected).toEqual([])
    expect(calls.resynced).toEqual([])
  })

  test("a settled form is removed from every store that holds it", () => {
    const calls = record()

    const handled = routeUnlocatedLocationScopedForm("global", settled("frm_a"), {
      stores: [
        ["/a", directoryState([elicitation("frm_a")])],
        ["/b", directoryState([elicitation("frm_b")])],
        ["/c", directoryState([])],
      ],
      activeDirectory: "/c",
      ...calls,
    })

    expect(handled).toBe(true)
    expect(calls.redirected).toEqual(["/a"])
    expect(calls.resynced).toEqual([])
  })

  test("a created form re-reads the active directory and directories with a running turn", () => {
    const calls = record()

    const handled = routeUnlocatedLocationScopedForm("", created("frm_a"), {
      stores: [
        ["/busy", directoryState([], { ses_a: { type: "busy" } })],
        ["/idle", directoryState([], { ses_b: { type: "idle" } })],
        ["/active", directoryState([])],
      ],
      activeDirectory: "/active",
      ...calls,
    })

    expect(handled).toBe(true)
    expect(calls.resynced).toEqual(["/busy", "/active"])
    expect(calls.redirected).toEqual([])
  })
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

    handleEvent("global", settled("frm_a"), childStores, createEventRoutingIndex(), getRuntimeKey())

    expect(storeA.getState().form[LOCATION_SCOPED_FORM_SESSION_ID]).toEqual([])
    expect(storeB.getState().form[LOCATION_SCOPED_FORM_SESSION_ID]).toEqual([elicitation("frm_b")])
  })
})
