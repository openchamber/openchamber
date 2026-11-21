import type { Message } from "@/lib/opencode/model"

export const findMessageIndex = (messages: readonly Message[], messageID: string): number => (
  messages.findIndex((message) => message.id === messageID)
)

export const insertMessageInEventOrder = <T extends Message>(messages: T[], message: T): number => {
  let prompt = -1
  if (message.role === "synthetic" && !message.pending) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user" || messages[i].time.created !== message.time.created) continue
      prompt = i
      break
    }
  }
  const index = prompt < 0 ? messages.length : prompt
  messages.splice(index, 0, message)
  return index
}

export const messagesBefore = <T extends Message>(messages: readonly T[], messageID?: string): T[] => {
  if (!messageID) return messages as T[]
  const index = findMessageIndex(messages, messageID)
  return index < 0 ? messages as T[] : messages.slice(0, index)
}

export const messagesFrom = <T extends Message>(messages: readonly T[], messageID?: string): T[] => {
  if (!messageID) return []
  const index = findMessageIndex(messages, messageID)
  return index < 0 ? [] : messages.slice(index)
}
