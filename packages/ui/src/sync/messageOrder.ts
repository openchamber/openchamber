export type MessageLike = {
  id: string
  time?: { created?: unknown }
}

export const getMessageCreatedAt = (message: MessageLike): number => {
  const created = message.time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : 0
}

/**
 * Chronological message comparator: `time.created` first, `id` as tiebreaker.
 *
 * OpenCode message IDs encode `Date.now() * 0x1000 + counter` into a
 * truncated 6-byte (48-bit) hex prefix, which wraps around every
 * 2^36 ms (~795 days; the wrap occurred on 2026-08-14). Sorting by raw ID
 * therefore stops being chronological across the wrap boundary and the
 * newest messages sort before all older ones — they render at the top of the
 * chat. Every message — server-side and optimistic client inserts — carries
 * `time.created`, so ordering by time is immune to ID wraps and any future
 * ID format changes.
 */
export const compareMessages = (left: MessageLike, right: MessageLike): number => {
  const leftTime = getMessageCreatedAt(left)
  const rightTime = getMessageCreatedAt(right)
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

export const sortMessages = <T extends MessageLike>(messages: readonly T[]): T[] => {
  return [...messages].sort(compareMessages)
}

/**
 * Linear id lookup. Message arrays are ordered chronologically
 * (time.created, then id), so an id-only lookup cannot binary search them.
 * Used on rare paths (revert anchors, removals) where the cost is negligible.
 */
export const findMessageByID = <T extends MessageLike>(messages: readonly T[], id: string): T | undefined => {
  return messages.find((message) => message.id === id)
}

/**
 * Whether `message` is strictly before the revert point. `anchor` is the
 * revert message itself when still present in the store; when it is missing
 * (revert optimistically removes it from the store) the raw id comparison is
 * used as a fallback — in that state the store only contains pre-anchor
 * messages, so the fallback matches the historical behavior.
 */
export const isBeforeMessage = (
  message: MessageLike,
  anchor: MessageLike | undefined,
  anchorID: string,
): boolean => {
  return anchor ? compareMessages(message, anchor) < 0 : message.id < anchorID
}

/** Whether `message` is at or after the revert point (see {@link isBeforeMessage}). */
export const isAtOrAfterMessage = (
  message: MessageLike,
  anchor: MessageLike | undefined,
  anchorID: string,
): boolean => {
  return anchor ? compareMessages(message, anchor) >= 0 : message.id >= anchorID
}

/** Whether `message` is strictly after the revert point (see {@link isBeforeMessage}). */
export const isAfterMessage = (
  message: MessageLike,
  anchor: MessageLike | undefined,
  anchorID: string,
): boolean => {
  return anchor ? compareMessages(message, anchor) > 0 : message.id > anchorID
}
