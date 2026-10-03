import type { MessageViewportAnchor } from './messageViewportAnchor';

// Where the reader left each session, for as long as the app runs. A session
// left at its live end has no entry: returning to it lands on the end, as
// opening any session does. Keys carry runtime, directory and session, so
// equal session IDs in different worktrees or runtimes stay separate.
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
