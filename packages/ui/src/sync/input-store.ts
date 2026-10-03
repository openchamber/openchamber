/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachIssueRequest } from '@openchamber/sdk'
import type { ContextPartMetadata } from '@/lib/messages/contextParts'
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { prepareAttachmentFiles } from "./attachment-files"
import { getChatDraftIdentityKey, subscribeChatDraftDeletion, type ChatDraftIdentity } from "@/lib/chatDraftPersistence"

const FILE_URI_PREFIX = "file://"
const MAX_ATTACHMENT_PREPARATION_ATTEMPTS = 3
const pendingVSCodeSelectionKeys = new Set<string>()
let attachmentReadGeneration = 0

const encodeFilePath = (filepath: string): string => {
  let normalized = filepath.replace(/\\/g, "/")
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = `/${normalized}`
  }
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

const toFileUrl = (filepath: string): string => {
  const normalized = filepath.replace(/\\/g, "/").trim()
  if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
    return normalized
  }
  return `${FILE_URI_PREFIX}${encodeFilePath(normalized)}`
}

const getVSCodeSelectionKey = (path: string, filename: string): string => `${path}\u0000${filename}`

const hasGeneratedFilenameCollision = (filenames: string[], attachedFiles: AttachedFile[]): boolean => {
  if (filenames.length === 0) return false
  const attachedFilenames = new Set(attachedFiles.map((attachment) => attachment.filename.toLowerCase()))
  return filenames.some((filename) => attachedFilenames.has(filename.toLowerCase()))
}

const readFileAsDataUrl = (file: File, mime: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    const value = typeof reader.result === "string" ? reader.result : ""
    const commaIndex = value.indexOf(",")
    resolve(commaIndex === -1 ? value : `data:${mime};base64,${value.slice(commaIndex + 1)}`)
  }
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
  reader.onabort = () => reject(new Error("File read aborted"))
  reader.readAsDataURL(file)
})

export const prepareLocalAttachments = async (
  file: File,
  reservedFilenames: Iterable<string> = [],
): Promise<AttachedFile[] | undefined> => {
  const preparedOrPending = prepareAttachmentFiles(file, reservedFilenames)
  const preparedFiles = preparedOrPending instanceof Promise ? await preparedOrPending : preparedOrPending
  if (!preparedFiles || preparedFiles.length === 0) return

  const sourceDocumentId = preparedFiles.length > 1
    ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    : undefined
  const attachedFiles: AttachedFile[] = []
  for (const prepared of preparedFiles) {
    const dataUrl = await readFileAsDataUrl(prepared.file, prepared.mimeType)
    if (!dataUrl) return
    attachedFiles.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file: prepared.file,
      dataUrl,
      mimeType: prepared.mimeType,
      filename: prepared.file.name,
      size: prepared.file.size,
      source: "local",
      sourceDocumentId,
    })
  }
  return attachedFiles
}

const getDataUrlByteSize = (url: string): number => {
  if (!url.startsWith("data:")) return 0
  const commaIndex = url.indexOf(",")
  if (commaIndex < 0) return 0
  const metadata = url.slice(0, commaIndex).toLowerCase()
  const payload = url.slice(commaIndex + 1)
  if (!metadata.endsWith(";base64")) return 0
  let padding = 0
  if (payload.endsWith("==")) {
    padding = 2
  } else if (payload.endsWith("=")) {
    padding = 1
  }
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

const isSameVSCodeActiveEditorFile = (a: VSCodeActiveEditorFile | null, b: VSCodeActiveEditorFile | null): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text
}

export type SyntheticContextPart = {
  text: string
  attachments?: AttachedFile[]
  synthetic?: boolean
  metadata?: ContextPartMetadata
}

type PendingBtwComposerRequest = {
  parentSessionId: string
  text: string
}

export type VSCodeActiveEditorFile = {
  filePath: string
  fileName: string
  relativePath: string
  fileSize: number | null
  selection: { startLine: number; endLine: number; text: string } | null
}

