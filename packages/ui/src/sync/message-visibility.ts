import type { Message } from "@opencode-ai/sdk/v2/client"
import type { PostRevertBranchOverlay, PostRevertBranchOverlays } from "./types"

type SessionRevertMarker = {
  messageID?: string | null
}

type SessionWithRevert = {
  id: string
  revert?: SessionRevertMarker | null
}

export function getSessionRevertMessageID(session: Pick<SessionWithRevert, "revert"> | undefined): string | undefined {
  const marker = session?.revert
  if (!marker || typeof marker !== "object") return undefined
  const { messageID } = marker
  return typeof messageID === "string" && messageID.length > 0 ? messageID : undefined
}

export function hasEffectivePostRevertBranch(
  session: Pick<SessionWithRevert, "revert"> | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): boolean {
  return getReplacementBoundary(getSessionRevertMessageID(session), overlay) !== undefined
}

/**
 * Derive timeline-visible messages from the authoritative marker plus the
 * locally optimistic replacement branch. OpenCode message IDs are ascending,
 * so the first replacement ID is the boundary for later server messages that
 * belong to that replacement branch.
 */
export function getEffectiveVisibleMessages(
  messages: Message[],
  session: Pick<SessionWithRevert, "revert"> | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): Message[] {
  const revertMessageID = getSessionRevertMessageID(session)
  if (!revertMessageID) return messages

  const replacementBoundary = getReplacementBoundary(revertMessageID, overlay)
  return messages.filter((message) => isVisibleAtBoundary(message.id, revertMessageID, replacementBoundary))
}

export function isEffectivelyVisibleMessage(
  messageID: string,
  session: Pick<SessionWithRevert, "revert"> | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): boolean {
  const revertMessageID = getSessionRevertMessageID(session)
  if (!revertMessageID) return true

  const replacementBoundary = getReplacementBoundary(revertMessageID, overlay)

  return isVisibleAtBoundary(messageID, revertMessageID, replacementBoundary)
}

function getReplacementBoundary(
  revertMessageID: string | undefined,
  overlay: PostRevertBranchOverlay | undefined,
): string | undefined {
  if (
    !revertMessageID
    || !overlay
    || overlay.replacementMessageIDs.length === 0
    || overlay.revertMessageID !== revertMessageID
  ) {
    return undefined
  }
  return overlay.replacementMessageIDs[0]
}

function isVisibleAtBoundary(
  messageID: string,
  revertMessageID: string,
  replacementBoundary: string | undefined,
): boolean {
  // OpenCode's Identifier.ascending IDs sort lexicographically by creation
  // order, and server message snapshots preserve that ordering contract.
  return (
    messageID < revertMessageID
    || (replacementBoundary !== undefined && messageID >= replacementBoundary)
  )
}

export function addPostRevertBranchReplacement(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
  revertMessageID: string,
  replacementMessageID: string,
): PostRevertBranchOverlays {
  const current = overlays[sessionID]
  const replacementMessageIDs = current?.revertMessageID === revertMessageID
    ? current.replacementMessageIDs
    : []
  if (replacementMessageIDs.includes(replacementMessageID)) {
    return overlays
  }

  return {
    ...overlays,
    [sessionID]: {
      revertMessageID,
      // Identifier.ascending makes lexical message-ID order chronological.
      replacementMessageIDs: [...replacementMessageIDs, replacementMessageID].sort(),
    },
  }
}

export function removePostRevertBranchReplacement(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
  replacementMessageID: string,
): PostRevertBranchOverlays {
  const current = overlays[sessionID]
  if (!current || !current.replacementMessageIDs.includes(replacementMessageID)) return overlays

  const replacementMessageIDs = current.replacementMessageIDs.filter((id) => id !== replacementMessageID)
  if (replacementMessageIDs.length === 0) {
    return clearPostRevertBranchOverlay(overlays, sessionID)
  }

  return {
    ...overlays,
    [sessionID]: { ...current, replacementMessageIDs },
  }
}

/** Replace one session's local overlay without disturbing concurrent sessions. */
export function setPostRevertBranchOverlay(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
  overlay: PostRevertBranchOverlay | undefined,
): PostRevertBranchOverlays {
  if (!overlay) return clearPostRevertBranchOverlay(overlays, sessionID)
  return { ...overlays, [sessionID]: overlay }
}

export function clearPostRevertBranchOverlay(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
): PostRevertBranchOverlays {
  if (!overlays[sessionID]) return overlays
  const next = { ...overlays }
  delete next[sessionID]
  return next
}

/**
 * An overlay is only valid while the exact same authoritative marker remains
 * in place. A new revert, unrevert, cache reload, or session replacement
 * retires it instead of allowing it to revive against unrelated state.
 */
export function reconcilePostRevertBranchOverlay(
  overlays: PostRevertBranchOverlays,
  sessionID: string,
  previousSession: Pick<SessionWithRevert, "revert"> | undefined,
  nextSession: Pick<SessionWithRevert, "revert"> | undefined,
): PostRevertBranchOverlays {
  const overlay = overlays[sessionID]
  if (!overlay) return overlays

  const previousRevertMessageID = getSessionRevertMessageID(previousSession)
  const nextRevertMessageID = getSessionRevertMessageID(nextSession)
  if (
    previousRevertMessageID === nextRevertMessageID
    && nextRevertMessageID === overlay.revertMessageID
  ) {
    return overlays
  }

  return clearPostRevertBranchOverlay(overlays, sessionID)
}

export function reconcilePostRevertBranchOverlays(
  overlays: PostRevertBranchOverlays,
  previousSessions: ReadonlyArray<SessionWithRevert>,
  nextSessions: ReadonlyArray<SessionWithRevert>,
): PostRevertBranchOverlays {
  if (Object.keys(overlays).length === 0) return overlays

  const previousByID = new Map(previousSessions.map((session) => [session.id, session]))
  const nextByID = new Map(nextSessions.map((session) => [session.id, session]))
  let next = overlays
  for (const sessionID of Object.keys(overlays)) {
    next = reconcilePostRevertBranchOverlay(
      next,
      sessionID,
      previousByID.get(sessionID),
      nextByID.get(sessionID),
    )
  }
  return next
}
