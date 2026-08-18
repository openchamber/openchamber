import type { Message } from "@opencode-ai/sdk/v2/client"

const getCreatedAt = (message: Message): number => {
  const value = (message as { time?: { created?: unknown } }).time?.created
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Message IDs identify records; they are not chronology. OpenCode's sortable
 * ID timestamp rolls over, so a newly created `msg_000...` can follow a legacy
 * `msg_fff...`. Creation time is the authoritative transcript order, with ID
 * used only to make equal timestamps deterministic.
 */
export const compareMessagesChronologically = (left: Message, right: Message): number => {
  const createdAtDifference = getCreatedAt(left) - getCreatedAt(right)
  if (createdAtDifference !== 0) return createdAtDifference
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

export const sortMessagesChronologically = <T extends Message>(messages: readonly T[]): T[] => (
  [...messages].sort(compareMessagesChronologically)
)

export const findMessageIndex = (messages: readonly Message[], messageID: string): number => (
  messages.findIndex((message) => message.id === messageID)
)

export const insertMessageChronologically = <T extends Message>(messages: T[], message: T): number => {
  let low = 0
  let high = messages.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareMessagesChronologically(messages[middle], message) < 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  messages.splice(low, 0, message)
  return low
}

/** Return the messages before the marker's current array position. */
export const messagesBefore = <T extends Message>(messages: readonly T[], messageID?: string): T[] => {
  if (!messageID) return messages as T[]
  const index = findMessageIndex(messages, messageID)
  return index < 0 ? messages as T[] : messages.slice(0, index)
}

/** Return the marker and all messages after its current array position. */
export const messagesFrom = <T extends Message>(messages: readonly T[], messageID?: string): T[] => {
  if (!messageID) return []
  const index = findMessageIndex(messages, messageID)
  return index < 0 ? [] : messages.slice(index)
}
