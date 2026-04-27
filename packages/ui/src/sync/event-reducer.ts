import type { PermissionRequest, Project, QuestionRequest, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import type { ChatSyncEvent, HarnessMessage, HarnessPart, HarnessSession } from "@openchamber/harness-contracts"
import { Binary } from "./binary"
import type { FileDiff, GlobalState, State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { stripSessionDiffSnapshots } from "./sanitize"
import { syncDebug } from "./debug"
import { toOpenCodePartCompat } from "./adapters/opencode"

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

function getUpdatedDeltaFields(previous: Record<string, unknown>, next: Record<string, unknown>) {
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

function getPartEndTime(part: HarnessPart): number | undefined {
  if (part.kind === "tool" && typeof part.tool.endedAt === "number") {
    return part.tool.endedAt
  }

  const raw = isObject(part.raw) ? part.raw : undefined
  if (!raw) return undefined
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
    ?? (raw as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (raw as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getToolStatus(part: HarnessPart): string | undefined {
  if (part.kind !== "tool") {
    return undefined
  }

  return part.tool.status
}

function shouldPreserveExistingPart(previous: HarnessPart, next: HarnessPart): boolean {
  if (previous.kind !== "tool" || next.kind !== "tool") {
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

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

export type GlobalEventResult = {
  type: "refresh"
} | {
  type: "project"
  project: Project
} | null

export type GlobalEvent = {
  type: "global.disposed" | "server.connected" | "project.updated" | string
  properties?: unknown
}

export function reduceGlobalEvent(event: GlobalEvent): GlobalEventResult {
  if (event.type === "global.disposed" || event.type === "server.connected") {
    return { type: "refresh" }
  }
  if (event.type === "project.updated") {
    return { type: "project", project: event.properties as Project }
  }
  return null
}

export type LegacyDirectoryEvent = {
  type:
    | "server.instance.disposed"
    | "session.diff"
    | "todo.updated"
    | "vcs.branch.updated"
    | "permission.asked"
    | "permission.replied"
    | "question.asked"
    | "question.replied"
    | "question.rejected"
    | "lsp.updated"
  properties?: unknown
}

export type DirectorySyncEvent = ChatSyncEvent | LegacyDirectoryEvent

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
  event: DirectorySyncEvent,
  callbacks?: {
    onRefresh?: (directory: string) => void
    onLoadLsp?: () => void
    onSetSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  },
): boolean {
  switch (event.type) {
    case "server.instance.disposed": {
      callbacks?.onRefresh?.("")
      return false
    }

    case "session.upserted": {
      const info = sanitizeHarnessSession(event.session)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
        if (!info.parentId) draft.sessionTotal += 1
      }
      return true
    }

    case "session.removed": {
      const sessions = draft.session
      const result = Binary.search(sessions, event.sessionId, (s) => s.id)
      const removed = result.found ? sessions[result.index] : undefined
      if (result.found) sessions.splice(result.index, 1)
      cleanupSessionCaches(draft, event.sessionId, callbacks?.onSetSessionTodo)
      if (!removed?.parentId) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
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

    case "session.status.updated": {
      const rawStatus = event.status.raw
      draft.session_status[event.sessionId] = isObject(rawStatus) ? rawStatus as SessionStatus : { type: event.status.status === "running" ? "busy" : "idle" } as SessionStatus
      return true
    }

    case "message.upserted": {
      const info = sanitizeHarnessMessage(event.message)
      const messages = draft.message[info.sessionId]
      if (!messages) {
        draft.message[info.sessionId] = [info]
        return true
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        // Skip message replacement if unchanged — preserves reference, avoids re-render
        const existing = messages[result.index]
        const unchanged = existing.role === info.role
          && existing.finish === info.finish
          && existing.time?.completed === info.time?.completed
        if (unchanged) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionId, info.id, info.role, info.finish, info.time?.completed)
          return false
        }
        const next = [...messages]
        next[result.index] = info
        draft.message[info.sessionId] = next
      } else {
        const next = [...messages]
        next.splice(result.index, 0, info)
        draft.message[info.sessionId] = next
      }
      return true
    }

    case "message.removed": {
      const messages = draft.message[event.sessionId]
      if (messages) {
        const next = [...messages]
        const result = Binary.search(next, event.messageId, (m) => m.id)
        if (result.found) {
          next.splice(result.index, 1)
          draft.message[event.sessionId] = next
        }
      }
      delete draft.part[event.messageId]
      return true
    }

    case "part.upserted": {
      const part = event.part
      const rawType = getOpenCodePartType(part)
      if (rawType && SKIP_PARTS.has(rawType)) {
        syncDebug.reducer.partSkipped(part.messageId, part.id, rawType)
        return false
      }
      const messageID = part.messageId
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partUpdatedNoExistingParts(messageID, part.id, rawType ?? part.kind)
        draft.part[messageID] = [part]
        return true
      }
      const next = [...parts]
      const result = Binary.search(next, part.id, (p) => p.id)
      if (result.found) {
        const previous = next[result.index]
        if (shouldPreserveExistingPart(previous, part)) {
          return false
        }
        const dedupeFields = getUpdatedDeltaFields(toOpenCodePartCompat(previous), toOpenCodePartCompat(part))
        next[result.index] = dedupeFields.length > 0
          ? { ...part, __dedupeNextDeltaFields: dedupeFields } as unknown as HarnessPart
          : part
      } else {
        // Replace optimistic part (no sessionID) with server part of same type.
        // Gate: only scan if the first part lacks sessionID (optimistic parts are
        // always inserted first). Assistant messages never have optimistic parts,
        // so this check is effectively free during streaming.
        const hasOptimistic = next.length > 0 && !next[0].sessionId
        const optimisticIdx = hasOptimistic && (part.kind === "text" || part.kind === "attachment")
          ? next.findIndex((p) => p.kind === part.kind && !p.sessionId)
          : -1
        if (optimisticIdx >= 0) {
          next.splice(optimisticIdx, 1)
        }
        const insertResult = Binary.search(next, part.id, (p) => p.id)
        next.splice(insertResult.index, 0, part)
      }
      draft.part[messageID] = next
      return true
    }

    case "part.removed": {
      const parts = draft.part[event.messageId]
      if (!parts) return false
      const result = Binary.search(parts, event.partId, (p) => p.id)
      if (result.found) {
        const next = [...parts]
        next.splice(result.index, 1)
        if (next.length === 0) {
          delete draft.part[event.messageId]
        } else {
          draft.part[event.messageId] = next
        }
        return true
      }
      return false
    }

    case "part.delta": {
      const parts = draft.part[event.messageId]
      if (!parts) {
        syncDebug.reducer.partDeltaNoParts(event.messageId, event.partId)
        return false
      }
      const result = Binary.search(parts, event.partId, (p) => p.id)
      if (!result.found) {
        syncDebug.reducer.partDeltaNotFound(event.messageId, event.partId)
        return false
      }
      const existing = parts[result.index] as unknown as Record<string, unknown>
      const existingValue = existing[event.field] as string | undefined
      const dedupeFields = (existing as DedupeMetadata).__dedupeNextDeltaFields ?? []
      const shouldDedupe = dedupeFields.includes(event.field)
      const nextValue = shouldDedupe ? appendNonOverlappingDelta(existingValue, event.delta) : (existingValue ?? "") + event.delta
      // Create new Part object + new array so React detects the change
      const next = [...parts]
      next[result.index] = applyHarnessPartDelta(
        parts[result.index],
        event.field,
        nextValue,
        dedupeFields.filter((field) => field !== event.field),
      )
      draft.part[event.messageId] = next
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
      const permissions = [...(draft.permission[permission.sessionID] ?? [])]
      draft.permission[permission.sessionID] = permissions
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        permissions[result.index] = permission
      } else {
        permissions.splice(result.index, 0, permission)
      }
      return true
    }

    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = draft.permission[props.sessionID]
      if (!permissions) return false
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (result.found) {
        draft.permission[props.sessionID] = [...permissions.slice(0, result.index), ...permissions.slice(result.index + 1)]
        return true
      }
      return false
    }

    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = [...(draft.question[question.sessionID] ?? [])]
      draft.question[question.sessionID] = questions
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        questions[result.index] = question
      } else {
        questions.splice(result.index, 0, question)
      }
      return true
    }

    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = draft.question[props.sessionID]
      if (!questions) return false
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (result.found) {
        draft.question[props.sessionID] = [...questions.slice(0, result.index), ...questions.slice(result.index + 1)]
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

function sanitizeHarnessSession(session: HarnessSession): HarnessSession {
  const raw = session.raw
  if (!isObject(raw)) return session
  const stripped = stripSessionDiffSnapshots(raw)
  return stripped === raw ? session : { ...session, raw: stripped }
}

function sanitizeHarnessMessage(message: HarnessMessage): HarnessMessage {
  return message
}

function getOpenCodePartType(part: HarnessPart): string | undefined {
  const raw = part.raw
  if (isObject(raw)) {
    const type = raw.type
    if (typeof type === "string") return type
  }
  if (part.kind === "attachment") return "file"
  return part.kind
}

function applyHarnessPartDelta(
  part: HarnessPart,
  field: string,
  value: string,
  dedupeFields: string[],
): HarnessPart {
  const raw = isObject(part.raw) ? { ...part.raw, [field]: value } : part.raw
  const metadata = { __dedupeNextDeltaFields: dedupeFields }

  if ((part.kind === "text" || part.kind === "reasoning") && field === "text") {
    return { ...part, text: value, raw, ...metadata } as HarnessPart
  }

  if (part.kind === "tool" && field === "output") {
    return { ...part, tool: { ...part.tool, output: value }, raw, ...metadata } as HarnessPart
  }

  return { ...part, raw, ...metadata } as HarnessPart
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
