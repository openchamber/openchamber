
import { opencodeClient } from '@/lib/opencode/client';
import type { Message, Part, Session } from '@/lib/opencode/model';
import { findSessionLinks, sessionLinkKey, type SessionLinkTarget } from '@/lib/sessionLinks';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

import type { ComposerContextReference } from './submit/buildOutgoingMessage';

export type SessionReference = Extract<ComposerContextReference, { kind: 'session' | 'session-message' }>;

const EXCERPT_LENGTH = 120;

export const sessionReference = (session: Pick<Session, 'id' | 'title'>): SessionReference => ({
    kind: 'session',
    sessionId: session.id,
    title: session.title,
    contextText: `The user referenced another OpenChamber session, "${session.title}" (${session.id}). `
        + `Its messages can be read with the openchamber tool (session.messages, sessionId ${session.id}).`,
});

export const messageText = (parts: readonly Part[]): string => parts
    .flatMap((part) => (part.type === 'text' && !part.metadata?.openchamberContext ? [part.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');

const authorOf = (role: Message['role']): string => {
    if (role === 'user') return 'the user of that session';
    if (role === 'assistant') return 'the agent of that session';
    return 'OpenChamber';
};

export const sessionMessageReference = (
    session: Pick<Session, 'id' | 'title'>,
    message: { info: Pick<Message, 'id' | 'role'>; parts: readonly Part[] },
): SessionReference | null => {
    const text = messageText(message.parts);
    if (!text) return null;
    const excerpt = text.replace(/\s+/g, ' ').trim();
    return {
        kind: 'session-message',
        sessionId: session.id,
        messageId: message.info.id,
        sessionTitle: session.title,
        excerpt: excerpt.length > EXCERPT_LENGTH ? `${excerpt.slice(0, EXCERPT_LENGTH - 1)}…` : excerpt,
        contextText: `The user attached a message from another OpenChamber session, "${session.title}" `
            + `(${session.id}, message ${message.info.id}). It was written by ${authorOf(message.info.role)}. The message:\n\n${text}`,
    };
};

export const sessionReferenceKey = (reference: { sessionId: string; messageId?: string }): string => sessionLinkKey({
    sessionId: reference.sessionId,
    messageId: reference.messageId ?? null,
});

export const sessionLinkText = (sessionId: string): string => `openchamber://session/${sessionId}`;

export const loadSessionLinkReference = async (target: SessionLinkTarget): Promise<SessionReference | null> => {
    const snapshot = await ensureGlobalSessionsLoaded();
    const session = [...snapshot.activeSessions, ...snapshot.archivedSessions].find((entry) => entry.id === target.sessionId);
    if (!session) return null;
    if (!target.messageId) return sessionReference(session);
    const message = await opencodeClient.getSessionMessage(session.id, target.messageId, resolveGlobalSessionDirectory(session));
    return sessionMessageReference(session, message) ?? { ...sessionReference(session), messageId: target.messageId };
};

type MentionsInText = { references: SessionReference[]; unresolved: SessionLinkTarget[] };

export const sessionReferencesInText = (
    text: string,
    ownOrigins: readonly string[],
    resolved: ReadonlyMap<string, SessionReference>,
): MentionsInText => {
    const references: SessionReference[] = [];
    const unresolved: SessionLinkTarget[] = [];
    const seen = new Set<string>();
    for (const { target } of findSessionLinks(text, ownOrigins)) {
        const key = sessionLinkKey(target);
        if (seen.has(key)) continue;
        seen.add(key);
        const reference = resolved.get(key);
        if (reference) references.push(reference);
        else unresolved.push(target);
    }
    return { references, unresolved };
};

