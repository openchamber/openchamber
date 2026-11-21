import type { StoreApi } from "zustand"
import type { FormRequest, PermissionRequest } from "@/lib/opencode/model"
import { isVSCodeRuntime } from "@/lib/desktop"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { noteQuestionFormSnapshot, readLiveForms } from "./recoverable-questions"
import { opencodeClient } from "@/lib/opencode/client"
import { processVSCodeReconciledPermissionAutoAccept } from "./vscode-permission-auto-accept"
import { toast } from "@/components/ui"
import { showPermissionNeededToast } from "./permission-toast"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { isViewedInCurrentSession } from "./viewed-sessions"
import { getFormToastKey, pendingFormToastIds, FORM_TOAST_DESCRIPTION, formToastAction, pendingPermissionToastIds, openRequestFromToast } from "./sync-request-notifications"

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean },
) {
  const isCurrentRuntime = captureRuntimeInstance()
  const before = store.getState()
  const candidateIds = new Set<string>(candidateSessionIds ?? [
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.form ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  if (candidateIds.size === 0) return true
  const candidates = Array.from(candidateIds)
  let succeeded = true

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.form[sessionId])]),
    )
    const applied = await readLiveForms(() => opencodeClient.listPendingForms({ directories: [directory] }), (liveForms) => {
      if (!isCurrentRuntime()) return false
      noteQuestionFormSnapshot(directory, liveForms)
      const grouped: Record<string, FormRequest[]> = {}
      for (const form of liveForms) {
        if (!form?.id || !form.sessionID) continue
        if (!candidateIds.has(form.sessionID)) continue
        const list = grouped[form.sessionID]
        if (list) list.push(form)
        else grouped[form.sessionID] = [form]
      }
      for (const sessionId of Object.keys(grouped)) {
        grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      }

      for (const [sessionId, forms] of Object.entries(grouped)) {
        const knownIds = new Set((before.form[sessionId] ?? []).map((item) => item.id))
        const isViewed = isViewedInCurrentSession(directory, sessionId)
        if (isViewed) continue
        for (const form of forms) {
          if (knownIds.has(form.id)) continue
          const toastKey = getFormToastKey(sessionId, form.id)
          if (!toastKey || pendingFormToastIds.has(toastKey)) continue
          pendingFormToastIds.add(toastKey)
          toast.info(form.title, {
            id: `form-${toastKey}`,
            description: FORM_TOAST_DESCRIPTION,
            action: formToastAction(sessionId, directory, form.id),
          })
        }
      }

      store.setState((state: DirectoryStore) => {
        const merged = { ...state.form }
        for (const [sessionId, forms] of Object.entries(grouped)) {
          merged[sessionId] = forms
        }
        for (const sessionId of candidates) {
          if (grouped[sessionId]) continue
          const beforeSignature = beforeSignatures.get(sessionId) ?? ""
          const currentSignature = requestSignature(state.form[sessionId])
          if (currentSignature !== beforeSignature) continue
          delete merged[sessionId]
        }
        return { form: merged }
      })
      return true
    })
    if (!applied) return false
  } catch {
    succeeded = false
  }

  if (options?.includePermissions === false) return succeeded

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    )
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] })
    if (!isCurrentRuntime()) return false
    const grouped: Record<string, PermissionRequest[]> = {}
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue
      if (!candidateIds.has(permission.sessionID)) continue
      const list = grouped[permission.sessionID]
      if (list) list.push(permission)
      else grouped[permission.sessionID] = [permission]
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    if (isVSCodeRuntime()) {
      const acceptedIdsBySession = new Map<string, Set<string>>()
      await Promise.all(Object.entries(grouped).flatMap(([sessionId, permissions]) =>
        permissions.map(async (permission) => {
          if (!(await processVSCodeReconciledPermissionAutoAccept(permission, directory))) return
          const accepted = acceptedIdsBySession.get(sessionId) ?? new Set<string>()
          accepted.add(permission.id)
          acceptedIdsBySession.set(sessionId, accepted)
        }),
      ))

      for (const sessionId of Object.keys(grouped)) {
        const acceptedIds = acceptedIdsBySession.get(sessionId)
        if (!acceptedIds) continue
        const remaining = (grouped[sessionId] ?? []).filter((permission) => !acceptedIds.has(permission.id))
        if (remaining.length > 0) grouped[sessionId] = remaining
        else delete grouped[sessionId]
      }
    }

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        showPermissionNeededToast({
          permission,
          directory,
          isViewed,
          pendingIds: pendingPermissionToastIds,
          show: (title, options) => toast.info(title, options),
          openSession: openRequestFromToast,
        })
      }
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission }
      for (const [sessionId, permissions] of Object.entries(grouped)) {
        merged[sessionId] = permissions
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue
        const beforeSignature = beforeSignatures.get(sessionId) ?? ""
        const currentSignature = requestSignature(state.permission[sessionId])
        if (currentSignature !== beforeSignature) continue
        delete merged[sessionId]
      }
      return { permission: merged }
    })
  } catch {
    succeeded = false
  }
  return succeeded
}

export async function resyncBlockingRequestsForActiveDirectory(
  directory: string,
  childStores: ChildStoreManager,
) {
  const store = childStores.getChild(directory)
  if (!store) return
  await resyncBlockingRequestsForDirectory(directory, store)
}
