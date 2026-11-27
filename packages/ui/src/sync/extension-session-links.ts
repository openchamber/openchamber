import { opencodeClient } from "@/lib/opencode/client"
import { withSessionMetadata } from "@/lib/opencode/projection"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getSessionMetadata } from "@/lib/sessionReviewMetadata"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { findLiveSession, mirrorSessionIntoLiveStores } from "./session-actions"
import { requestExtensionSessionLinksUpdate, type ExtensionLinksOperation } from "./session-archive-batch"

export async function updateExtensionSessionLinks(sessionId: string, directory: string, operation: ExtensionLinksOperation) {
  const runtimeKey = getRuntimeKey()
  const held = () => useGlobalSessionsStore.getState().entityById.get(sessionId) ?? findLiveSession(sessionId)
  const before = held()
  const result = await requestExtensionSessionLinksUpdate(sessionId, operation, directory)
  if (result.outcome !== "updated" || getRuntimeKey() !== runtimeKey) return result
  const current = held()
  if (!current) return result

  let metadata = result.metadata
  if (current.metadata !== before?.metadata) {
    const fresh = await opencodeClient.getSession(sessionId, current.directory).catch(() => null)
    if (!fresh || getRuntimeKey() !== runtimeKey || held() !== current) return result
    metadata = getSessionMetadata(fresh)
  }
  const updated = withSessionMetadata(current, metadata)
  useGlobalSessionsStore.getState().upsertSession(updated)
  mirrorSessionIntoLiveStores(updated, current.directory)
  return result
}
