// A request to show one message of a session, raised by a message link (the
// web route, a desktop or mobile deep link, a link clicked in the chat) and
// served by that session's chat timeline: on entry when the link switches
// sessions, or right away when the session is already open.
//
// Opening a link can select the session twice: first under a guessed
// directory, then under the one the session list reports. Each selection
// mounts a new timeline, and the first may be torn down mid-search or may even
// have shown the message already; the second must show it again. So the
// request outlives being shown: it stays until the reader takes the viewport,
// another session is entered, the message proves missing, or it expires.
// Only the newest request is kept.

const MESSAGE_FOCUS_TTL_MS = 60_000;

// Session and message IDs travel through URLs and end up in DOM attribute
// selectors, so only plain identifier characters are accepted.
const LINK_IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const isLinkIdentifier = (value: string): boolean => LINK_IDENTIFIER_RE.test(value);

export type MessageFocusRequest = {
    readonly sessionId: string;
    readonly messageId: string;
    /** Tells a repeated click on the same link from the request it repeats. */
    readonly serial: number;
    readonly requestedAt: number;
};

let pending: MessageFocusRequest | null = null;
let nextSerial = 1;
const listeners = new Set<() => void>();

export const requestMessageFocus = (sessionId: string, messageId: string): void => {
    if (!isLinkIdentifier(sessionId) || !isLinkIdentifier(messageId)) return;
    pending = { sessionId, messageId, serial: nextSerial++, requestedAt: Date.now() };
    for (const listener of listeners) listener();
};

/** The link request for this session, if one is still standing. */
export const peekMessageFocus = (sessionId: string | null): MessageFocusRequest | null => {
    const request = pending;
    if (!request || !sessionId || request.sessionId !== sessionId) return null;
    if (Date.now() - request.requestedAt > MESSAGE_FOCUS_TTL_MS) {
        pending = null;
        return null;
    }
    return request;
};

/** Ends the request: the reader took over, or the message is missing. */
export const settleMessageFocus = (request: MessageFocusRequest): void => {
    if (pending?.serial === request.serial) pending = null;
};

/** Entering a session drops a request that names another one. */
export const releaseMessageFocusOutside = (sessionId: string | null): void => {
    if (pending && pending.sessionId !== sessionId) pending = null;
};

export const subscribeMessageFocus = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
