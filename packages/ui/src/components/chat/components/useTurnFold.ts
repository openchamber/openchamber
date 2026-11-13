import React from 'react';
import { getShownPages } from '../lib/turns/liveActivity';
import type { TurnRecord } from '../lib/turns/types';

// The fold and the final answer are separate list rows; aria-controls names
// their content across rows.
export const foldContentId = (turnId: string) => `turn-activity-${turnId}`;
export const finalActivityContentId = (turnId: string) => `turn-final-activity-${turnId}`;

/**
 * A turn's work in the collapsed activity mode, as list rows split it
 * (`timelineRows.ts`): the fold's header row, the steps (rows of their own
 * once opened), the pages a turn without an answer showed, and the final
 * answer, whose own non-text parts fold with the rest.
 */
export const useTurnFold = (turn: TurnRecord, hasLaterAssistant: boolean, expanded: boolean, finalMessageId: string | undefined) => {
    // Named by the rows (`timelineRows.ts`), which are built from the turn's
    // record: a live turn's newest parts may already finish an answer the
    // record does not have yet, and the answer has no row of its own until it does.
    const finalMessage = finalMessageId ? turn.assistantMessages.find((message) => message.info.id === finalMessageId) : undefined;
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const settled = Boolean(finalMessage) || hasLaterAssistant;
    // A page the agent showed is never folded away: it sits below the fold,
    // above the answer once one arrives, and stays there in a turn that ended
    // without one.
    // The final answer's own text is the answer, so it is never hoisted.
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages, finalMessage), [turn.assistantMessages, finalMessage]);
    return { finalMessage, activityMessages, settled, isExpanded: !settled || expanded, pages };
};

/** What the rows of a turn under a fold read: the pages it hoists, and the final answer's fold state. */
export const useTurnFoldContexts = (turn: TurnRecord, hasLaterAssistant: boolean, expanded: boolean, finalMessageId: string | undefined) => {
    const { finalMessage, isExpanded, pages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const shownFinalMessageId = finalMessage?.info.id;
    const finalContext = React.useMemo(() => shownFinalMessageId ? {
        messageId: shownFinalMessageId, expanded: isExpanded, contentId: finalActivityContentId(turn.turnId), pages,
    } : null, [shownFinalMessageId, isExpanded, pages, turn.turnId]);
    return { hoistedPages, finalContext };
};
