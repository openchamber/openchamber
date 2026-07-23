const STORAGE_KEY = "openchamber_sync_perf"

declare global {
  interface Window {
    __openchamberSyncPerformance?: {
      getSnapshot: () => SyncPerformanceCounters | null
      reset: () => void
    }
  }
}

export type SyncPerformanceCounters = {
  pipelineRawEvents: number
  pipelineCoalescedEvents: number
  pipelineDeliveredEvents: number
  reducerEvents: number
  reducerChangedEvents: number
  directoryStorePublications: number
  streamingFullReconciliations: number
  streamingIncrementalReconciliations: number
  streamingStatusEntriesVisited: number
  streamingSessionCandidatesVisited: number
  streamingMessagesVisited: number
  streamingHeartbeatAttempts: number
  streamingHeartbeatCommits: number
  permissionChangeCallbacks: number
  sessionMessageChangeCallbacks: number
  sessionRenderableNotificationSkips: number
  userMessageHistoryNotificationSkips: number
  sessionMessageRecordNotificationSkips: number
  materializationEnqueues: number
  materializationEmptyAssistantEnqueues: number
  materializationMissingMessageEnqueues: number
  materializationMissingPartEnqueues: number
  materializationLifecycleEnqueues: number
  materializationPreflightSkips: number
  materializationRequests: number
  statusAggregationSessionEntries: number
  statusAggregationCandidates: number
  persistenceSerializations: number
  persistenceStorageWrites: number
  persistenceUtf8Bytes: number
}

const createCounters = (): SyncPerformanceCounters => ({
  pipelineRawEvents: 0,
  pipelineCoalescedEvents: 0,
  pipelineDeliveredEvents: 0,
  reducerEvents: 0,
  reducerChangedEvents: 0,
  directoryStorePublications: 0,
  streamingFullReconciliations: 0,
  streamingIncrementalReconciliations: 0,
  streamingStatusEntriesVisited: 0,
  streamingSessionCandidatesVisited: 0,
  streamingMessagesVisited: 0,
  streamingHeartbeatAttempts: 0,
  streamingHeartbeatCommits: 0,
  permissionChangeCallbacks: 0,
  sessionMessageChangeCallbacks: 0,
  sessionRenderableNotificationSkips: 0,
  userMessageHistoryNotificationSkips: 0,
  sessionMessageRecordNotificationSkips: 0,
  materializationEnqueues: 0,
  materializationEmptyAssistantEnqueues: 0,
  materializationMissingMessageEnqueues: 0,
  materializationMissingPartEnqueues: 0,
  materializationLifecycleEnqueues: 0,
  materializationPreflightSkips: 0,
  materializationRequests: 0,
  statusAggregationSessionEntries: 0,
  statusAggregationCandidates: 0,
  persistenceSerializations: 0,
  persistenceStorageWrites: 0,
  persistenceUtf8Bytes: 0,
})

const readInitialEnabled = (): boolean => {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

let activeCounters: SyncPerformanceCounters | null = readInitialEnabled() ? createCounters() : null

export function setSyncPerformanceDiagnosticsEnabled(enabled: boolean): void {
  activeCounters = enabled ? createCounters() : null
}

export function resetSyncPerformanceDiagnostics(): void {
  if (activeCounters) activeCounters = createCounters()
}

export function getSyncPerformanceDiagnostics(): SyncPerformanceCounters | null {
  return activeCounters ? { ...activeCounters } : null
}

export function countSyncPerformance(
  counter: keyof SyncPerformanceCounters,
  amount = 1,
): void {
  const counters = activeCounters
  if (!counters) return
  counters[counter] += amount
}

export function countSyncPersistenceSerialization(serialized: string): void {
  const counters = activeCounters
  if (!counters) return
  counters.persistenceSerializations += 1
  counters.persistenceUtf8Bytes += new TextEncoder().encode(serialized).byteLength
}

export function countSyncPersistenceStorageWrite(): void {
  if (activeCounters) activeCounters.persistenceStorageWrites += 1
}

if (typeof window !== "undefined") {
  window.__openchamberSyncPerformance = {
    getSnapshot: getSyncPerformanceDiagnostics,
    reset: resetSyncPerformanceDiagnostics,
  }
}
