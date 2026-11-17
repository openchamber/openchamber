import React, { useEffect, useRef } from "react"
import type { SyncRuntime } from "./sync-runtime-context"
import { ChildStoreManager } from "./child-store"
import { useSessionUIStore } from "./session-ui-store"
import { opencodeClient } from "@/lib/opencode/client"
import { CHAT_LOCATION_RELEASE_DELAY_MS, PROJECT_LOCATION_RELEASE_DELAY_MS, WORKTREE_LOCATION_RELEASE_DELAY_MS, createRealLocationRelease, directoryUse, isWorktreeDirectory, type LocationRelease } from "./location-release"
import { subscribeSessionAssistSettled } from "./pending-session-assists"
import { isChatDirectoryPath } from "@/lib/chatDirectories"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { isDirectoryExternallyViewed } from "./viewed-sessions"

export function useSyncLocationRelease({
  props,
  currentDirectoryRef,
  childStores,
}: {
  props: { sdk: SyncRuntime["sdk"]; directory: string }
  currentDirectoryRef: React.RefObject<string>
  childStores: ChildStoreManager
}) {
  const locationReleaseRef = useRef<LocationRelease | null>(null)
  const previousDirectoryRef = useRef(props.directory)
  useEffect(() => {
    const expectedRuntimeKey = getRuntimeKey()
    const sdkEpoch = opencodeClient.getSdkClient()
    const release = createRealLocationRelease({
      releaseDelayMs: (directory) => {
        if (isChatDirectoryPath(directory)) return CHAT_LOCATION_RELEASE_DELAY_MS
        if (isWorktreeDirectory(directory, useSessionUIStore.getState().availableWorktreesByProject)) {
          return WORKTREE_LOCATION_RELEASE_DELAY_MS
        }
        return PROJECT_LOCATION_RELEASE_DELAY_MS
      },
      isCurrentDirectory: (directory) => directory === currentDirectoryRef.current,
      directoryUse: (directory) => isDirectoryExternallyViewed(directory)
        ? "busy"
        : directoryUse(directory, childStores.getChild(directory)?.getState()),
      release: async (directory) => {
        if (getRuntimeKey() !== expectedRuntimeKey || opencodeClient.getSdkClient() !== sdkEpoch) return
        await opencodeClient.releaseLocation(directory)
      },
    })
    locationReleaseRef.current = release
    const unsubscribeAssistSettled = subscribeSessionAssistSettled((isSettledDirectory) => release.recheck(isSettledDirectory))
    return () => {
      unsubscribeAssistSettled()
      release.dispose()
      if (locationReleaseRef.current === release) locationReleaseRef.current = null
    }
  }, [childStores, currentDirectoryRef, props.sdk])
  useEffect(() => {
    const previous = previousDirectoryRef.current
    previousDirectoryRef.current = props.directory
    locationReleaseRef.current?.directoryChanged(previous, props.directory)
  }, [props.directory])
}
