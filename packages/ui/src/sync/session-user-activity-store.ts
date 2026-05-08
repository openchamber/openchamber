import { create } from "zustand"

type SessionUserActivityState = {
  lastUserMessageAtBySession: Map<string, number>
  recordRootUserMessage: (sessionId: string, timestamp: number) => void
  removeSession: (sessionId: string) => void
}

export const useSessionUserActivityStore = create<SessionUserActivityState>((set, get) => ({
  lastUserMessageAtBySession: new Map(),

  recordRootUserMessage: (sessionId, timestamp) => {
    const current = get().lastUserMessageAtBySession.get(sessionId)
    if (typeof current === "number" && current >= timestamp) {
      return
    }

    const next = new Map(get().lastUserMessageAtBySession)
    next.set(sessionId, timestamp)
    set({ lastUserMessageAtBySession: next })
  },

  removeSession: (sessionId) => {
    if (!get().lastUserMessageAtBySession.has(sessionId)) {
      return
    }

    const next = new Map(get().lastUserMessageAtBySession)
    next.delete(sessionId)
    set({ lastUserMessageAtBySession: next })
  },
}))

export function recordRootSessionUserMessageAt(sessionId: string, timestamp: number) {
  useSessionUserActivityStore.getState().recordRootUserMessage(sessionId, timestamp)
}

export function removeRootSessionUserActivity(sessionId: string) {
  useSessionUserActivityStore.getState().removeSession(sessionId)
}
