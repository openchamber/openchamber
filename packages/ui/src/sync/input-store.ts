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

export type InputState = {
  pendingInputText: string | null
  pendingInputMode: "replace" | "append" | "append-inline"
  pendingSyntheticParts: SyntheticContextPart[] | null
  attachedFiles: AttachedFile[]

  setPendingInputText: (text: string | null, mode?: "replace" | "append" | "append-inline") => void
  consumePendingInputText: () => { text: string; mode: "replace" | "append" | "append-inline" } | null
  setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void
  consumePendingSyntheticParts: () => SyntheticContextPart[] | null
  addAttachedFile: (file: File) => Promise<void>
  removeAttachedFile: (id: string) => void
  clearAttachedFiles: () => void
}

export const useInputStore = create<InputState>()((set, get) => ({
  pendingInputText: null,
  pendingInputMode: "replace",
  pendingSyntheticParts: null,
  attachedFiles: [],

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
}))
