import React from 'react';
import { getShownPages } from '../lib/turns/liveActivity';
import type { TurnRecord } from '../lib/turns/types';

export const foldContentId = (turnId: string) => `turn-activity-${turnId}`;
export const finalActivityContentId = (turnId: string) => `turn-final-activity-${turnId}`;

export const useTurnFold = (turn: TurnRecord, hasLaterAssistant: boolean, expanded: boolean, finalMessageId: string | undefined, keepText: boolean) => {
    const finalMessage = finalMessageId ? turn.assistantMessages.find((message) => message.info.id === finalMessageId) : undefined;
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const settled = Boolean(finalMessage) || hasLaterAssistant;
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages, finalMessage, keepText), [turn.assistantMessages, finalMessage, keepText]);
    return { finalMessage, activityMessages, settled, isExpanded: !settled || expanded, pages };
};

export const useTurnFoldContexts = (turn: TurnRecord, hasLaterAssistant: boolean, expanded: boolean, finalMessageId: string | undefined, keepText: boolean) => {
    const { finalMessage, isExpanded, pages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId, keepText);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const shownFinalMessageId = finalMessage?.info.id;
    const finalContext = React.useMemo(() => shownFinalMessageId ? {
        messageId: shownFinalMessageId, expanded: isExpanded, contentId: finalActivityContentId(turn.turnId), pages, keepText,
    } : null, [shownFinalMessageId, isExpanded, keepText, pages, turn.turnId]);
    return { hoistedPages, finalContext };
};
