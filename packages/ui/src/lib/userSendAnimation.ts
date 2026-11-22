
const pendingCounts = new Map<string, number>();

export const markPendingUserSendAnimation = (sessionId: string): void => {
    pendingCounts.set(sessionId, (pendingCounts.get(sessionId) ?? 0) + 1);
};

export const hasPendingUserSendAnimation = (sessionId: string): boolean => {
    return (pendingCounts.get(sessionId) ?? 0) > 0;
};

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