export type InputState = {
  pendingComposerRestore: {
    target: ChatDraftIdentity
    text: string
    files: Array<{ url: string; mimeType: string; filename: string }>
  } | null
  consumePendingComposerRestore: (target: ChatDraftIdentity | null) => InputState["pendingComposerRestore"]
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  /**
   * Who the pending text is for. Null is the main chat's composer, which
   * app-wide sources (plugins, git dialogs, file selections) write to; a
   * session id is the composer of a chat pinned in the side panel on that
   * session, which text quoted inside that chat is written to.
   */
  pendingInputTarget: string | null
  /** Pending context for the main chat's composer. */
  pendingSyntheticParts: SyntheticContextPart[] | null
  /** Pending context for pinned composers, by their session id. */
  pinnedSyntheticParts: Map<string, SyntheticContextPart[]>
  /**
   * Text a draft preset chip asked to submit immediately. Set by surfaces that
   * render the chips outside ChatInput (e.g. under the welcome message on
   * narrow layouts); consumed by ChatInput, which owns the command-aware submit.
   */
  pendingPresetSubmit: { text: string; type: "command" | "skill" } | null
  /** Guest rail/dialog attach. ChatInput consumes this into the composer chip. */
  pendingGuestIssue: AttachIssueRequest | null
  pendingBtwComposerRequest: PendingBtwComposerRequest | null
  attachedFiles: AttachedFile[]
  attachmentDraftKey: string | null
  attachmentDrafts: Map<string, AttachedFile[]>
  selectAttachmentDraft: (target: ChatDraftIdentity | null) => void
  restoreAttachedFiles: (files: AttachedFile[], target: ChatDraftIdentity | null) => void
  activeEditorFile: VSCodeActiveEditorFile | null

  setPendingInputText: (text: string | null, mode?: "replace" | "append" | "append-inline", target?: string | null) => void
  consumePendingInputText: (target?: string | null) => { text: string; mode: "replace" | "append" | "append-inline" } | null
  requestPresetSubmit: (text: string, type: "command" | "skill") => void
  consumePendingPresetSubmit: () => { text: string; type: "command" | "skill" } | null
  setPendingGuestIssue: (issue: AttachIssueRequest | null) => void
  consumePendingGuestIssue: () => AttachIssueRequest | null
  requestBtwComposer: (request: PendingBtwComposerRequest) => void
  consumePendingBtwComposerRequest: (parentSessionId: string | null) => PendingBtwComposerRequest | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null, target?: string | null) => void
  consumePendingSyntheticParts: (target?: string | null) => SyntheticContextPart[] | null
  getPendingSyntheticParts: (target?: string | null) => SyntheticContextPart[] | null
  addAttachedFile: (file: File) => Promise<boolean>
  removeAttachedFile: (id: string) => void
  setAttachedFiles: (files: AttachedFile[], target?: ChatDraftIdentity | null) => void
  clearAttachedFiles: (target?: ChatDraftIdentity | null) => void
  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => void
  addVSCodeSelectionAttachment: (path: string, file: File) => Promise<void>
  setActiveEditorFile: (file: VSCodeActiveEditorFile | null) => void
  /** Add attachments restored from a reverted message (file already on server) */
  addRestoredAttachment: (file: { url: string; mimeType: string; filename: string }) => void
}

