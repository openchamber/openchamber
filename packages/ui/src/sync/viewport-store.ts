/**
 * Viewport Store — per-session scroll anchors, streaming state, memory.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"

export type SessionMemoryState = {
  viewportAnchor: number
  isStreaming: boolean
  streamStartTime?: number
  lastAccessedAt: number
  backgroundMessageCount: number
  loadedTurnCount?: number
  hasMoreAbove?: boolean
  hasMoreTurnsAbove?: boolean
  historyLoading?: boolean
  historyComplete?: boolean
  historyLimit?: number
  totalAvailableMessages?: number
  streamingCooldownUntil?: number
  isZombie?: boolean
  lastUserMessageAt?: number
}

export type ViewportState = {
  sessionMemoryState: Map<string, SessionMemoryState>
  isSyncing: boolean

  updateViewportAnchor: (sessionId: string, anchor: number) => void
}

export const useViewportStore = create<ViewportState>()((set) => ({
  sessionMemoryState: new Map(),
  isSyncing: false,

  updateViewportAnchor: (sessionId, anchor) =>
    set((s) => {
      const map = new Map(s.sessionMemoryState)
      const existing = map.get(sessionId) ?? {
        viewportAnchor: 0,
        isStreaming: false,
        lastAccessedAt: Date.now(),
        backgroundMessageCount: 0,
      }
      map.set(sessionId, { ...existing, viewportAnchor: anchor, lastAccessedAt: Date.now() })
      return { sessionMemoryState: map }
    }),
}))
