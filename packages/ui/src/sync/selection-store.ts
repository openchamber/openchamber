/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"

export type SelectionState = {
  sessionModelSelections: Map<string, { providerId: string; modelId: string }>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>
  sessionBackendSelections: Map<string, string>
  lastUsedProvider: { providerID: string; modelID: string } | null
  draftBackendId: string | null
  lastUsedBackendId: string | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
  saveSessionBackendSelection: (sessionId: string, backendId: string) => void
  getSessionBackendSelection: (sessionId: string) => string | null
  setDraftBackendId: (backendId: string | null) => void
}

// In-memory variant storage (not persisted)
const agentModelVariantSelections = new Map<string, Map<string, Map<string, string>>>()

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  sessionModelSelections: new Map(),
  sessionAgentSelections: new Map(),
  sessionAgentModelSelections: new Map(),
  sessionBackendSelections: new Map(),
  lastUsedProvider: null,
  draftBackendId: null,
  lastUsedBackendId: null,

  saveSessionModelSelection: (sessionId, providerId, modelId) =>
    set((s) => {
      const map = new Map(s.sessionModelSelections)
      map.set(sessionId, { providerId, modelId })
      return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
    }),

  getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

  saveSessionAgentSelection: (sessionId, agentName) =>
    set((s) => {
      if (s.sessionAgentSelections.get(sessionId) === agentName) return s
      const map = new Map(s.sessionAgentSelections)
      map.set(sessionId, agentName)
      return { sessionAgentSelections: map }
    }),

  getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

  saveAgentModelForSession: (sessionId, agentName, providerId, modelId) =>
    set((s) => {
      const existing = s.sessionAgentModelSelections.get(sessionId)?.get(agentName)
      if (existing?.providerId === providerId && existing?.modelId === modelId) return s
      const outer = new Map(s.sessionAgentModelSelections)
      const inner = new Map(outer.get(sessionId) ?? new Map())
      inner.set(agentName, { providerId, modelId })
      outer.set(sessionId, inner)
      return { sessionAgentModelSelections: outer }
    }),

  getAgentModelForSession: (sessionId, agentName) =>
    get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

  saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => {
    if (!variant) return
    const key = `${providerId}/${modelId}`
    let agentMap = agentModelVariantSelections.get(sessionId)
    if (!agentMap) {
      agentMap = new Map()
      agentModelVariantSelections.set(sessionId, agentMap)
    }
    let modelMap = agentMap.get(agentName)
    if (!modelMap) {
      modelMap = new Map()
      agentMap.set(agentName, modelMap)
    }
    modelMap.set(key, variant)
  },

  getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
    const key = `${providerId}/${modelId}`
    return agentModelVariantSelections.get(sessionId)?.get(agentName)?.get(key)
  },

  saveSessionBackendSelection: (sessionId, backendId) =>
    set((s) => {
      if (!backendId || s.sessionBackendSelections.get(sessionId) === backendId) {
        return s
      }
      const map = new Map(s.sessionBackendSelections)
      map.set(sessionId, backendId)
      return { sessionBackendSelections: map, lastUsedBackendId: backendId }
    }),

  getSessionBackendSelection: (sessionId) => get().sessionBackendSelections.get(sessionId) ?? null,

  setDraftBackendId: (backendId) =>
    set(() => ({
      draftBackendId: backendId,
      lastUsedBackendId: backendId,
    })),
}))
