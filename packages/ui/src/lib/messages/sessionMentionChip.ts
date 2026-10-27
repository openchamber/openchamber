/**
 * How a mentioned session or message draws as a chip: the session's title, or
 * the start of the message. Shared by the composer and sent messages, and
 * free of I/O so the Markdown renderer can use it.
 */

const CHIP_LABEL_LENGTH = 48;

/** What a chip needs of a mention: its reference, or the context payload a sent message carries. */
type SessionMentionLike =
    | { kind: 'session'; title: string }
    | { kind: 'session-message'; sessionTitle: string; excerpt: string };

export type SessionMentionChip = { label: string; title: string; icon: 'chat-3' | 'double-quotes-l' };

export const sessionMentionChip = (reference: SessionMentionLike): SessionMentionChip => {
    if (reference.kind === 'session') return { label: reference.title, title: reference.title, icon: 'chat-3' };
    const { excerpt } = reference;
    return {
        label: excerpt.length > CHIP_LABEL_LENGTH ? `${excerpt.slice(0, CHIP_LABEL_LENGTH - 1).trimEnd()}…` : excerpt,
        title: `${reference.sessionTitle}: ${excerpt}`,
        icon: 'double-quotes-l',
    };
};
