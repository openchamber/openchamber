import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { toolContentShellChars } from "@/lib/opencode/toolContentShells"
import { materializeSessionSnapshots } from "./materialization"
import { getSyncChildStores } from "./sync-refs"

type CompletionTarget = {
  /** The session's own directory: the read (and its parent walk) is routed there. */
  directory: string
  /**
   * The store the row renders from. A chat can show a session in another
   * directory's store than the session's own (a deep link without a directory,
   * a worktree beside the main checkout); completion must check and fill that
   * store, not the session's. Defaults to `directory`.
   */
  storeDirectory?: string
  sessionID: string
}

const completions = new Map<string, Promise<void>>()

/**
 * Replaces a message whose finished tool results arrived as shells
 * (`lib/opencode/toolContentShells.ts`) with the whole message, read by id.
 * Rows of one message share the request. It rejects when the message could
 * not be read, so a row can offer a retry instead of presenting a missing
 * result as an empty one. Only a message the row's store displays is
 * requested and merged: a store that no longer holds the message (revert,
 * cache eviction), or a message outside the displayed transcript, is not
 * brought back, and a runtime switch discards the answer.
 */
export function completeToolContent(target: CompletionTarget, messageID: string): Promise<void> {
  const runtimeKey = getRuntimeKey()
  const storeDirectory = target.storeDirectory ?? target.directory
  const key = `${runtimeKey}\u0000${target.directory}\u0000${storeDirectory}\u0000${target.sessionID}\u0000${messageID}`
  const pending = completions.get(key)
  if (pending) return pending
  const store = getSyncChildStores().getChild(storeDirectory)
  if (!store) return Promise.resolve()
  const state = store.getState()
  if (!state.message[target.sessionID]?.some((message) => message.id === messageID)
    || !state.part[messageID]?.some((part) => toolContentShellChars(part) !== null)) {
    return Promise.resolve()
  }
  const completion = opencodeClient.getToolContentMessage(target.sessionID, messageID, target.directory)
    .then((record) => {
      if (getRuntimeKey() !== runtimeKey) return
      if (getSyncChildStores().getChild(storeDirectory) !== store) return
      const current = store.getState()
      if (!current.message[target.sessionID]?.some((message) => message.id === messageID)) return
      const materialized = materializeSessionSnapshots(current, target.sessionID, [record], { mode: "merge" })
      // Unchanged containers keep their references, so setting both is safe.
      if (materialized.messagesChanged || materialized.partsChanged) {
        store.setState({ message: materialized.message, part: materialized.part })
      }
    })
    .finally(() => completions.delete(key))
  completions.set(key, completion)
  return completion
}
