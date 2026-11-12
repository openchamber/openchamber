/**
 * The session id OpenCode gives a form no session owns: an MCP elicitation is
 * raised by a server of the whole location (directory), not by a turn. See
 * `GLOBAL_ELICITATION_SESSION_ID` in OpenCode's `packages/core/src/mcp/index.ts`.
 * Replies go to `/session/global/form/:id`, so the sentinel is kept as-is.
 */
export const LOCATION_SCOPED_FORM_SESSION_ID = "global"
