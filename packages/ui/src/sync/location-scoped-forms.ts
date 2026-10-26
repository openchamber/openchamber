import type { SyncEvent } from "@/lib/opencode/events"
import type { State } from "./types"

/**
 * The session id OpenCode gives a form no session owns: an MCP elicitation is
 * raised by a server of the whole location (directory), not by a turn. See
 * `GLOBAL_ELICITATION_SESSION_ID` in OpenCode's `packages/core/src/mcp/index.ts`.
 * Replies go to `/session/global/form/:id`, so the sentinel is kept as-is.
 */
export const LOCATION_SCOPED_FORM_SESSION_ID = "global"

/** What routing reads from a directory store. */
export type DirectoryFormState = Pick<State, "form" | "session_status">

type UnlocatedFormRouting = {
  stores: Iterable<readonly [directory: string, state: DirectoryFormState]>
  /** The directory the user is working in; its location is running. */
  activeDirectory: string | null | undefined
  /** Handle the event as if it carried this directory. */
  redirect: (directory: string) => void
  /** Re-read the directory's pending location-scoped forms from OpenCode. */
  resync: (directory: string) => void
}

const hasRunningTurn = (state: DirectoryFormState): boolean => (
  Object.values(state.session_status).some((status) => status.type === "busy" || status.type === "retry")
)

/**
 * Routes a location-scoped form event that names no directory, and reports
 * whether the event was one. OpenCode 2.0.27 publishes MCP elicitation forms,
 * both `form.created` and `form.cancelled`, without a location: the MCP
 * callback runs outside the location's services. Routed like any other
 * directory-less event it is dropped, which leaves a cancelled form in the
 * store for good. OpenCode 2.1.4 publishes them with their location, so this
 * routing goes once `MINIMUM_OPENCODE_VERSION` reaches 2.1.4.
 *
 * A settled form goes to every store that holds it: form ids are unique, so
 * removing it by id is right wherever it is. A created form cannot be filed
 * by guessing, because a reply sent to the wrong directory is refused as "form
 * not found" while the form keeps waiting where it was asked. The stores whose
 * directory may have asked it re-read their pending forms instead: an MCP
 * server asks while one of its tools runs, so that directory has a running
 * turn, and the active directory is read as well. Both locations are already
 * running, so the read starts no MCP servers.
 */
export const routeUnlocatedLocationScopedForm = (
  directory: string,
  payload: SyncEvent,
  routing: UnlocatedFormRouting,
): boolean => {
  if (directory && directory !== "global") return false

  if (payload.type === "form.settled") {
    const { sessionID, formID } = payload.properties
    if (sessionID !== LOCATION_SCOPED_FORM_SESSION_ID) return false
    for (const [storeDirectory, state] of routing.stores) {
      if (state.form[LOCATION_SCOPED_FORM_SESSION_ID]?.some((form) => form.id === formID)) routing.redirect(storeDirectory)
    }
    return true
  }

  if (payload.type === "form.created") {
    if (payload.properties.form.sessionID !== LOCATION_SCOPED_FORM_SESSION_ID) return false
    for (const [storeDirectory, state] of routing.stores) {
      if (storeDirectory === routing.activeDirectory || hasRunningTurn(state)) routing.resync(storeDirectory)
    }
    return true
  }

  return false
}
