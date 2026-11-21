import { opencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { toolContentShellChars } from "@/lib/opencode/toolContentShells"
import { materializeSessionSnapshots } from "./materialization"
import { getSyncChildStores } from "./sync-refs"

type CompletionTarget = {
  directory: string
  storeDirectory?: string
  sessionID: string
}

const completions = new Map<string, Promise<void>>()

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
      if (materialized.messagesChanged || materialized.partsChanged) {
        store.setState({ message: materialized.message, part: materialized.part })
      }
    })
    .finally(() => completions.delete(key))
  completions.set(key, completion)
  return completion
}
