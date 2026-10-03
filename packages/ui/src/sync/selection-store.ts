/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { z } from "zod"
import { createDeferredSafeJSONStorage } from "@/stores/utils/safeStorage"
import { getRuntimeKey } from "@/lib/runtime-switch"

type ModelSelection = { providerId: string; modelId: string }
type LastUsedProvider = { providerID: string; modelID: string }
type VariantSelections = Map<string, Map<string, Map<string, string | null>>>
const variantEntriesSchema = z.array(z.tuple([
  z.string(), z.array(z.tuple([
    z.string(), z.array(z.tuple([z.string(), z.string().nullable()])),
  ])),
]))
const modelSelectionSchema = z.object({ providerId: z.string(), modelId: z.string() })
const persistedSelectionSchema = z.object({
  sessionModelSelections: z.array(z.tuple([z.string(), modelSelectionSchema])).optional().catch(undefined),
  sessionAgentSelections: z.array(z.tuple([z.string(), z.string()])).optional().catch(undefined),
  sessionAgentModelSelections: z.array(z.tuple([
    z.string(), z.array(z.tuple([z.string(), modelSelectionSchema])),
  ])).optional().catch(undefined),
  agentModelVariantSelections: variantEntriesSchema.optional().catch(undefined),
  lastUsedProvider: z.object({ providerID: z.string(), modelID: z.string() }).nullable().optional().catch(undefined),
})

export type SelectionState = {
  sessionModelSelections: Map<string, ModelSelection>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, ModelSelection>>
  agentModelVariantSelections: VariantSelections
  lastUsedProvider: LastUsedProvider | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  clearSessionSelections: (sessionId: string) => void
  /**
   * `variant` is the effort chosen for this agent/model in this session:
   * a name, `null` for an explicit "Default" (send no effort), or `undefined`
   * to forget the choice so the inherited default applies again.
   */
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | null | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | null | undefined
}

// Maximum number of sessions to persist to local storage to prevent unbounded growth
const MAX_PERSISTED_SESSIONS = 150
const variantSessionKey = (sessionId: string) => JSON.stringify([getRuntimeKey(), sessionId])

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      agentModelVariantSelections: new Map(),
      lastUsedProvider: null,

      saveSessionModelSelection: (sessionId, providerId, modelId) =>
        set((s) => {
          const map = new Map(s.sessionModelSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, { providerId, modelId })
          return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
        }),

      getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

      saveSessionAgentSelection: (sessionId, agentName) =>
        set((s) => {
          if (s.sessionAgentSelections.get(sessionId) === agentName) return s
          const map = new Map(s.sessionAgentSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
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

          outer.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          inner.set(agentName, { providerId, modelId })
          outer.set(sessionId, inner)

          return { sessionAgentModelSelections: outer }
        }),

      getAgentModelForSession: (sessionId, agentName) =>
        get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

      clearSessionSelections: (sessionId) => set((state) => {
        const variantKey = variantSessionKey(sessionId)
        const hadVariant = state.agentModelVariantSelections.has(variantKey)
        if (!hadVariant && !state.sessionModelSelections.has(sessionId)
          && !state.sessionAgentSelections.has(sessionId)
          && !state.sessionAgentModelSelections.has(sessionId)) return state
        const sessionModelSelections = new Map(state.sessionModelSelections)
        const sessionAgentSelections = new Map(state.sessionAgentSelections)
        const sessionAgentModelSelections = new Map(state.sessionAgentModelSelections)
        const agentModelVariantSelections = new Map(state.agentModelVariantSelections)
        sessionModelSelections.delete(sessionId)
        sessionAgentSelections.delete(sessionId)
        sessionAgentModelSelections.delete(sessionId)
        agentModelVariantSelections.delete(variantKey)
        return { sessionModelSelections, sessionAgentSelections, sessionAgentModelSelections, agentModelVariantSelections }
      }),

      saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) => set((state) => {
        const key = `${providerId}/${modelId}`
        const sessionKey = variantSessionKey(sessionId)
        if (state.agentModelVariantSelections.get(sessionKey)?.get(agentName)?.get(key) === variant) return state
        const selections = new Map(state.agentModelVariantSelections)
        const agentMap = new Map(selections.get(sessionKey))
        const modelMap = new Map(agentMap.get(agentName))
        if (variant === undefined) {
          modelMap.delete(key)
        } else {
          modelMap.set(key, variant)
        }
        if (modelMap.size) agentMap.set(agentName, modelMap)
        else agentMap.delete(agentName)
        selections.delete(sessionKey)
        if (agentMap.size) selections.set(sessionKey, agentMap)
        return { agentModelVariantSelections: selections }
      }),

      getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
        const key = `${providerId}/${modelId}`
        return get().agentModelVariantSelections.get(variantSessionKey(sessionId))?.get(agentName)?.get(key)
      },
    }),
    {
      name: "selection-store",
      version: 1,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => {
        // Convert Maps to arrays and slice to keep only the most recent MAX_PERSISTED_SESSIONS
        const models = Array.from(state.sessionModelSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agents = Array.from(state.sessionAgentSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agentModels = Array.from(state.sessionAgentModelSelections.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())])

        return {
          sessionModelSelections: models,
          sessionAgentSelections: agents,
          sessionAgentModelSelections: agentModels,
          agentModelVariantSelections: Array.from(state.agentModelVariantSelections)
            .slice(-MAX_PERSISTED_SESSIONS)
            .map(([sessionId, agents]) => [sessionId, Array.from(agents, ([agent, models]) => [agent, Array.from(models)])]),
          lastUsedProvider: state.lastUsedProvider,
        }
      },
      merge: (persistedState, currentState) => {
        const parsed = persistedSelectionSchema.safeParse(persistedState)
        if (!parsed.success) return currentState
        const persisted = parsed.data
        const agentModelSelections = persisted.sessionAgentModelSelections
          ? new Map<string, Map<string, ModelSelection>>()
          : currentState.sessionAgentModelSelections
        const agentModelVariantSelections: VariantSelections = persisted.agentModelVariantSelections
          ? new Map(persisted.agentModelVariantSelections.map(([sessionId, agents]) => [sessionId,
            new Map(agents.map(([agent, models]) => [agent, new Map(models)])),
          ]))
          : currentState.agentModelVariantSelections
        if (Array.isArray(persisted?.sessionAgentModelSelections)) {
          persisted.sessionAgentModelSelections.forEach(([sessionId, agentArray]) => {
            agentModelSelections.set(sessionId, new Map(agentArray))
          })
        }

        return {
          ...currentState,
          lastUsedProvider: persisted?.lastUsedProvider ?? currentState.lastUsedProvider,
          sessionModelSelections: persisted.sessionModelSelections ? new Map(persisted.sessionModelSelections) : currentState.sessionModelSelections,
          sessionAgentSelections: persisted.sessionAgentSelections ? new Map(persisted.sessionAgentSelections) : currentState.sessionAgentSelections,
          sessionAgentModelSelections: agentModelSelections,
          agentModelVariantSelections,
        }
      },
      migrate: (persistedState) => {
        // Scaffold for future schema migrations
        return persistedState
      }
    }
  )
)
