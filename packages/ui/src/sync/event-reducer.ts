import type { MessagePatch, SessionPatch, SyncEvent, ToolTransition } from "@/lib/opencode/events"
import {
  compact,
  isFinalToolStatus,
  type Message,
  type Part,
  type Session,
  type SessionStatus,
  type ToolPart,
} from "@/lib/opencode/model"
import { Binary } from "./binary"
import type { State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { syncDebug } from "./debug"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"
import {
  compareMessagesChronologically,
  findMessageIndex,
  insertMessageChronologically,
} from "./message-ordering"

type DedupeMetadata = {
  __dedupeNextDeltaFields?: string[]
}

function appendNonOverlappingDelta(existingValue: string | undefined, delta: string) {
  if (!existingValue || delta.length === 0) return (existingValue ?? "") + delta
  if (existingValue.endsWith(delta)) return existingValue

  const maxOverlap = Math.min(existingValue.length, delta.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existingValue.endsWith(delta.slice(0, overlap))) {
      return existingValue + delta.slice(overlap)
    }
  }

  return existingValue + delta
}

/**
 * A full text snapshot that extends or repeats the streamed text means the
 * next delta may overlap it; mark the field so the delta appends only what is
 * new.
 */
function getUpdatedDeltaFields(previous: Part, next: Part): string[] {
  if (previous.type !== next.type) return []
  if (next.type !== "text" && next.type !== "reasoning") return []
  if (previous.type !== "text" && previous.type !== "reasoning") return []
  const previousValue = previous.text
  const nextValue = next.text
  if (previousValue.length === 0 || nextValue.length === 0) return []
  if (nextValue === previousValue || nextValue.startsWith(previousValue) || previousValue.startsWith(nextValue)) {
    return ["text"]
  }
  return []
}

/**
 * A text or reasoning `ended` snapshot carries only its own timestamp as
 * `start`; the start streamed earlier is the real one and stays.
 */
function withStreamedStart(previous: Part, next: Part): Part {
  if (next.type !== "text" && next.type !== "reasoning") return next
  if (previous.type !== next.type || !previous.time || !next.time) return next
  if (next.time.end === undefined || previous.time.start >= next.time.start) return next
  return { ...next, time: { ...next.time, start: previous.time.start } }
}

function getPartEndTime(part: Part): number | undefined {
  if (part.type === "tool") {
    return part.state.status === "completed" || part.state.status === "error" ? part.state.time.end : undefined
  }
  if (part.type === "text" || part.type === "reasoning") return part.time?.end
  return undefined
}

function shouldPreserveExistingPart(previous: Part, next: Part): boolean {
  if (previous.type !== "tool" || next.type !== "tool") {
    return false
  }

  if (isFinalToolStatus(previous.state.status) && !isFinalToolStatus(next.state.status)) {
    return true
  }

  const previousEnd = getPartEndTime(previous)
  const nextEnd = getPartEndTime(next)
  if (previousEnd !== undefined && nextEnd === undefined) {
    return true
  }

  return false
}

function areSessionStatusesEqual(left: SessionStatus | undefined, right: SessionStatus): boolean {
  if (left === right) return true
  if (!left || left.type !== right.type) return false
  if (left.type === "retry") {
    return right.type === "retry"
      && left.attempt === right.attempt
      && left.message === right.message
      && left.next === right.next
  }
  return true
}

function areJsonEquivalent<T extends object>(left: T | undefined, right: T | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

export type GlobalEventResult = {
  type: "refresh"
} | {
  type: "catalog"
  kind: Extract<SyncEvent, { type: "catalog.updated" }>["properties"]["kind"]
} | null

export type SessionMaterializationReason =
  | "missing-owning-message"
  | "orphan-delta"
  | "missing-delta-part"
  | "empty-assistant-message"
  | "child-session-idle"
  | "child-session-discovered"
  | "ensure-session-messages"
  | "stream-reconnect"
  | "transport-switch"
  | "stale-status-resync"
  | "settled-running-tool"

export type DirectoryEventResult = boolean | {
  changed: boolean
  materialization: {
    type: "incomplete-session-snapshot"
    reason: SessionMaterializationReason
    sessionID?: string
    messageID: string
    partID?: string
  }
}

function hasMessage(draft: State, sessionID: string | undefined, messageID: string): boolean {
  if (!sessionID) return false
  const messages = draft.message[sessionID]
  if (!messages) return false
  return messages.some((message) => message.id === messageID)
}

/** Index of the compaction still running in a session (the newest one), or -1. */
const findRunningCompactionIndex = (messages: readonly Message[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "compaction") return message.status === "running" ? index : -1
  }
  return -1
}

