/**
 * Module-level tracker for user-send animations.
 *
 * Marks a session when the user presses "send" so that MessageList
 * can distinguish genuinely new user messages from historical ones
 * arriving via async loading / session switch.
 */

const pendingCounts = new Map<string, number>();

/** Call when user triggers a send (before the API call). */
export const markPendingUserSendAnimation = (sessionId: string): void => {
    pendingCounts.set(sessionId, (pendingCounts.get(sessionId) ?? 0) + 1);
};

/** Check whether this session has pending send animations. */
export const hasPendingUserSendAnimation = (sessionId: string): boolean => {
    return (pendingCounts.get(sessionId) ?? 0) > 0;
};

/**
 * Consume one pending send animation for the session.
 * Returns true if there was one to consume.
 */
export const consumePendingUserSendAnimation = (sessionId: string): boolean => {
    const count = pendingCounts.get(sessionId) ?? 0;
    if (count <= 0) return false;
    if (count === 1) {
        pendingCounts.delete(sessionId);
    } else {
        pendingCounts.set(sessionId, count - 1);
    }
    return true;
};
