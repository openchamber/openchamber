import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import type { FileDiff, GlobalState, State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { stripSessionDiffSnapshots } from "./sanitize"
import { syncDebug } from "./debug"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const DELTA_OVERLAP_FIELDS = ["text", "output"] as const
const FINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "failed", "timeout", "cancelled"])

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

function getUpdatedDeltaFields(previous: Part, next: Part) {
  const dedupeFields: string[] = []
  for (const field of DELTA_OVERLAP_FIELDS) {
    const previousValue = (previous as Record<string, unknown>)[field]
    const nextValue = (next as Record<string, unknown>)[field]
    if (typeof previousValue !== "string" || typeof nextValue !== "string") continue
    if (previousValue.length === 0 || nextValue.length === 0) continue
    if (nextValue === previousValue || nextValue.startsWith(previousValue) || previousValue.startsWith(nextValue)) {
      dedupeFields.push(field)
    }
  }
  return dedupeFields
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getToolStatus(part: Part): string | undefined {
  if (part.type !== "tool") {
    return undefined
  }

  const status = (part as { state?: { status?: unknown } }).state?.status
  return typeof status === "string" ? status : undefined
}

function shouldPreserveExistingPart(previous: Part, next: Part): boolean {
  if (previous.type !== "tool" || next.type !== "tool") {
    return false
  }

  const previousStatus = getToolStatus(previous)
  const nextStatus = getToolStatus(next)
  if (previousStatus && FINAL_TOOL_STATUSES.has(previousStatus) && (!nextStatus || !FINAL_TOOL_STATUSES.has(nextStatus))) {
    return true
  }

  const previousEnd = getPartEndTime(previous)
  const nextEnd = getPartEndTime(next)
  if (typeof previousEnd === "number" && typeof nextEnd !== "number") {
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

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

export type GlobalEventResult = {
  type: "refresh"
} | {
  type: "project"
  project: Project
} | null

export type DirectoryEventResult = boolean | {
  changed: boolean
  materialization: {
    type: "incomplete-session-snapshot"
    sessionID?: string
    messageID: string
    partID?: string
  }
}

function hasMessage(draft: State, sessionID: string | undefined, messageID: string): boolean {
  if (!sessionID) return false
  const messages = draft.message[sessionID]
  if (!messages) return false
  return Binary.search(messages, messageID, (message) => message.id).found
}

export function reduceGlobalEvent(event: Event): GlobalEventResult {
  if (event.type === "global.disposed" || event.type === "server.connected") {
    return { type: "refresh" }
  }
  if (event.type === "project.updated") {
    return { type: "project", project: event.properties as Project }
  }
  return null
}

export function applyGlobalProject(state: GlobalState, project: Project): GlobalState {
  const projects = [...state.projects]
  const result = Binary.search(projects, project.id, (s) => s.id)
  if (result.found) {
    projects[result.index] = { ...projects[result.index], ...project }
  } else {
    projects.splice(result.index, 0, project)
  }
  return { ...state, projects }
}

// ---------------------------------------------------------------------------
// Directory events — mutates draft in place for batching efficiency.
// Caller MUST pass a mutable copy of State (e.g. structuredClone or spread).
// ---------------------------------------------------------------------------

export function applyDirectoryEvent(
  draft: State,
  event: Event,
  callbacks?: {
    onRefresh?: (directory: string) => void
    onLoadLsp?: () => void
    onSetSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  },
): DirectoryEventResult {
  switch (event.type) {
    case "server.instance.disposed": {
      callbacks?.onRefresh?.("")
      return false
    }

    case "session.created": {
      const info = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
        if (!info.parentID) draft.sessionTotal += 1
      }
      return true
    }

    case "session.updated": {
      const info = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)

      if (info.time.archived) {
        if (result.found) sessions.splice(result.index, 1)
        cleanupSessionCaches(draft, info.id, callbacks?.onSetSessionTodo)
        if (!info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
        return true
      }

      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
      }
      return true
    }

    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found) sessions.splice(result.index, 1)
      cleanupSessionCaches(draft, info.id, callbacks?.onSetSessionTodo)
      if (!info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
      return true
    }

    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: FileDiff[] }
      draft.session_diff[props.sessionID] = props.diff
      return true
    }

    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      draft.todo[props.sessionID] = props.todos
      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)
      return true
    }

    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], props.status)) {
        return false
      }
      draft.session_status[props.sessionID] = props.status
      return true
    }

    case "session.idle": {
      const props = event.properties as { sessionID: string }
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.error": {
      const props = event.properties as { sessionID: string }
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      const messages = draft.message[info.sessionID]
      if (!messages) {
        draft.message[info.sessionID] = [info]
        return true
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        // Skip message replacement if unchanged — preserves reference, avoids re-render
        const existing = messages[result.index]
        const unchanged = existing.role === info.role
          && (existing as { finish?: unknown }).finish === (info as { finish?: unknown }).finish
          && (existing.time as { completed?: number })?.completed === (info.time as { completed?: number })?.completed
        if (unchanged) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionID, info.id, info.role, (info as { finish?: unknown }).finish, (info.time as { completed?: number })?.completed)
          return false
        }
        const next = [...messages]
        next[result.index] = info
        draft.message[info.sessionID] = next
      } else {
        const next = [...messages]
        next.splice(result.index, 0, info)
        draft.message[info.sessionID] = next
      }
      return true
    }

    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      const messages = draft.message[props.sessionID]
      if (messages) {
        const next = [...messages]
        const result = Binary.search(next, props.messageID, (m) => m.id)
        if (result.found) {
          next.splice(result.index, 1)
          draft.message[props.sessionID] = next
        }
      }
      delete draft.part[props.messageID]
      return true
    }

    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) {
        syncDebug.reducer.partSkipped((part as { messageID: string }).messageID, part.id, part.type)
        return false
      }
      const messageID = (part as { messageID: string }).messageID
      const sessionID = (part as { sessionID?: string }).sessionID
      const missingOwningMessage = !hasMessage(draft, sessionID, messageID)
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partUpdatedNoExistingParts(messageID, part.id, part.type)
        draft.part[messageID] = [part]
        return missingOwningMessage
          ? {
            changed: true,
            materialization: { type: "incomplete-session-snapshot", sessionID, messageID, partID: part.id },
          }
          : true
      }
      const next = [...parts]
      const result = Binary.search(next, part.id, (p) => p.id)
      if (result.found) {
        const previous = next[result.index]
        if (shouldPreserveExistingPart(previous, part)) {
          return false
        }
        const dedupeFields = getUpdatedDeltaFields(previous, part)
        next[result.index] = dedupeFields.length > 0
          ? { ...part, __dedupeNextDeltaFields: dedupeFields } as unknown as Part
          : part
      } else {
        // Replace optimistic part (no sessionID) with server part of same type.
        // Gate: only scan if the first part lacks sessionID (optimistic parts are
        // always inserted first). Assistant messages never have optimistic parts,
        // so this check is effectively free during streaming.
        const hasOptimistic = next.length > 0 && !(next[0] as { sessionID?: string }).sessionID
        const optimisticIdx = hasOptimistic && (part.type === "text" || part.type === "file")
          ? next.findIndex((p) => p.type === part.type && !(p as { sessionID?: string }).sessionID)
          : -1
        if (optimisticIdx >= 0) {
          next.splice(optimisticIdx, 1)
        }
        const insertResult = Binary.search(next, part.id, (p) => p.id)
        next.splice(insertResult.index, 0, part)
      }
      draft.part[messageID] = next
      return missingOwningMessage
        ? {
          changed: true,
          materialization: { type: "incomplete-session-snapshot", sessionID, messageID, partID: part.id },
        }
        : true
    }

    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = draft.part[props.messageID]
      if (!parts) return false
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        const next = [...parts]
        next.splice(result.index, 1)
        if (next.length === 0) {
          delete draft.part[props.messageID]
        } else {
          draft.part[props.messageID] = next
        }
        return true
      }
      return false
    }

    case "message.part.delta": {
      const props = event.properties as {
        messageID: string
        partID: string
        field: string
        delta: string
      }
      const parts = draft.part[props.messageID]
      if (!parts) {
        syncDebug.reducer.partDeltaNoParts(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", messageID: props.messageID, partID: props.partID },
        }
      }
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) {
        syncDebug.reducer.partDeltaNotFound(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", messageID: props.messageID, partID: props.partID },
        }
      }
      const existing = parts[result.index] as Record<string, unknown>
      const existingValue = existing[props.field] as string | undefined
      const dedupeFields = (existing as DedupeMetadata).__dedupeNextDeltaFields ?? []
      const shouldDedupe = dedupeFields.includes(props.field)
      // Create new Part object + new array so React detects the change
      const next = [...parts]
      next[result.index] = {
        ...existing,
        [props.field]: shouldDedupe ? appendNonOverlappingDelta(existingValue, props.delta) : (existingValue ?? "") + props.delta,
        __dedupeNextDeltaFields: dedupeFields.filter((field) => field !== props.field),
      } as unknown as Part
      draft.part[props.messageID] = next
      return true
    }

    case "vcs.branch.updated": {
      const props = event.properties as { branch: string }
      if (draft.vcs?.branch === props.branch) return false
      draft.vcs = { branch: props.branch }
      return true
    }

    case "permission.asked": {
      const permission = event.properties as PermissionRequest
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
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = draft.permission[props.sessionID]
      if (!permissions) return false
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (result.found) {
        const next = [...permissions]
        next.splice(result.index, 1)
        draft.permission[props.sessionID] = next
        return true
      }
      return false
    }

    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = draft.question[question.sessionID] ?? []
      const next = [...questions]
      const result = Binary.search(next, question.id, (q) => q.id)
      if (result.found) {
        next[result.index] = question
      } else {
        next.splice(result.index, 0, question)
      }
      draft.question[question.sessionID] = next
      return true
    }

    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = draft.question[props.sessionID]
      if (!questions) return false
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (result.found) {
        const next = [...questions]
        next.splice(result.index, 1)
        draft.question[props.sessionID] = next
        return true
      }
      return false
    }

    case "lsp.updated": {
      callbacks?.onLoadLsp?.()
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

function cleanupSessionCaches(
  draft: State,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  dropSessionCaches(draft, [sessionID])
}
