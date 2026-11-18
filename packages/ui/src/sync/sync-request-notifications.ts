import { type SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, PermissionRequest } from "@/lib/opencode/model"
import { isVSCodeRuntime } from "@/lib/desktop"
import { ChildStoreManager } from "./child-store"
import { getDirectoryState } from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { usePermissionStore } from "@/stores/permissionStore"
import { selectSafetyNetAvailable, useRoutingStore } from "@/stores/useRoutingStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { toast } from "@/components/ui"
import { appendErrorNotification } from "./notification-store"
import { recordSessionError, responseBodyOf, summarizeOpenCodeError } from "./session-error-log"
import { openSessionFromToast } from "./session-navigation"
import { revealRequest, revealWaitingPage } from "./request-reveal"
import { getPermissionToastKey, showPermissionNeededToast } from "./permission-toast"
import { type DirectoryEventBatch, getDirectoryEventState } from "./directory-event-batch"
import { isViewedInCurrentSession } from "./viewed-sessions"
import { resolveCachedSessionDirectory } from "./event-routing-index"

export const pendingFormToastIds = new Set<string>()

export const pendingPermissionToastIds = new Set<string>()

export const pendingVSCodePermissionEvents = new Map<string, symbol>()

export const getVSCodePermissionEventKey = (
  runtimeKey: string,
  directory: string,
  sessionID?: string,
  requestID?: string,
): string | null => {
  const requestKey = getPermissionToastKey(sessionID, requestID)
  return requestKey ? JSON.stringify([runtimeKey, directory, requestKey]) : null
}

export const getFormToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

export const FORM_TOAST_DESCRIPTION = "Agent is waiting for your input"

export const openRequestFromToast = (sessionID: string, directory: string, requestID: string) => {
  openSessionFromToast(sessionID, directory)
  revealRequest(requestID)
}

export const formToastAction = (sessionID: string, directory: string, formID: string) => (
  sessionID === LOCATION_SCOPED_FORM_SESSION_ID
    ? undefined
    : { label: "Open session", onClick: () => openRequestFromToast(sessionID, directory, formID) }
)

export const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const notificationToastId = (kind?: string, title?: string, body?: string, tag?: string): string | undefined => {
  if (tag) return tag
  const fallback = [kind, title, body].filter(Boolean).join("|")
  return fallback || undefined
}

export const showPluginNotificationToast = (kind?: string, title?: string, body?: string, tag?: string): void => {
  if (kind !== "plugin" || !title) return
  toast.info(title, {
    id: notificationToastId(kind, title, body, tag),
    description: body,
  })
}

const isSubtaskSession = (
  sessionID: string,
  directory: string,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): boolean => {
  const store = childStores.getChild(directory)
  const stored = store ? getDirectoryEventState(store, batch).session.find((s) => s.id === sessionID) : undefined
  const session = stored ?? useGlobalSessionsStore.getState().entityById.get(sessionID)
  return Boolean(session?.parentID)
}

export const notifyPermissionAsked = (permission: PermissionRequest, directory: string): void => {
  showPermissionNeededToast({
    permission,
    directory,
    isViewed: isViewedInCurrentSession(directory, permission.sessionID),
    pendingIds: pendingPermissionToastIds,
    show: (title, options) => toast.info(title, options),
    openSession: openRequestFromToast,
  })
}

const isAnsweredWithoutUser = (sessionID: string): boolean => {
  const mode = usePermissionStore.getState().getSessionMode(sessionID)
  return mode === "auto" || (mode === "safety" && selectSafetyNetAvailable(useRoutingStore.getState()))
}

const MAX_EARLY_LEFT_FOR_USER = 100

const permissionsAwaitingAutoAnswer = new Map<string, () => void>()

const leftForUserBeforeAsked = new Set<string>()

const autoAnswerKey = (sessionID: string, permissionID: string) => `${sessionID}\n${permissionID}`

export const isHeldUntilAutoAnswered = (permission: PermissionRequest): boolean =>
  !leftForUserBeforeAsked.has(autoAnswerKey(permission.sessionID, permission.id)) && !isVSCodeRuntime() && isAnsweredWithoutUser(permission.sessionID)

