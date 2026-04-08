// Core utilities
export { Binary } from "./binary"
export { retry, type RetryOptions } from "./retry"

// Types
export type { State, GlobalState, ProjectMeta, DirState, EvictPlan, DisposeCheck, ChildOptions } from "./types"
export {
  INITIAL_STATE,
  INITIAL_GLOBAL_STATE,
  MAX_DIR_STORES,
  DIR_IDLE_TTL_MS,
  SESSION_CACHE_LIMIT,
  SESSION_RECENT_LIMIT,
  SESSION_RECENT_WINDOW,
} from "./types"

// Eviction
export { pickDirectoriesToEvict, canDisposeDirectory } from "./eviction"

// Session cache
export { dropSessionCaches, pickSessionCacheEvictions } from "./session-cache"

// Optimistic
export {
  applyOptimisticAdd,
  applyOptimisticRemove,
  mergeOptimisticPage,
  mergeMessages,
  type OptimisticItem,
  type OptimisticStore,
  type OptimisticAddInput,
  type OptimisticRemoveInput,
  type MessagePage,
} from "./optimistic"

// Event reducer
export {
  reduceGlobalEvent,
  applyGlobalProject,
  applyDirectoryEvent,
  type GlobalEventResult,
} from "./event-reducer"

// Event pipeline
export { createEventPipeline, type QueuedEvent, type FlushHandler } from "./event-pipeline"

// Stores
export { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
export { ChildStoreManager, type DirectoryStore } from "./child-store"

// Bootstrap
export { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"

// React integration
export {
  SyncProvider,
  useGlobalSync,
  useGlobalSyncSelector,
  useDirectoryStore,
  useDirectorySync,
  useSessionMessages,
  useSessionMessageCount,
  useSessionMessagesResolved,
  useSessionParts,
  useSessionStatus,
  useSessionPermissions,
  useSessionQuestions,
  useSessions,
  useSyncSDK,
  useSyncDirectory,
  useChildStoreManager,
  useSessionMessageRecords,
  useSessionTextMessages,
  useUserMessageHistory,
} from "./sync-context"

// Sync operations
export { useSync } from "./use-sync"

// Prompt submission
export { usePromptSubmit, type SubmitInput } from "./submit"


// Streaming lifecycle
export {
  useStreamingStore,
  updateStreamingState,
  selectStreamingMessageId,
  selectMessageStreamState,
  selectIsStreaming,
  type StreamPhase,
  type MessageStreamState,
  type StreamingStore,
} from "./streaming"

// Session UI state
export {
  useSessionUIStore,
  type SessionUIState,
  type AttachedFile,
  type NewSessionDraftState,
} from "./session-ui-store"

// Input store (pending input, synthetic parts, attached files)
export { useInputStore, type SyntheticContextPart } from "./input-store"

// Viewport store (per-session scroll anchors, memory state)
export {
  useViewportStore,
  type SessionMemoryState,
  type ViewportState,
} from "./viewport-store"

// Sync refs (imperative access from non-React code)
export {
  setSyncRefs,
  getSyncSDK,
  getSyncChildStores,
  getSyncDirectory,
  getDirectoryState,
  getSyncSessions,
  getSyncMessages,
  getSyncParts,
  getSyncSessionStatus,
  getSyncPermissions,
  getSyncQuestions,
} from "./sync-refs"

// Persisted metadata caches
export {
  readDirCache,
  persistVcs,
  persistProjectMeta,
  persistIcon,
  clearDirCache,
  type PersistedDirCache,
} from "./persist-cache"

// Session actions
export {
  setActionRefs,
  createSession,
  deleteSession,
  archiveSession,
  updateSessionTitle,
  shareSession,
  unshareSession,
  optimisticSend,
  compactSession,
  abortCurrentOperation,
  respondToPermission,
  dismissPermission,
  respondToQuestion,
  rejectQuestion,
  revertToMessage,
  forkFromMessage,
} from "./session-actions"