export function reduceGlobalEvent(event: SyncEvent): GlobalEventResult {
  if (event.type === "server.connected") {
    return { type: "refresh" }
  }
  if (event.type === "catalog.updated") {
    return { type: "catalog", kind: event.properties.kind }
  }
  return null
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

function applySessionPatch(session: Session, patch: SessionPatch): Session {
  const next: Session = { ...session }
  if (patch.title !== undefined) next.title = patch.title
  if (patch.directory !== undefined) next.directory = patch.directory
  if (patch.projectID !== undefined) next.projectID = patch.projectID
  if (patch.subpath === null) delete next.subpath
  else if (patch.subpath !== undefined) next.subpath = patch.subpath
  if (patch.agent !== undefined) next.agent = patch.agent
  if (patch.model !== undefined) next.model = patch.model
  if (patch.cost !== undefined) next.cost = patch.cost
  if (patch.tokens !== undefined) next.tokens = patch.tokens
  if (patch.permissions !== undefined) next.permissions = patch.permissions
  if (patch.revert === null) delete next.revert
  else if (patch.revert !== undefined) next.revert = patch.revert
  if (patch.outcome !== undefined) next.outcome = patch.outcome
  if (patch.metadata !== undefined) next.metadata = patch.metadata
  if (patch.time) {
    const { archived, ...rest } = patch.time
    next.time = compact({ ...session.time, ...rest, archived: archived === null ? undefined : (archived ?? session.time.archived) })
  }
  return next
}

function applyMessagePatch(message: Message, patch: MessagePatch): Message {
  if (message.role === "assistant") {
    const next = { ...message }
    if (patch.time) next.time = compact({ ...message.time, ...patch.time })
    if (patch.finish !== undefined) next.finish = patch.finish
    if (patch.error !== undefined) next.error = patch.error
    // A completion the server reports supersedes the local interruption mark
    // (`interruptedTurnToolParts`); a turn that really failed arrives with its
    // own error in the same patch.
    else if (patch.time?.completed !== undefined && message.error?.type === "aborted") delete next.error
    if (patch.cost !== undefined) next.cost = patch.cost
    if (patch.tokens !== undefined) next.tokens = patch.tokens
    if (patch.snapshot) next.snapshot = compact({ ...message.snapshot, ...patch.snapshot })
    if (patch.retry === null) delete next.retry
    else if (patch.retry !== undefined) next.retry = patch.retry
    return next
  }
  if (message.role === "shell") {
    const next = { ...message }
    if (patch.time?.completed !== undefined) next.time = { ...message.time, completed: patch.time.completed }
    if (patch.shell) {
      next.status = patch.shell.status
      if (patch.shell.exit !== undefined) next.exit = patch.shell.exit
      if (patch.shell.signal !== undefined) next.signal = patch.shell.signal
      if (patch.shell.output !== undefined) next.output = patch.shell.output
    }
    return next
  }
  if (patch.time?.created !== undefined) {
    return { ...message, time: { ...message.time, created: patch.time.created } }
  }
  return message
}

function applyToolTransition(part: ToolPart, transition: ToolTransition): ToolPart {
  const state = part.state
  switch (transition.kind) {
    case "input":
      if (state.status !== "pending") return part
      return { ...part, state: { ...state, raw: transition.raw } }
    case "called":
      if (isFinalToolStatus(state.status)) return part
      return {
        ...part,
        executed: transition.executed,
        state: { status: "running", input: transition.input, time: { start: transition.start } },
      }
    case "progress":
      if (state.status !== "running") return part
      return { ...part, state: { ...state, metadata: transition.metadata } }
    case "success": {
      if (isFinalToolStatus(state.status)) return part
      const start = state.status === "running" ? state.time.start : transition.end
      const attachments = transition.attachments
      return {
        ...part,
        executed: transition.executed,
        state: compact({
          status: "completed",
          input: state.input,
          output: transition.output,
          metadata: transition.metadata ?? (state.status === "running" ? state.metadata : undefined),
          time: { start, end: transition.end },
          attachments,
        }),
      }
    }
    case "failed": {
      if (isFinalToolStatus(state.status)) return part
      const start = state.status === "running" ? state.time.start : transition.end
      return {
        ...part,
        executed: transition.executed,
        state: compact({
          status: "error",
          input: state.input,
          error: transition.error,
          output: transition.output,
          metadata: transition.metadata ?? (state.status === "running" ? state.metadata : undefined),
          time: { start, end: transition.end },
        }),
      }
    }
  }
}

function findShellMessageIndex(messages: readonly Message[], shellID: string): number {
  return messages.findIndex((message) => message.role === "shell" && message.shellID === shellID)
}

// ---------------------------------------------------------------------------
// Directory events — mutates draft in place for batching efficiency.
// Caller MUST pass a mutable copy of State (e.g. structuredClone or spread).
// ---------------------------------------------------------------------------

export function applyDirectoryEvent(
  draft: State,
  event: SyncEvent,
  callbacks?: {
    onRefresh?: (directory: string) => void
    onLoadMcp?: () => void
    onCatalogUpdated?: (kind: Extract<SyncEvent, { type: "catalog.updated" }>["properties"]["kind"]) => void
  },
): DirectoryEventResult {
  const markSessionEvent = (sessionID: string, deleted: boolean) => {
    const revision = (draft.sessionRevision ?? 0) + 1
    draft.sessionRevision = revision
    draft.sessionListSource = "live"
    draft.sessionEventRevision = draft.sessionEventRevision ?? {}
    draft.sessionDeletedRevision = draft.sessionDeletedRevision ?? {}
    if (deleted) {
      draft.sessionDeletedRevision[sessionID] = revision
      delete draft.sessionEventRevision[sessionID]
    } else {
      draft.sessionEventRevision[sessionID] = revision
      delete draft.sessionDeletedRevision[sessionID]
    }
  }

  switch (event.type) {
    case "server.connected": {
      callbacks?.onRefresh?.("")
      return false
    }

    case "session.created": {
      const info = event.properties.info
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found && shouldSkipStaleSessionEvent(sessions[result.index], info)) {
        return false
      }
      if (result.found) {
        // A create echo for a session we already hold (optimistic create, or
        // a replayed event) must not erase title/usage learned since.
        sessions[result.index] = { ...info, ...sessions[result.index] }
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
        if (!info.parentID) draft.sessionTotal += 1
      }
      markSessionEvent(info.id, false)
      return true
    }

    case "session.patched": {
      const { sessionID, patch } = event.properties
      const sessions = draft.session
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      if (!result.found) return false
      const next = applySessionPatch(sessions[result.index], patch)
      if (shouldSkipStaleSessionEvent(sessions[result.index], next)) return false

      // Archiving removes the session from the live list; its caches go too.
      if (next.time.archived && !sessions[result.index].time.archived) {
        sessions.splice(result.index, 1)
        cleanupSessionCaches(draft, sessionID)
        draft.sessionStatusInvalidated = { ...draft.sessionStatusInvalidated, [sessionID]: true }
        if (!next.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
        markSessionEvent(sessionID, true)
        return true
      }

      if (areJsonEquivalent(sessions[result.index], next)) return false
      sessions[result.index] = next
      markSessionEvent(sessionID, false)
      return true
    }

    case "session.revert.committed": {
      // OpenCode deleted the boundary message and everything after it without
      // per-message removals, so the same range goes here. The loaded window
      // is always the transcript's tail: a boundary the window does not hold
      // is older than everything loaded, so a matching marker trims it all.
      const { sessionID, to } = event.properties
      const sessions = draft.session
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      const session = result.found ? sessions[result.index] : undefined
      const messages = draft.message[sessionID]
      let changed = false
      if (messages && messages.length > 0) {
        const index = findMessageIndex(messages, to)
        const from = index >= 0 ? index : session?.revert?.messageID === to ? 0 : -1
        if (from >= 0) {
          for (const removed of messages.slice(from)) delete draft.part[removed.id]
          draft.message[sessionID] = messages.slice(0, from)
          changed = true
        }
      }
      if (session?.revert) {
        const rest = { ...session }
        delete rest.revert
        sessions[result.index] = rest
        markSessionEvent(sessionID, false)
        changed = true
      }
      return changed
    }

    case "session.deleted": {
      const sessions = draft.session
      const { sessionID } = event.properties
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      const info = result.found ? sessions[result.index] : undefined
      if (result.found) sessions.splice(result.index, 1)
      cleanupSessionCaches(draft, sessionID)
      if (draft.sessionStatusInvalidated?.[sessionID]) {
        draft.sessionStatusInvalidated = { ...draft.sessionStatusInvalidated }
        delete draft.sessionStatusInvalidated[sessionID]
      }
      if (!info?.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
      markSessionEvent(sessionID, true)
      return true
    }

    case "session.status": {
      const { sessionID, status } = event.properties
      const wasInvalidated = draft.sessionStatusInvalidated?.[sessionID] === true
      if (wasInvalidated) {
        draft.sessionStatusInvalidated = { ...draft.sessionStatusInvalidated }
        delete draft.sessionStatusInvalidated[sessionID]
      }
      if (areSessionStatusesEqual(draft.session_status[sessionID], status)) {
        return wasInvalidated
      }
      draft.session_status[sessionID] = status
      return true
    }

    case "session.idle":
    case "session.error": {
      // An error ends the turn; it is not a lasting status.
      const { sessionID } = event.properties
      const status = { type: "idle" } as const
      const wasInvalidated = draft.sessionStatusInvalidated?.[sessionID] === true
      if (wasInvalidated) {
        draft.sessionStatusInvalidated = { ...draft.sessionStatusInvalidated }
        delete draft.sessionStatusInvalidated[sessionID]
      }
      if (areSessionStatusesEqual(draft.session_status[sessionID], status)) {
        return wasInvalidated
      }
      draft.session_status[sessionID] = status
      return true
    }

    case "message.updated": {
      let info = event.properties.info
      const messages = draft.message[info.sessionID]
      if (!messages) {
        draft.message[info.sessionID] = [info]
        return true
      }
      // A compaction settles the record that has been running, the way
      // OpenCode's own message store does: `session.compaction.ended` carries
      // no input id, so the settled record keeps the running one's identity.
      const runningCompaction = info.role === "compaction" && info.status !== "running"
        ? findRunningCompactionIndex(messages)
        : -1
      if (runningCompaction >= 0) {
        const running = messages[runningCompaction]
        info = { ...info, id: running.id, time: { ...running.time } }
      }
      const messageIndex = findMessageIndex(messages, info.id)
      if (messageIndex >= 0) {
        // Skip message replacement if unchanged — preserves reference, avoids re-render
        const existing = messages[messageIndex]
        if (areJsonEquivalent(existing, info)) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionID, info.id, info.role, undefined, undefined)
          return false
        }
        const next = [...messages]
        if (compareMessagesChronologically(existing, info) === 0) {
          next[messageIndex] = info
        } else {
          next.splice(messageIndex, 1)
          insertMessageChronologically(next, info)
        }
        draft.message[info.sessionID] = next
      } else {
        const next = [...messages]
        insertMessageChronologically(next, info)
        draft.message[info.sessionID] = next
      }
      return true
    }

    case "message.patched": {
      const { sessionID, messageID, patch } = event.properties
      const messages = draft.message[sessionID]
      if (!messages) {
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID },
        }
      }
      const shellID = messageID.startsWith("shell:") ? messageID.slice("shell:".length) : undefined
      const messageIndex = shellID ? findShellMessageIndex(messages, shellID) : findMessageIndex(messages, messageID)
      if (messageIndex < 0) {
        if (shellID) return false
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID },
        }
      }
      const existing = messages[messageIndex]
      const updated = applyMessagePatch(existing, patch)
      if (updated === existing || areJsonEquivalent(existing, updated)) return false
      const next = [...messages]
      if (compareMessagesChronologically(existing, updated) === 0) {
        next[messageIndex] = updated
      } else {
        next.splice(messageIndex, 1)
        insertMessageChronologically(next, updated)
      }
      draft.message[sessionID] = next
      return true
    }

    case "message.compaction.delta": {
      const { sessionID, delta } = event.properties
      const messages = draft.message[sessionID]
      if (!messages || !delta) return false
      const index = findRunningCompactionIndex(messages)
      if (index < 0) return false
      const running = messages[index]
      if (running.role !== "compaction") return false
      const next = [...messages]
      next[index] = { ...running, summary: running.summary + delta }
      draft.message[sessionID] = next
      return true
    }

    case "message.removed": {
      const { sessionID, messageID } = event.properties
      const messages = draft.message[sessionID]
      if (messages) {
        const next = [...messages]
        const messageIndex = findMessageIndex(next, messageID)
        if (messageIndex >= 0) {
          next.splice(messageIndex, 1)
          draft.message[sessionID] = next
        }
      }
      delete draft.part[messageID]
      return true
    }

    case "message.part.updated": {
      const { sessionID, part } = event.properties
      const messageID = part.messageID
      const missingOwningMessage = !hasMessage(draft, sessionID, messageID)
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partUpdatedNoExistingParts(messageID, part.id, part.type)
        draft.part[messageID] = [part]
        return missingOwningMessage
          ? {
            changed: true,
            materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
          }
          : true
      }
      const next = [...parts]
      const partIndex = next.findIndex((candidate) => candidate.id === part.id)
      if (partIndex >= 0) {
        const previous = next[partIndex]
        if (shouldPreserveExistingPart(previous, part)) {
          return false
        }
        const dedupeFields = getUpdatedDeltaFields(previous, part)
        const settled = withStreamedStart(previous, part)
        // SAFETY: the dedupe marker is a private annotation the delta reducer
        // strips again; the part itself is unchanged.
        next[partIndex] = dedupeFields.length > 0
          ? ({ ...settled, __dedupeNextDeltaFields: dedupeFields } as Part & DedupeMetadata)
          : settled
      } else {
        next.push(part)
      }
      draft.part[messageID] = next
      return missingOwningMessage
        ? {
          changed: true,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
        }
        : true
    }

    case "message.parts.replaced": {
      const { sessionID, messageID, parts } = event.properties
      const missingOwningMessage = !hasMessage(draft, sessionID, messageID)
      const existing = draft.part[messageID]
      if (existing && areJsonEquivalent(existing, parts)) return false
      draft.part[messageID] = parts
      return missingOwningMessage
        ? {
          changed: true,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID },
        }
        : true
    }

    case "message.part.delta": {
      const { sessionID, messageID, partID, field, delta } = event.properties
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partDeltaNoParts(messageID, partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID, messageID, partID },
        }
      }
      const partIndex = parts.findIndex((part) => part.id === partID)
      if (partIndex < 0) {
        syncDebug.reducer.partDeltaNotFound(messageID, partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", sessionID, messageID, partID },
        }
      }
      const existing = parts[partIndex]
      const next = [...parts]
      if (field === "raw") {
        if (existing.type !== "tool" || existing.state.status !== "pending") return false
        next[partIndex] = { ...existing, state: { ...existing.state, raw: existing.state.raw + delta } }
        draft.part[messageID] = next
        return true
      }
      if (existing.type !== "text" && existing.type !== "reasoning") return false
      // SAFETY: the marker is only ever set by the snapshot branch above.
      const dedupeFields = (existing as DedupeMetadata).__dedupeNextDeltaFields ?? []
      const shouldDedupe = dedupeFields.includes(field)
      // Create new Part object + new array so React detects the change
      // SAFETY: same private marker as above on an otherwise unchanged part.
      next[partIndex] = {
        ...existing,
        text: shouldDedupe ? appendNonOverlappingDelta(existing.text, delta) : existing.text + delta,
        __dedupeNextDeltaFields: dedupeFields.filter((candidate) => candidate !== field),
      } as Part & DedupeMetadata
      draft.part[messageID] = next
      return true
    }

    case "message.tool.transition": {
      const { sessionID, messageID, partID, transition } = event.properties
      const parts = draft.part[messageID]
      if (!parts) {
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID, messageID, partID },
        }
      }
      const partIndex = parts.findIndex((part) => part.id === partID)
      const existing = partIndex >= 0 ? parts[partIndex] : undefined
      if (!existing || existing.type !== "tool") {
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", sessionID, messageID, partID },
        }
      }
      const updated = applyToolTransition(existing, transition)
      if (updated === existing) return false
      const next = [...parts]
      next[partIndex] = updated
      draft.part[messageID] = next
      return true
    }

    case "vcs.branch.updated": {
      const { branch } = event.properties
      if (draft.vcs?.branch === branch) return false
      draft.vcs = compact({ ...draft.vcs, branch })
      return true
    }

    case "permission.asked": {
      const permission = event.properties
      const permissions = draft.permission[permission.sessionID] ?? []
      const next = [...permissions]
      const result = Binary.search(next, permission.id, (p) => p.id)
      if (result.found) {
        next[result.index] = permission
      } else {
        next.splice(result.index, 0, permission)
      }
      draft.permission[permission.sessionID] = next
      return true
    }

    case "permission.replied": {
      const { sessionID, requestID } = event.properties
      const permissions = draft.permission[sessionID]
      if (!permissions) return false
      const result = Binary.search(permissions, requestID, (p) => p.id)
      if (result.found) {
        const next = [...permissions]
        next.splice(result.index, 1)
        draft.permission[sessionID] = next
        return true
      }
      return false
    }

    case "form.created": {
      const form = event.properties.form
      const forms = draft.form[form.sessionID] ?? []
      const next = [...forms]
      const result = Binary.search(next, form.id, (f) => f.id)
      if (result.found) {
        next[result.index] = form
      } else {
        next.splice(result.index, 0, form)
      }
      draft.form[form.sessionID] = next
      return true
    }

    case "form.settled": {
      const { sessionID, formID } = event.properties
      const forms = draft.form[sessionID]
      if (!forms) return false
      const result = Binary.search(forms, formID, (f) => f.id)
      if (result.found) {
        const next = [...forms]
        next.splice(result.index, 1)
        draft.form[sessionID] = next
        return true
      }
      return false
    }

    case "mcp.status.changed": {
      callbacks?.onLoadMcp?.()
      return false
    }

    case "catalog.updated": {
      callbacks?.onCatalogUpdated?.(event.properties.kind)
      return false
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimSessions(draft: State) {
  if (draft.session.length <= draft.limit) return
  // Keep sessions that have pending permissions (they need to stay visible)
  const hasPermission = new Set(
    Object.entries(draft.permission ?? {})
      .filter(([, perms]) => perms && perms.length > 0)
      .map(([sessionID]) => sessionID),
  )
  while (draft.session.length > draft.limit) {
    // Remove from the beginning (oldest by sorted ID)
    const candidate = draft.session[0]
    if (hasPermission.has(candidate.id)) break
    draft.session.shift()
  }
}

function cleanupSessionCaches(draft: State, sessionID: string) {
  if (!sessionID) return
  dropSessionCaches(draft, [sessionID])
}
