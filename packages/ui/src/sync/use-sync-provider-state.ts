import React, { useEffect, useRef, useMemo } from "react"
import { ChildStoreManager } from "./child-store"
import { noteDeferredAnswersLoaded } from "./recoverable-questions"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { isDirectoryOfKnownSpace } from "@/lib/spaces/spaces-store"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { SessionMessageLoader, type SessionMessageTarget } from "./session-message-loader"
import { openCodeStartupSignal } from "./opencode-startup-gate"
import { type EventRoutingIndex, createEventRoutingIndex } from "./event-routing-index"
import type { CurrentDirectorySource, SyncRuntime } from "./sync-runtime-context"

type SyncStores = { childStores: ChildStoreManager; messageLoader: SessionMessageLoader }

const createSyncStores = (): SyncStores => {
  const childStores = new ChildStoreManager({ seedsSessions: isDirectoryOfKnownSpace })
  return {
    childStores,
    messageLoader: new SessionMessageLoader(childStores, { sdk: opencodeClient, runtimeKey: getRuntimeKey() }, openCodeStartupSignal),
  }
}

let syncStoresMadeBeforeMount: SyncStores | null = null

export function prefetchSessionBeforeMount(target: SessionMessageTarget): void {
  syncStoresMadeBeforeMount ??= createSyncStores()
  void syncStoresMadeBeforeMount.messageLoader.prefetch(target)
}

export function useSyncProviderState({
  props,
}: {
  props: { sdk: SyncRuntime["sdk"]; directory: string }
}) {
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const syncStoresRef = useRef<SyncStores | null>(null)
  if (!syncStoresRef.current) syncStoresRef.current = syncStoresMadeBeforeMount ?? createSyncStores()
  const { childStores, messageLoader } = syncStoresRef.current
  useEffect(() => {
    if (syncStoresMadeBeforeMount === syncStoresRef.current) syncStoresMadeBeforeMount = null
  }, [])
  useEffect(() => {
    const noteLoadedAnswers = () => {
      for (const store of childStores.children.values()) noteDeferredAnswersLoaded(store.getState().message)
    }
    noteLoadedAnswers()
    return childStores.subscribeAllSelected((state) => state.message, noteLoadedAnswers)
  }, [childStores])
  const runtimeKey = getRuntimeKey()
  const messageLoaderDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  messageLoader.configure({ sdk: opencodeClient, runtimeKey })
  useEffect(() => {
    opencodeClient.learnMessagePageShellsSupport()
  }, [runtimeKey])
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const currentDirectoryRef = useRef(props.directory)
  currentDirectoryRef.current = props.directory
  const currentDirectoryListenersRef = useRef(new Set<() => void>())
  const currentDirectorySource = useMemo<CurrentDirectorySource>(() => ({
    get: () => currentDirectoryRef.current,
    subscribe: (notify) => {
      currentDirectoryListenersRef.current.add(notify)
      return () => currentDirectoryListenersRef.current.delete(notify)
    },
  }), [])
  React.useLayoutEffect(() => {
    for (const notify of currentDirectoryListenersRef.current) notify()
  }, [props.directory])
  return { messageStreamTransport, childStores, messageLoader, runtimeKey, messageLoaderDisposalTimerRef, routingIndex, currentDirectoryRef, currentDirectorySource }
}
