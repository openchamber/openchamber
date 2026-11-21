import { getChatsRoot } from "@/lib/chatDirectories"
import { normalizePath } from "@/lib/pathNormalization"
import { useSessionFoldersStore, type SessionFolder, type SessionFoldersMap } from "@/stores/useSessionFoldersStore"
import type { NewSessionDraftState } from "./session-ui-store"

type DraftFolderFields = Pick<NewSessionDraftState, "target" | "directoryOverride" | "pendingWorktreeRequestId" | "targetFolderId">

const getDraftFolderScope = (draft: DraftFolderFields): string | null => {
  if (draft.pendingWorktreeRequestId) return null
  return draft.target === "chat" ? getChatsRoot() : normalizePath(draft.directoryOverride ?? null)
}

export const getDraftTargetFolder = (
  foldersMap: SessionFoldersMap,
  draft: DraftFolderFields,
): { scope: string; folder: SessionFolder } | null => {
  const scope = getDraftFolderScope(draft)
  const folder = scope && draft.targetFolderId
    ? foldersMap[scope]?.find((candidate) => candidate.id === draft.targetFolderId)
    : undefined
  return scope && folder ? { scope, folder } : null
}

export const fileDraftSessionInFolder = (draft: DraftFolderFields, sessionId: string, createdIn?: string): void => {
  const target = getDraftTargetFolder(useSessionFoldersStore.getState().foldersMap, draft)
  if (!target) return
  if (createdIn !== undefined) {
    const directory = normalizePath(createdIn)
    if (!directory || (directory !== target.scope && !directory.startsWith(`${target.scope}/`))) return
  }
  useSessionFoldersStore.getState().addSessionToFolder(target.scope, target.folder.id, sessionId)
}
