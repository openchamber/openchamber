import type { StoreApi } from "zustand"
import { type SyncEvent } from "@/lib/opencode/events"
import { type DirectoryStore } from "./child-store"
import { countSyncPerformance } from "./performance-diagnostics"
import { applyRecoverableQuestionEvents } from "./recoverable-questions"
import { adoptSessionMove } from "./session-actions"
import { applySessionEventsToGlobalSessions } from "./session-event-router"
import { applyGlobalSessionStatusEvents } from "./global-session-status"
import { applyGlobalBlockingRequestEvents } from "./global-blocking-requests"
import { applyBackgroundShellEvents } from "./background-shells"
import { applyBackgroundImageEvents } from "./background-images"
import { applySessionLiveWorkEvents } from "./session-live-work"
import { applyReplyCommandEvents } from "./reply-commands"
import type { State } from "./types"

export type SessionMove = { sessionID: string; from: string; to: string }

export type DirectoryEventBatch = {
  states: Map<StoreApi<DirectoryStore>, DirectoryStore>
  clonedFields: Map<StoreApi<DirectoryStore>, Set<keyof State>>
  changedStores: Set<StoreApi<DirectoryStore>>
  globalSessionEvents: SyncEvent[]
  globalStatusEventsByDirectory: Map<string, SyncEvent[]>
  sessionMoves: SessionMove[]
}

export const createDirectoryEventBatch = (): DirectoryEventBatch => ({
  states: new Map(),
  clonedFields: new Map(),
  changedStores: new Set(),
  globalSessionEvents: [],
  globalStatusEventsByDirectory: new Map(),
  sessionMoves: [],
})

export const getDirectoryEventState = (
  store: StoreApi<DirectoryStore>,
  batch?: DirectoryEventBatch,
): DirectoryStore => batch?.states.get(store) ?? store.getState()

export const publishDirectoryEventBatch = (batch: DirectoryEventBatch): void => {
  applySessionEventsToGlobalSessions(batch.globalSessionEvents)
  for (const [directory, events] of batch.globalStatusEventsByDirectory) {
    applyBackgroundShellEvents(directory, events)
    applyBackgroundImageEvents(directory, events)
    applySessionLiveWorkEvents(events)
    applyReplyCommandEvents(events)
    applyGlobalSessionStatusEvents(directory, events)
    applyGlobalBlockingRequestEvents(directory, events)
    applyRecoverableQuestionEvents(directory, events)
  }
  for (const store of batch.changedStores) {
    const state = batch.states.get(store)
    if (!state) continue
    countSyncPerformance("directoryStorePublications")
    store.setState(state)
  }
  for (const move of batch.sessionMoves) adoptSessionMove(move.sessionID, move.from, move.to)
}
