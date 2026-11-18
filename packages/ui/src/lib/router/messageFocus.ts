
const MESSAGE_FOCUS_TTL_MS = 60_000;

const LINK_IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const isLinkIdentifier = (value: string): boolean => LINK_IDENTIFIER_RE.test(value);

export type MessageFocusRequest = {
    readonly sessionId: string;
    readonly messageId: string;
    readonly serial: number;
    readonly requestedAt: number;
};

let pending: MessageFocusRequest | null = null;
let nextSerial = 1;
const listeners = new Set<() => void>();

let shownSerial = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<() => void>();
const notifyStatus = () => {
    for (const listener of statusListeners) listener();
};

export const requestMessageFocus = (sessionId: string, messageId: string): void => {
    if (!isLinkIdentifier(sessionId) || !isLinkIdentifier(messageId)) return;
    const request = { sessionId, messageId, serial: nextSerial++, requestedAt: Date.now() };
    pending = request;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
        expiryTimer = null;
        if (pending?.serial === request.serial) pending = null;
        notifyStatus();
    }, MESSAGE_FOCUS_TTL_MS + 1);
    for (const listener of listeners) listener();
    notifyStatus();
};

export const peekMessageFocus = (sessionId: string | null): MessageFocusRequest | null => {
    const request = pending;
    if (!request || !sessionId || request.sessionId !== sessionId) return null;
    if (Date.now() - request.requestedAt > MESSAGE_FOCUS_TTL_MS) {
        pending = null;
        return null;
    }
    return request;
};

export const settleMessageFocus = (request: MessageFocusRequest): void => {
    if (pending?.serial !== request.serial) return;
    pending = null;
    notifyStatus();
};

export const releaseMessageFocusOutside = (sessionId: string | null): void => {
    if (!pending || pending.sessionId === sessionId) return;
    pending = null;
    notifyStatus();
};

export const markMessageFocusShown = (request: MessageFocusRequest): void => {
    if (shownSerial === request.serial) return;
    shownSerial = request.serial;
    notifyStatus();
};

export const readMessageFocusInFlight = (sessionId: string | null): string | null => {
    const request = peekMessageFocus(sessionId);
    return request && request.serial !== shownSerial ? request.messageId : null;
};

export const subscribeMessageFocusStatus = (listener: () => void): (() => void) => {
    statusListeners.add(listener);
    return () => {
        statusListeners.delete(listener);
    };
};

export const subscribeMessageFocus = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
