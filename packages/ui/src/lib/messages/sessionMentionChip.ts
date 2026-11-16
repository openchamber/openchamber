
const CHIP_LABEL_LENGTH = 48;

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
