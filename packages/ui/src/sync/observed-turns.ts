import type { StoreApi } from "zustand"
import type { Part, SessionStatus } from "@/lib/opencode/model"
import type { DirectoryStore } from "./child-store"

/**
 * Turns this page watched run on the OpenCode server it is connected to.
 *
 * OpenCode keeps run state per process. A turn started by another OpenCode
 * process on the same database (the TUI, `opencode run`) never reaches this
 * server's event stream or its active-session snapshot, so a snapshot or a
 * message load sees it as an idle session with an unfinished answer, which is
 * exactly what a turn that died mid-way looks like (#4156). Only a run this
 * page saw busy or retrying may be judged interrupted from a snapshot or a
 * message load. A `session.idle`/`session.error` event needs no record: it
 * comes from the process that ran the turn.
 *
 * A record lasts until its run ends: a settle event from the server, or a
 * snapshot judged against loaded messages. A later turn from another process
 * in the same session must not inherit it. Records belong to one directory
 * store and disappear with it on a runtime switch.
 *
 * A turn nobody watched is still judged once its unfinished answer has been
 * silent for `UNWATCHED_TURN_SILENCE_MS`. A clean quit aborts the running turn
 * before the managed server stops, but a crash, a force quit or a power loss
 * leaves it unfinished in the database; the next launch then sees an unwatched
 * unfinished turn and would otherwise show it running forever. A turn another
 * process is really running keeps touching its parts within that window.
 */
const observedTurns = new WeakMap<StoreApi<DirectoryStore>, Set<string>>()

export function recordObservedTurn(
  store: StoreApi<DirectoryStore>,
  sessionID: string,
  status: SessionStatus | undefined,
): void {
  if (!status || status.type === "idle") return
  let sessions = observedTurns.get(store)
  if (!sessions) {
    sessions = new Set()
    observedTurns.set(store, sessions)
  }
  sessions.add(sessionID)
}

function hasObservedTurn(store: StoreApi<DirectoryStore>, sessionID: string): boolean {
  return observedTurns.get(store)?.has(sessionID) === true
}

/** Long enough for a tool run or a stretch of reasoning that writes no new part. */
export const UNWATCHED_TURN_SILENCE_MS = 15 * 60 * 1000

function partActivity(part: Part): number {
  if (part.type === "tool") {
    if (part.state.status === "pending") return 0
    if (part.state.status === "running") return part.state.time.start
    return part.state.time.end
  }
  if (part.type === "text" || part.type === "reasoning") return part.time?.end ?? part.time?.start ?? 0
  return 0
}

/**
 * Whether the session's trailing assistant message is unfinished and none of
 * its records changed within the silence window.
 */
export function isSilentUnwatchedTurn(
  state: Pick<DirectoryStore, "message" | "part">,
  sessionID: string,
  now = Date.now(),
): boolean {
  const messages = state.message[sessionID] ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") return false
    if (message.role !== "assistant") continue
    if (message.time.completed !== undefined) return false
    let last = message.time.created
    for (const part of state.part[message.id] ?? []) last = Math.max(last, partActivity(part))
    return now - last >= UNWATCHED_TURN_SILENCE_MS
  }
  return false
}

/** Snapshot and message-load judgments need a watched run or a long-silent one. */
export function mayJudgeTurn(
  store: StoreApi<DirectoryStore>,
  state: Pick<DirectoryStore, "message" | "part">,
  sessionID: string,
): boolean {
  return hasObservedTurn(store, sessionID) || isSilentUnwatchedTurn(state, sessionID)
}

/** A settle event ends the run on the server that ran it. */
export function forgetObservedTurn(store: StoreApi<DirectoryStore>, sessionID: string): void {
  observedTurns.get(store)?.delete(sessionID)
}

/** Forgets the run once a snapshot settled the session and its messages were judged. */
export function releaseJudgedTurn(
  store: StoreApi<DirectoryStore>,
  state: Pick<DirectoryStore, "session_status" | "message">,
  sessionID: string,
): void {
  if (state.session_status?.[sessionID]?.type !== "idle") return
  if (!state.message[sessionID]) return
  observedTurns.get(store)?.delete(sessionID)
}
