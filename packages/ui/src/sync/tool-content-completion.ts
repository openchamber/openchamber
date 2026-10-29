import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { materializeSessionSnapshots, type MaterializedMessageRecord } from "./materialization"
import { getSyncChildStores } from "./sync-refs"

type CompletionTarget = { directory: string; sessionID: string }

const completions = new Map<string, Promise<MaterializedMessageRecord | null>>()

/**
 * Replaces a message whose finished tool results arrived as shells
 * (`lib/opencode/toolContentShells.ts`) with the whole message, read by id.
 * Rows of one message share the request. It rejects when the message could
 * not be read, so a row can offer a retry instead of presenting a missing
 * result as an empty one.
 *
 * A message the store no longer holds (revert, cache eviction) is not brought
 * back: the read is returned instead, so the row renders it without growing
 * the store. A merge into the store returns `null`. A runtime switch discards
 * the answer.
 */
export function completeToolContent(
  target: CompletionTarget,
  messageID: string,
): Promise<MaterializedMessageRecord | null> {
  const runtimeKey = getRuntimeKey()
  const key = `${runtimeKey}\u0000${target.directory}\u0000${target.sessionID}\u0000${messageID}`
  const pending = completions.get(key)
  if (pending) return pending
  const completion = opencodeClient.getSessionMessage(target.sessionID, messageID, target.directory)
    .then((record) => {
      if (getRuntimeKey() !== runtimeKey) return null
      const store = getSyncChildStores().ensureChild(target.directory, { bootstrap: false })
      const state = store.getState()
      if (!state.message[target.sessionID]?.some((message) => message.id === messageID)) return record
      const materialized = materializeSessionSnapshots(state, target.sessionID, [record], { mode: "merge" })
      // Unchanged containers keep their references, so setting both is safe.
      if (materialized.messagesChanged || materialized.partsChanged) {
        store.setState({ message: materialized.message, part: materialized.part })
      }
      return null
    })
    .finally(() => completions.delete(key))
  completions.set(key, completion)
  return completion
}
