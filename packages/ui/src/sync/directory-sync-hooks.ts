import React, { useEffect, useCallback, useMemo } from "react"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import { type DirectoryBootstrapReason, type DirectoryBootstrapPriority, type DirectoryStore } from "./child-store"
import type { State } from "./types"
import { EMPTY_SESSION_MESSAGE_LOAD_STATE, SessionMessageLoader, type SessionMessageLoadState } from "./session-message-loader"
import { useSyncRuntime, useSyncSystem } from "./sync-runtime-context"

export function useDirectoryStore(
  directory?: string,
  options?: {
    bootstrap?: boolean
    priority?: DirectoryBootstrapPriority
    reason?: DirectoryBootstrapReason
  },
): StoreApi<DirectoryStore> {
  const runtime = useSyncRuntime()
  const dir = React.useSyncExternalStore(
    runtime.currentDirectory.subscribe,
    () => directory ?? runtime.currentDirectory.get(),
  )
  const store = runtime.childStores.ensureChild(dir, options)

  useEffect(() => {
    runtime.childStores.pin(dir)
    return () => runtime.childStores.unpin(dir)
  }, [dir, runtime.childStores])

  return store
}

export function useSessionMessageLoader(): SessionMessageLoader {
  return useSyncRuntime().messageLoader
}

export function useSessionMessageLoadState(sessionID: string, directory?: string): SessionMessageLoadState {
  const system = useSyncSystem()
  const runtimeKey = system.runtimeKey
  const target = useMemo(() => ({ directory: directory ?? system.directory, sessionID }), [directory, sessionID, system.directory])
  return React.useSyncExternalStore(
    useCallback((notify) => {
      void runtimeKey
      return sessionID && target.directory ? system.messageLoader.subscribe(target, notify) : () => undefined
    }, [sessionID, system.messageLoader, runtimeKey, target]),
    useCallback(() => {
      void runtimeKey
      return sessionID && target.directory
        ? system.messageLoader.getSnapshot(target)
        : EMPTY_SESSION_MESSAGE_LOAD_STATE
    }, [sessionID, system.messageLoader, runtimeKey, target]),
    useCallback(() => EMPTY_SESSION_MESSAGE_LOAD_STATE, []),
  )
}

export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

export function useSyncDirectory() {
  return useSyncSystem().directory
}

export function useChildStoreManager() {
  return useSyncRuntime().childStores
}
