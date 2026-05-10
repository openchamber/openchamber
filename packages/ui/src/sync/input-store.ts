/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"

const FILE_URI_PREFIX = "file://"
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

const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as string)
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
  reader.onabort = () => reject(new Error("File read aborted"))
  reader.readAsDataURL(file)
})

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
}

export type VSCodeActiveEditorFile = {
  filePath: string
  fileName: string
  relativePath: string
  fileSize: number | null
  selection: { startLine: number; endLine: number; text: string } | null
}

export type InputState = {
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  pendingSyntheticParts: SyntheticContextPart[] | null
  attachedFiles: AttachedFile[]
  activeEditorFile: VSCodeActiveEditorFile | null

  setPendingInputText: (text: string | null, mode?: "replace" | "append" | "append-inline") => void
  consumePendingInputText: () => { text: string; mode: "replace" | "append" | "append-inline" } | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  addAttachedFile: (file: File) => Promise<void>
  removeAttachedFile: (id: string) => void
  setAttachedFiles: (files: AttachedFile[]) => void
  clearAttachedFiles: () => void
  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => void
  addVSCodeSelectionAttachment: (path: string, file: File) => Promise<void>
  setActiveEditorFile: (file: VSCodeActiveEditorFile | null) => void
}

export const useInputStore = create<InputState>()((set, get) => ({
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingSyntheticParts: null,
  attachedFiles: [],
  activeEditorFile: null,

  setPendingInputText: (text, mode = "replace") =>
    set({ pendingInputText: text, pendingInputMode: mode }),

  consumePendingInputText: () => {
    const { pendingInputText, pendingInputMode } = get()
    if (pendingInputText === null) return null
    set({ pendingInputText: null, pendingInputMode: "replace" })
    return { text: pendingInputText, mode: pendingInputMode }
  },

  setPendingSyntheticParts: (parts) => set({ pendingSyntheticParts: parts }),

  consumePendingSyntheticParts: () => {
    const { pendingSyntheticParts } = get()
    if (pendingSyntheticParts !== null) {
      set({ pendingSyntheticParts: null })
    }
    return pendingSyntheticParts
  },

  addAttachedFile: async (file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const generation = attachmentReadGeneration
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
    } catch {
      return
    }
    if (generation !== attachmentReadGeneration) return
    const attached: AttachedFile = {
      id,
      file,
      dataUrl,
      mimeType: file.type,
      filename: file.name,
      size: file.size,
      source: "local",
    }
    set((s) => ({ attachedFiles: [...s.attachedFiles, attached] }))
  },

  removeAttachedFile: (id) =>
    set((s) => ({ attachedFiles: s.attachedFiles.filter((f) => f.id !== id) })),

  setAttachedFiles: (files) => {
    attachmentReadGeneration += 1
    set({ attachedFiles: files })
  },

  clearAttachedFiles: () => {
    attachmentReadGeneration += 1
    set({ attachedFiles: [] })
  },

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
    const selectionKey = getVSCodeSelectionKey(path, file.name)
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === file.name && f.vscodePath === path
    )
    if (isDuplicate || pendingVSCodeSelectionKeys.has(selectionKey)) return
    pendingVSCodeSelectionKeys.add(selectionKey)
    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
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
}))
