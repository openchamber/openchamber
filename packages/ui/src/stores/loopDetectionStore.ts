import { create } from "zustand"
import { devtools, persist, createJSONStorage } from "zustand/middleware"
import { getSafeStorage } from "./utils/safeStorage"
import type { LoopPattern } from "@/lib/loop-detection/types"

interface LoopDetectionState {
  loopDetectionEnabled: Record<string, boolean>
  afkAutoResumeEnabled: Record<string, boolean>
  loopDetectedSessions: Record<string, boolean>
  loopRetryCount: Record<string, number>
  lastCleanMessageId: Record<string, string | undefined>
  loopPattern: Record<string, LoopPattern>

  setLoopDetectionEnabled: (sessionId: string, enabled: boolean) => void
  setAfkAutoResumeEnabled: (sessionId: string, enabled: boolean) => void
  setLoopDetected: (
    sessionId: string,
    detected: boolean,
    lastCleanMessageId?: string,
    pattern?: LoopPattern,
  ) => void
  incrementRetryCount: (sessionId: string) => number
  resetLoopState: (sessionId: string) => void
  isLoopDetectionEnabled: (sessionId: string) => boolean
  isAfkAutoResumeEnabled: (sessionId: string) => boolean
  isLoopDetected: (sessionId: string) => boolean
}

type LoopDetectionStore = LoopDetectionState

const getStorage = () => createJSONStorage(() => getSafeStorage())

export const useLoopDetectionStore = create<LoopDetectionStore>()(
  devtools(
    persist(
      (set, get) => ({
        loopDetectionEnabled: {},
        afkAutoResumeEnabled: {},
        loopDetectedSessions: {},
        loopRetryCount: {},
        lastCleanMessageId: {},
        loopPattern: {},

        setLoopDetectionEnabled: (sessionId, enabled) => {
          set((state) => {
            const loopDetectionEnabled = { ...state.loopDetectionEnabled }
            if (enabled) {
              loopDetectionEnabled[sessionId] = true
            } else {
              delete loopDetectionEnabled[sessionId]
            }
            return { loopDetectionEnabled }
          })
        },

        setAfkAutoResumeEnabled: (sessionId, enabled) => {
          set((state) => {
            const afkAutoResumeEnabled = { ...state.afkAutoResumeEnabled }
            if (enabled) {
              afkAutoResumeEnabled[sessionId] = true
            } else {
              delete afkAutoResumeEnabled[sessionId]
            }
            return { afkAutoResumeEnabled }
          })
        },

        setLoopDetected: (sessionId, detected, lastCleanMessageId, pattern) => {
          set((state) => {
            const loopDetectedSessions = { ...state.loopDetectedSessions }
            const lastCleanMessageIdMap = { ...state.lastCleanMessageId }
            const loopPatternMap = { ...state.loopPattern }
            if (detected) {
              loopDetectedSessions[sessionId] = true
              if (lastCleanMessageId) {
                lastCleanMessageIdMap[sessionId] = lastCleanMessageId
              }
              if (pattern) {
                loopPatternMap[sessionId] = pattern
              }
            } else {
              delete loopDetectedSessions[sessionId]
              delete lastCleanMessageIdMap[sessionId]
              delete loopPatternMap[sessionId]
            }
            return {
              loopDetectedSessions,
              lastCleanMessageId: lastCleanMessageIdMap,
              loopPattern: loopPatternMap,
            }
          })
        },

        incrementRetryCount: (sessionId) => {
          const count = (get().loopRetryCount[sessionId] ?? 0) + 1
          set((state) => {
            const loopRetryCount = { ...state.loopRetryCount }
            loopRetryCount[sessionId] = count
            return { loopRetryCount }
          })
          return count
        },

        resetLoopState: (sessionId) => {
          set((state) => {
            const loopDetectedSessions = { ...state.loopDetectedSessions }
            delete loopDetectedSessions[sessionId]
            const loopRetryCount = { ...state.loopRetryCount }
            delete loopRetryCount[sessionId]
            const lastCleanMessageId = { ...state.lastCleanMessageId }
            delete lastCleanMessageId[sessionId]
            const loopPattern = { ...state.loopPattern }
            delete loopPattern[sessionId]
            return {
              loopDetectedSessions,
              loopRetryCount,
              lastCleanMessageId,
              loopPattern,
            }
          })
        },

        isLoopDetectionEnabled: (sessionId) => {
          return get().loopDetectionEnabled[sessionId] === true
        },

        isAfkAutoResumeEnabled: (sessionId) => {
          return get().afkAutoResumeEnabled[sessionId] === true
        },

        isLoopDetected: (sessionId) => {
          return get().loopDetectedSessions[sessionId] === true
        },
      }),
      {
        name: "loop-detection-store",
        storage: getStorage(),
        partialize: (state) => ({
          loopDetectionEnabled: state.loopDetectionEnabled,
          afkAutoResumeEnabled: state.afkAutoResumeEnabled,
        }),
      },
    ),
    { name: "loop-detection-store" },
  ),
)
