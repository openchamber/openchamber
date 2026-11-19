import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { readContextPart } from '@/lib/messages/contextParts';
import type { Part } from '@/lib/opencode/model';
import { appOwnOrigins } from '@/lib/router/appOrigins';
import { findSessionLinks, sessionLinkKey } from '@/lib/sessionLinks';
import { sessionMentionChip, type SessionMentionChip } from '@/lib/messages/sessionMentionChip';
import type { InlineTextNode } from './attachmentCitationChips';
import { SessionMentionChipButton } from './SessionMentionChipButton';

export type SessionMentionChips = ReadonlyMap<string, SessionMentionChip>;

const NO_CHIPS: SessionMentionChips = new Map();

export function sessionMentionChipsOf(parts: readonly Part[]): SessionMentionChips {
    if (isVSCodeRuntime()) return NO_CHIPS;
    let chips: Map<string, SessionMentionChip> | null = null;
    for (const part of parts) {
        const payload = readContextPart(part);
        if (payload?.kind !== 'session' && payload?.kind !== 'session-message') continue;
        chips ??= new Map();
        chips.set(sessionLinkKey({ sessionId: payload.sessionId, messageId: payload.messageId ?? null }), sessionMentionChip(payload));
    }
    return chips ?? NO_CHIPS;
}

export const SessionMentionChipsContext = React.createContext<SessionMentionChips>(NO_CHIPS);

export function withSessionMentionChips(text: string, chips: SessionMentionChips, keyPrefix: string): InlineTextNode[] {
    if (chips.size === 0) return [text];
    const nodes: InlineTextNode[] = [];
    let cursor = 0;
    for (const range of findSessionLinks(text, appOwnOrigins())) {
        const chip = chips.get(sessionLinkKey(range.target));
        if (!chip) continue;
        if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
        nodes.push(<SessionMentionChipButton key={`${keyPrefix}-${range.start}`} chip={chip} target={range.target} />);
        cursor = range.end;
    }
    if (cursor === 0) return [text];
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}
