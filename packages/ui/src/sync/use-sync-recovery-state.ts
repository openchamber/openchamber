import { useRef } from "react"
import { type DirectoryReadBackoff } from "./sync-watchdog-policy"

export function useSyncRecoveryState() {
  const lastStreamActivityAtRef = useRef(0)
  const lastStatusPollAtByDirectoryRef = useRef(new Map<string, number>())
  const statusPollBackoffByDirectoryRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const childDiscoveryDueAtByDirectoryRef = useRef(new Map<string, number>())
  const staleResyncBackoffByDirectoryRef = useRef<DirectoryReadBackoff>(new Map())
  const childDiscoveryBackoffByDirectoryRef = useRef<DirectoryReadBackoff>(new Map())
  const resyncingDirectoriesRef = useRef(new Set<string>())
  const blockingRequestResyncingDirectoriesRef = useRef(new Set<string>())
  const pipelineReconnectRef = useRef<((reason?: string) => void) | null>(null)
  const pipelineHasConnectedRef = useRef(false)
  const pipelineDisconnectedBeforeFirstConnectRef = useRef(false)
  return { lastStreamActivityAtRef, lastStatusPollAtByDirectoryRef, statusPollBackoffByDirectoryRef, lastFullResyncAtByDirectoryRef, childDiscoveryDueAtByDirectoryRef, staleResyncBackoffByDirectoryRef, childDiscoveryBackoffByDirectoryRef, resyncingDirectoriesRef, blockingRequestResyncingDirectoriesRef, pipelineReconnectRef, pipelineHasConnectedRef, pipelineDisconnectedBeforeFirstConnectRef }
}
