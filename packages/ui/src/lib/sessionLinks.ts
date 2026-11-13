import { isLinkIdentifier } from '@/lib/router/messageFocus';

// Links to a session, optionally to one message in it. They extend the links
// the app already understands: the web route (`?session=<id>`) and the native
// deep link (`openchamber://session/<id>`), each with a `message` parameter.
// A link is a place on this server, not a public share: it opens only for
// someone who can reach the same OpenChamber instance.
//
// Pure on purpose: the markdown sanitizer, which may run in a worker, uses it.

export interface SessionLinkTarget {
    readonly sessionId: string;
    readonly messageId: string | null;
}

/** Which kind of link a surface hands out; see `useCopyMessageLink`. */
export type MessageLinkForm =
    | { readonly kind: 'deep-link' }
    | { readonly kind: 'web'; readonly origin: string; readonly pathname: string };

const DEEP_LINK_PREFIX = 'openchamber://session/';

export const buildMessageLink = (sessionId: string, messageId: string, form: MessageLinkForm): string | null => {
    if (!isLinkIdentifier(sessionId) || !isLinkIdentifier(messageId)) return null;
    if (form.kind === 'deep-link') {
        return `${DEEP_LINK_PREFIX}${sessionId}?message=${messageId}`;
    }
    let url: URL;
    try {
        url = new URL(form.pathname, form.origin);
    } catch {
        return null;
    }
    url.searchParams.set('session', sessionId);
    url.searchParams.set('message', messageId);
    return url.toString();
};

// An agent that knows only a session id writes it as the whole link
// (`[read it](ses_…)`). Left alone, the page resolves it against its own
// address: a dead route on the web, a bare page of the app on desktop.
const BARE_SESSION_ID_RE = /^\/?(ses_[A-Za-z0-9_-]+)$/;

const parseTarget = (sessionId: string | null | undefined, messageId: string | null): SessionLinkTarget | null => {
    if (!sessionId || !isLinkIdentifier(sessionId)) return null;
    if (messageId === null) return { sessionId, messageId: null };
    return isLinkIdentifier(messageId) ? { sessionId, messageId } : null;
};

/**
 * Reads a session or message link, as found in chat content. `ownOrigins` are
 * the addresses that serve this instance (the page, and the instance the app
 * is connected to): web links count only when they point at one of them.
 * A link that is just a session id counts too. Anything else, including other
 * native deep links, is not a session link.
 */
export const parseSessionLink = (href: string, ownOrigins: readonly string[]): SessionLinkTarget | null => {
    const bareSessionId = BARE_SESSION_ID_RE.exec(href.trim())?.[1];
    if (bareSessionId) return parseTarget(bareSessionId, null);

    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }

    if (url.protocol === 'openchamber:') {
        // Old Android WebViews put the route in the path instead of the host.
        const segments = [url.host, ...url.pathname.split('/')].filter(Boolean);
        if (segments[0]?.toLowerCase() !== 'session' || segments.length !== 2) return null;
        return parseTarget(segments[1], url.searchParams.get('message'));
    }

    if ((url.protocol === 'http:' || url.protocol === 'https:') && ownOrigins.includes(url.origin)) {
        return parseTarget(url.searchParams.get('session'), url.searchParams.get('message'));
    }

    return null;
};

/** True for `openchamber://session/...` links, the only native deep links chat content may carry. */
export const isSessionDeepLink = (href: string): boolean => (
    href.toLowerCase().startsWith(DEEP_LINK_PREFIX) && parseSessionLink(href, []) !== null
);

// A link as it sits in text: the native deep link, or any web address, kept
// only when it carries `session=`. One linear pass: a pattern that looked for
// `session=` inside the address backtracked over every long unbroken run.
const LINK_CANDIDATE = /openchamber:\/\/session\/[^\s<>()"'`]+|https?:\/\/[^\s<>()"'`]+/gi;

interface SessionLinkRange {
    readonly start: number;
    readonly end: number;
    readonly link: string;
    readonly target: SessionLinkTarget;
}

/** The key of a session link's target: one per session, and per message of it. */
export const sessionLinkKey = (target: SessionLinkTarget): string => `${target.sessionId}:${target.messageId ?? ''}`;

/**
 * Every session and message link in text, where it sits. Punctuation that
 * ends the sentence is not part of the link. A bare session id is not one
 * here: in text the user wrote, it is more likely meant as text.
 */
export const findSessionLinks = (text: string, ownOrigins: readonly string[]): SessionLinkRange[] => {
    if (!text.includes('session')) return [];
    const found: SessionLinkRange[] = [];
    for (const match of text.matchAll(LINK_CANDIDATE)) {
        const link = match[0].replace(/[.,;:!?]+$/, '');
        if (!link.includes('session')) continue;
        const target = parseSessionLink(link, ownOrigins);
        if (target) found.push({ start: match.index, end: match.index + link.length, link, target });
    }
    return found;
};
