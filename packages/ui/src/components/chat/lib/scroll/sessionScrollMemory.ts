import type { MessageViewportAnchor } from './messageViewportAnchor';

const SESSION_SCROLL_MEMORY_LIMIT = 100;
const positions = new Map<string, MessageViewportAnchor>();

export const readSessionScrollPosition = (sessionKey: string): MessageViewportAnchor | null => (
    positions.get(sessionKey) ?? null
);

export const rememberSessionScrollPosition = (sessionKey: string, anchor: MessageViewportAnchor | null): void => {
    positions.delete(sessionKey);
    if (!anchor) return;
    positions.set(sessionKey, anchor);
    if (positions.size > SESSION_SCROLL_MEMORY_LIMIT) {
        const oldest = positions.keys().next().value;
        if (oldest !== undefined) positions.delete(oldest);
    }
};

export const rememberOutgoingSessionScrollPosition = (
    sessionKey: string,
    atEnd: boolean,
    anchor: MessageViewportAnchor | null,
): void => {
    if (!atEnd && anchor === null) return;
    rememberSessionScrollPosition(sessionKey, atEnd ? null : anchor);
};
