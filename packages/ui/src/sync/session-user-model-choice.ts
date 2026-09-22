import type { Message, Part } from '@opencode-ai/sdk/v2'
import type { StoreApi } from 'zustand'
import { findLatestUserModelChoice, type UserModelChoice } from '@/lib/messages/userModelChoice'
import { subscribeDirectorySessionMessages, type DirectoryStore } from './child-store'

const EMPTY_MESSAGES: Message[] = []

/** A snapshot and subscription for the composer's latest complete, real prompt. */
export const createSessionUserModelChoiceSource = (store: StoreApi<DirectoryStore>, sessionID: string) => {
  let messages: Message[] | undefined
  let parts: DirectoryStore['part'] | undefined
  let choice: UserModelChoice | null = null
  // Only the candidate and the newer, incomplete/synthetic user messages can
  // change the answer. Assistant token events never inspect these buckets.
  const watchedParts = new Map<string, Part[] | undefined>()

  const getSnapshot = (): UserModelChoice | null => {
    if (!sessionID) return null
    const state = store.getState()
    const nextMessages = state.message[sessionID] ?? EMPTY_MESSAGES
    if (messages === nextMessages) {
      if (parts === state.part) return choice
      parts = state.part
      let changed = false
      for (const [id, previous] of watchedParts) {
        if (state.part[id] !== previous) {
          changed = true
          break
        }
      }
      if (!changed) return choice
    }

    messages = nextMessages
    parts = state.part
    watchedParts.clear()
    const next = findLatestUserModelChoice(messages, (id) => {
      const bucket = state.part[id]
      watchedParts.set(id, bucket)
      return bucket
    })
    if (
      next?.id !== choice?.id
      || next?.time.created !== choice?.time.created
      || next?.agent !== choice?.agent
      || next?.providerID !== choice?.providerID
      || next?.modelID !== choice?.modelID
      || next?.variant !== choice?.variant
    ) choice = next
    return choice
  }

  const subscribe = (notify: () => void) => {
    if (!sessionID) return () => undefined
    getSnapshot()
    return subscribeDirectorySessionMessages(store, sessionID, (change) => {
      if (!change.messagesChanged && !change.reset
        && !change.partMessageIDs.some((id) => watchedParts.has(id))) return
      const previous = choice
      if (getSnapshot() !== previous) notify()
    })
  }

  return { getSnapshot, subscribe }
}