export const useInputStore = create<InputState>()((set, get) => ({
  pendingComposerRestore: null,
  consumePendingComposerRestore: (target) => {
    const pending = get().pendingComposerRestore
    if (!pending || !target || getChatDraftIdentityKey(pending.target) !== getChatDraftIdentityKey(target)) return null
    set({ pendingComposerRestore: null })
    return pending
  },
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingInputTarget: null,
  pendingSyntheticParts: null,
  pinnedSyntheticParts: new Map(),
  pendingPresetSubmit: null,
  pendingGuestIssue: null,
  pendingBtwComposerRequest: null,
  attachedFiles: [],
  attachmentDraftKey: null,
  attachmentDrafts: new Map(),
  selectAttachmentDraft: (target) => {
    const key = target ? getChatDraftIdentityKey(target) : null
    const state = get()
    if (key === state.attachmentDraftKey) return
    const drafts = new Map(state.attachmentDrafts)
    if (state.attachmentDraftKey) {
      if (state.attachedFiles.length) drafts.set(state.attachmentDraftKey, state.attachedFiles)
      else drafts.delete(state.attachmentDraftKey)
    }
    // Unowned files may arrive from a native picker before the first mount.
    const files = key ? (drafts.get(key) ?? (state.attachmentDraftKey === null ? state.attachedFiles : [])) : []
    if (key) drafts.delete(key)
    attachmentReadGeneration += 1
    set({ attachmentDraftKey: key, attachmentDrafts: drafts, attachedFiles: files })
  },
  restoreAttachedFiles: (files, target) => {
    const state = get()
    const key = target ? getChatDraftIdentityKey(target) : null
    const existing = key === state.attachmentDraftKey ? state.attachedFiles : (key && state.attachmentDrafts.get(key)) || []
    const present = new Set(existing.map((file) => file.id))
    const missing = files.filter((file) => !present.has(file.id))
    if (missing.length) state.setAttachedFiles([...existing, ...missing], target)
  },
  activeEditorFile: null,

  setPendingInputText: (text, mode = "replace", target = null) =>
    set({ pendingInputText: text, pendingInputMode: mode, pendingInputTarget: text === null ? null : target }),

  consumePendingInputText: (target = null) => {
    const { pendingInputText, pendingInputMode, pendingInputTarget } = get()
    if (pendingInputText === null || pendingInputTarget !== target) return null
    set({ pendingInputText: null, pendingInputMode: "replace", pendingInputTarget: null })
    return { text: pendingInputText, mode: pendingInputMode }
  },

  requestPresetSubmit: (text, type) => set({ pendingPresetSubmit: { text, type } }),

  consumePendingPresetSubmit: () => {
    const { pendingPresetSubmit } = get()
    if (pendingPresetSubmit === null) return null
    set({ pendingPresetSubmit: null })
    return pendingPresetSubmit
  },

  setPendingGuestIssue: (issue) => set({ pendingGuestIssue: issue }),

  consumePendingGuestIssue: () => {
    const { pendingGuestIssue } = get()
    if (pendingGuestIssue === null) return null
    set({ pendingGuestIssue: null })
    return pendingGuestIssue
  },

  requestBtwComposer: (request) => set({ pendingBtwComposerRequest: request }),

  consumePendingBtwComposerRequest: (parentSessionId) => {
    const request = get().pendingBtwComposerRequest
    if (!request || request.parentSessionId !== parentSessionId) return null
    set({ pendingBtwComposerRequest: null })
    return request
  },

  setPendingSyntheticParts: (parts, target = null) => {
    if (target === null) {
      set({ pendingSyntheticParts: parts })
      return
    }
    const pinned = new Map(get().pinnedSyntheticParts)
    if (parts?.length) pinned.set(target, parts)
    else pinned.delete(target)
    set({ pinnedSyntheticParts: pinned })
  },

  consumePendingSyntheticParts: (target = null) => {
    const parts = get().getPendingSyntheticParts(target)
    if (parts !== null) get().setPendingSyntheticParts(null, target)
    return parts
  },

  getPendingSyntheticParts: (target = null) => (
    target === null ? get().pendingSyntheticParts : get().pinnedSyntheticParts.get(target) ?? null
  ),

  addAttachedFile: async (file: File) => {
    const generation = attachmentReadGeneration
    for (let attempt = 0; attempt < MAX_ATTACHMENT_PREPARATION_ATTEMPTS; attempt += 1) {
      const reservedFilenames = get().attachedFiles.map((attachment) => attachment.filename)
      let attachedFiles: AttachedFile[] | undefined
      try {
        attachedFiles = await prepareLocalAttachments(file, reservedFilenames)
      } catch {
        return false
      }
      if (!attachedFiles || generation !== attachmentReadGeneration) return false

      const generatedFilenames = attachedFiles.slice(1).map((attachment) => attachment.filename)
      if (hasGeneratedFilenameCollision(generatedFilenames, get().attachedFiles)) continue

      set((state) => ({ attachedFiles: [...state.attachedFiles, ...attachedFiles] }))
      return true
    }
    return false
  },

  removeAttachedFile: (id) =>
    set((s) => {
      const target = s.attachedFiles.find((f) => f.id === id)
      if (target?.sourceDocumentId) {
        return { attachedFiles: s.attachedFiles.filter((f) => f.sourceDocumentId !== target.sourceDocumentId) }
      }
      return { attachedFiles: s.attachedFiles.filter((f) => f.id !== id) }
    }),

  setAttachedFiles: (files, target) => {
    const state = get()
    const key = target === undefined ? state.attachmentDraftKey : target ? getChatDraftIdentityKey(target) : null
    if (key !== state.attachmentDraftKey) {
      if (!key) return
      const drafts = new Map(state.attachmentDrafts)
      if (files.length) drafts.set(key, files)
      else drafts.delete(key)
      set({ attachmentDrafts: drafts })
      return
    }
    attachmentReadGeneration += 1
    set({ attachedFiles: files })
  },

  clearAttachedFiles: (target) => get().setAttachedFiles([], target),

  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === path
    )
    if (isDuplicate) return
    const dataUrl = toFileUrl(path)
    // `file://` URLs are the same contract used by server-source attachments.
    // The submission path passes `dataUrl` as `url` directly to the OpenCode
    // server, which resolves `file://` paths natively. No base64 encoding needed.
    const attached: AttachedFile = {
      id,
      file: new File([], name, { type: 'text/plain' }),
      dataUrl,
      mimeType: 'text/plain',
      filename: name,
      size: fileSize || 0,
      source: 'vscode',
      vscodePath: path,
      vscodeSource: 'file',
    }
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },

  addVSCodeSelectionAttachment: async (path: string, file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const generation = attachmentReadGeneration
    const selectionKey = `${generation}\u0000${getVSCodeSelectionKey(path, file.name)}`
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === file.name && f.vscodePath === path
    )
    if (isDuplicate || pendingVSCodeSelectionKeys.has(selectionKey)) return
    pendingVSCodeSelectionKeys.add(selectionKey)
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file, file.type)
    } catch {
      return
    } finally {
      pendingVSCodeSelectionKeys.delete(selectionKey)
    }
    if (generation !== attachmentReadGeneration) return
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: 'vscode',
      vscodePath: path,
      vscodeSource: 'selection',
    }
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },

  setActiveEditorFile: (file) => {
    if (isSameVSCodeActiveEditorFile(get().activeEditorFile, file)) return
    set({ activeEditorFile: file })
  },

  addRestoredAttachment: ({ url, mimeType, filename }) => {
    const id = `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Use "local" source so the file renders in AttachedFilesList.
    // Set serverPath to the URL so ImagePreview can use it as the img src
    // when dataUrl is not a data: URL. sanitizeAttachmentsForSend leaves
    // dataUrl alone for non-server sources, so the URL stays intact on send.
    const attached: AttachedFile = {
      id,
      file: new File([], filename, { type: mimeType }),
      dataUrl: url,
      mimeType,
      filename,
      size: getDataUrlByteSize(url),
      source: "local",
      serverPath: url,
    }
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },
}))

const NO_ATTACHMENTS: AttachedFile[] = []

/**
 * The attachments of one composer draft, whether or not it holds the selected
 * slot. Two composers can be on screen at once (a chat pinned in the side
 * panel); each shows its own files while only the one the user last worked
 * in holds `attachedFiles`. With a single composer the draft is always the
 * selected one, so this reads `attachedFiles`.
 */
export const useDraftAttachedFiles = (target: ChatDraftIdentity | null | undefined): AttachedFile[] => {
  // Undefined: no composer named, the selected slot.
  const key = target === undefined ? undefined : target ? getChatDraftIdentityKey(target) : null
  return useInputStore((state) => {
    if (key === undefined || key === state.attachmentDraftKey) return state.attachedFiles
    return key ? state.attachmentDrafts.get(key) ?? NO_ATTACHMENTS : NO_ATTACHMENTS
  })
}

subscribeChatDraftDeletion((identity) => {
  useInputStore.getState().setAttachedFiles([], identity)
})
