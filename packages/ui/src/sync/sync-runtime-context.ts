import React, { createContext, useContext } from "react"
import type { OpenCodeClient } from "@opencode/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"

export type { OpenCodeClient }

export type CurrentDirectorySource = {
  get: () => string
  subscribe: (notify: () => void) => () => void
}

export type SyncRuntime = {
  childStores: ChildStoreManager
  messageLoader: SessionMessageLoader
  runtimeKey: string
  sdk: OpenCodeClient
  currentDirectory: CurrentDirectorySource
}

export type SyncSystem = SyncRuntime & {
  directory: string
}

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"

const SYNC_RUNTIME_CONTEXT_GLOBAL_KEY = "__openchamber_sync_runtime_context__"

type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
  [SYNC_RUNTIME_CONTEXT_GLOBAL_KEY]?: React.Context<SyncRuntime | null>
}

const syncGlobal = globalThis as SyncGlobal

export const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)

syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext

export const SyncRuntimeContext = syncGlobal[SYNC_RUNTIME_CONTEXT_GLOBAL_KEY] ?? createContext<SyncRuntime | null>(null)

syncGlobal[SYNC_RUNTIME_CONTEXT_GLOBAL_KEY] = SyncRuntimeContext

export function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

export function useSyncRuntime() {
  const ctx = useContext(SyncRuntimeContext)
  if (!ctx) throw new Error("useSyncRuntime must be used within <SyncProvider>")
  return ctx
}