export const holdBackUntilAutoAnswered = (permission: PermissionRequest, replayAsAsk: () => void): boolean => {
  const key = autoAnswerKey(permission.sessionID, permission.id)
  if (leftForUserBeforeAsked.delete(key)) return false
  if (!isHeldUntilAutoAnswered(permission)) return false
  permissionsAwaitingAutoAnswer.set(key, replayAsAsk)
  return true
}

export const showPermissionLeftForUser = (
  { permissionId, sessionId, directory, spaceId }: Extract<SyncEvent, { type: "openchamber.permission-left-for-user" }>["properties"],
): void => {
  if (spaceId && spaceIdOfDirectory(useSessionUIStore.getState().getDirectoryForSession(sessionId)) !== spaceId) return
  const key = autoAnswerKey(sessionId, permissionId)
  const replayAsAsk = permissionsAwaitingAutoAnswer.get(key)
  if (replayAsAsk) {
    permissionsAwaitingAutoAnswer.delete(key)
    replayAsAsk()
    return
  }
  if (directory && getDirectoryState(directory)?.permission[sessionId]?.some((entry) => entry.id === permissionId)) return
  leftForUserBeforeAsked.add(key)
  const oldest = leftForUserBeforeAsked.values().next()
  if (leftForUserBeforeAsked.size > MAX_EARLY_LEFT_FOR_USER && !oldest.done) leftForUserBeforeAsked.delete(oldest.value)
}

export const forgetAutoAnswerWait = (sessionID: string, permissionID: string): void => {
  permissionsAwaitingAutoAnswer.delete(autoAnswerKey(sessionID, permissionID))
  leftForUserBeforeAsked.delete(autoAnswerKey(sessionID, permissionID))
}

export const notifyFormCreated = (form: FormRequest, directory: string): void => {
  const sessionID = form.sessionID
  const toastKey = getFormToastKey(sessionID, form.id)
  if (isViewedInCurrentSession(directory, sessionID) || !toastKey || pendingFormToastIds.has(toastKey)) return
  pendingFormToastIds.add(toastKey)
  toast.info(form.title, {
    id: `form-${toastKey}`,
    description: FORM_TOAST_DESCRIPTION,
    action: formToastAction(sessionID, directory, form.id),
  })
}

export const notifyWaitingPage = (event: Extract<SyncEvent, { type: "openchamber.page-waiting" }>): void => {
  const { sessionID, page } = event.properties
  const directory = event.properties.directory ?? resolveCachedSessionDirectory(sessionID)
  if (!directory || isViewedInCurrentSession(directory, sessionID)) return
  toast.info(page.title, {
    id: `page-${sessionID}:${page.id}`,
    description: FORM_TOAST_DESCRIPTION,
    action: {
      label: "Open session",
      onClick: () => {
        revealWaitingPage(sessionID)
        openSessionFromToast(sessionID, directory)
      },
    },
  })
}

export const notifyBlockingRequestWithoutStore = (payload: SyncEvent, directory: string, replayAsAsk: (() => void) | null): void => {
  if (isVSCodeRuntime()) return
  if (payload.type === "permission.asked") {
    const permission = payload.properties
    if (replayAsAsk && holdBackUntilAutoAnswered(permission, replayAsAsk)) return
    notifyPermissionAsked(permission, directory)
    return
  }
  if (payload.type === "form.created") {
    notifyFormCreated(payload.properties.form, directory)
  }
}

export const recordTurnOutcomeNotification = (
  payload: Extract<SyncEvent, { type: "session.idle" | "session.error" }>,
  directory: string,
  childStores: ChildStoreManager,
  batch?: DirectoryEventBatch,
): void => {
  const { sessionID } = payload.properties
  if (!sessionID) return
  const errorSummary = payload.type === "session.error" ? summarizeOpenCodeError(payload.properties.error) : null
  const responseBody = payload.type === "session.error" ? responseBodyOf(payload.properties.error) : null
  if (errorSummary) {
    recordSessionError({ sessionId: sessionID, directory, ...errorSummary })
  }
  if (!errorSummary || isSubtaskSession(sessionID, directory, childStores, batch)) return
  appendErrorNotification({
    directory,
    session: sessionID,
    time: Date.now(),
    error: { ...errorSummary, responseBody },
  })
}
