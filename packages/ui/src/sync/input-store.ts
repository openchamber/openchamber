/**
 * Input Store — pending input text, synthetic parts, and attached files.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import type { AttachedFile } from "@/stores/types/sessionTypes"

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
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
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

  clearAttachedFiles: () => set({ attachedFiles: [] }),

  addVSCodeFileAttachment: (path: string, name: string, fileSize: number | null) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'file' && (f.vscodePath || '') === path
    )
    if (isDuplicate) return
    const dataUrl = `file://${path}`
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
    const isDuplicate = get().attachedFiles.some(
      (f) => f.source === 'vscode' && f.vscodeSource === 'selection' && f.filename === file.name && f.vscodePath === path
    )
    if (isDuplicate) return
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
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

  setActiveEditorFile: (file) => set({ activeEditorFile: file }),
}))
