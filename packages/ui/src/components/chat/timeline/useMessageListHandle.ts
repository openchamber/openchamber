import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

import { uiPageMessageId } from '../lib/turns/liveActivity';
import { isReasoningRevealTarget } from '../search/reasoningReveal';
import {
    captureMessageViewportAnchor,
    type MessageViewportAnchor,
    type ViewportAnchorAlignment,
} from '../lib/scroll/messageViewportAnchor';
import type { useTurnRecords } from '../hooks/useTurnRecords';
import type { MessageListHandle } from './types';
import type { useTimelineRowIndexes } from './useTimelineRowIndexes';
import { useNavigationSettle } from './useNavigationSettle';

type TurnProjection = ReturnType<typeof useTurnRecords>['projection'];

/** Installs the navigation handle a parent drives the timeline through (scroll to a message, hold or restore a viewport anchor). */
export const useMessageListHandle = (
    ref: React.ForwardedRef<MessageListHandle>,
    {
        sessionKey,
        listRef,
        rows,
        projection,
        defaultActivityExpanded,
        indexes,
        expandTurnActivity,
    }: {
        sessionKey: string;
        listRef: React.MutableRefObject<LegendListRef | null>;
        rows: readonly unknown[];
        projection: TurnProjection;
        defaultActivityExpanded: boolean;
        indexes: ReturnType<typeof useTimelineRowIndexes>;
        expandTurnActivity: (turnId: string) => boolean;
    },
) => {
    const { messageIndexMap, turnIndexMap, rowIndexByKey, collapsibleTurnByMessageId, turnByAssistantMessageId } = indexes;

    // A retained hidden list must never fall back to another session's DOM.
    const resolveScrollContainer = React.useCallback((): HTMLElement | null => {
        return listRef.current?.getScrollableNode() ?? null;
    }, [listRef]);

    const uiPageProjectionRef = React.useRef({ projection, defaultActivityExpanded });
    React.useLayoutEffect(() => {
        uiPageProjectionRef.current = { projection, defaultActivityExpanded };
    }, [projection, defaultActivityExpanded]);

    /** The row an anchor names: the slice of a long answer it was taken in, else its message's first row. */
    const anchorRowIndex = React.useCallback((anchor: MessageViewportAnchor): number | undefined => (
        (anchor.slice ? rowIndexByKey.get(`step:${anchor.messageId}:${anchor.slice}`) : undefined)
            ?? messageIndexMap.get(anchor.messageId)
    ), [messageIndexMap, rowIndexByKey]);

    /**
     * Opens the turn a linked or searched message is folded into, the way a
     * browser's find opens a closed <details>. True when it had to open it:
     * the row renders the message on a later frame.
     */
    const revealFoldedMessage = React.useCallback((messageId: string): boolean => {
        const turnId = isReasoningRevealTarget(messageId)
            ? turnByAssistantMessageId.get(messageId)
            : collapsibleTurnByMessageId.get(messageId);
        if (!turnId) return false;
        return expandTurnActivity(turnId);
    }, [collapsibleTurnByMessageId, expandTurnActivity, turnByAssistantMessageId]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        // A search hit in reasoning lands on the reasoning block itself rather
        // than the top of its message.
        if (isReasoningRevealTarget(messageId)) {
            const reasoning = container.querySelector<HTMLElement>(`[data-reasoning-message-id="${messageId}"]`);
            if (reasoning) return reasoning;
        }
        // A long answer's later rows carry its id too; its start is the one without a slice.
        return container.querySelector(`[data-message-id="${messageId}"]:not([data-message-slice])`);
    }, [resolveScrollContainer]);

    // A slice that no longer exists (the message is cut elsewhere now: the
    // reasoning was hidden) falls back to the message's first row, as its index does.
    const findAnchorElement = React.useCallback((anchor: MessageViewportAnchor): HTMLElement | null => (
        anchor.slice && rowIndexByKey.has(`step:${anchor.messageId}:${anchor.slice}`)
            ? resolveScrollContainer()?.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"][data-message-slice="${anchor.slice}"]`) ?? null
            : findMessageElement(anchor.messageId)
    ), [findMessageElement, resolveScrollContainer, rowIndexByKey]);

    // Accepts any index the list renders, the trailing streaming entry
    // included — it lives at historyEntries.length and is a legitimate
    // navigation target (the timeline rail's last item).
    const scrollHistoryIndexIntoView = React.useCallback((index: number) => {
        if (index < 0 || index >= rows.length) {
            return false;
        }

        const list = listRef.current;
        if (!list) {
            return false;
        }

        // Unanimated: an unmounted target's position is still an estimate, and
        // a smooth scroll would end at that stale offset once the real
        // measurement replaces it. Mounted targets still take the smooth DOM
        // path in scrollMessageElementIntoView.
        void list.scrollToIndex({ index, animated: false, viewPosition: 0 });
        return true;
    }, [listRef, rows.length]);

    // A navigation scroll lands on estimates: an unmounted target teleports
    // to its estimated offset, and even a mounted one drifts when neighbours
    // finish measuring a frame later. This settle loop re-aligns the target to
    // the requested viewport position until the layout stops moving, and backs
    // off the moment the user touches the scroll.
    const { cancelNavigationRef, settleNavigationTarget } = useNavigationSettle(sessionKey, resolveScrollContainer);

    const scrollMessageElementIntoView = React.useCallback((messageId: string, behavior: ScrollBehavior = 'auto') => {
        const container = resolveScrollContainer();
        if (!container) {
            return false;
        }
        const messageElement = findMessageElement(messageId);
        if (!messageElement) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const messageRect = messageElement.getBoundingClientRect();
        const offset = 50;
        const top = messageRect.top - containerRect.top + container.scrollTop - offset;
        container.scrollTo({ top, behavior });
        return true;
    }, [findMessageElement, resolveScrollContainer]);

    const alignViewportAnchor = React.useCallback((anchor: MessageViewportAnchor): ViewportAnchorAlignment => {
        const index = anchorRowIndex(anchor);
        const container = resolveScrollContainer();
        if (index === undefined || !container) {
            return 'missing';
        }
        if (revealFoldedMessage(anchor.messageId)) {
            scrollHistoryIndexIntoView(index);
            return 'moved';
        }

        const element = findAnchorElement(anchor);
        if (!element) {
            // Not mounted: bring its row in from the estimate; the next step
            // measures the real position.
            return scrollHistoryIndexIntoView(index) ? 'moved' : 'missing';
        }
        const delta = element.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            - anchor.offsetTop;
        if (Math.abs(delta) <= 0.5) {
            return 'aligned';
        }
        const before = container.scrollTop;
        container.scrollTop += delta;
        // A message near either end of the timeline cannot reach the offset:
        // the scroll is clamped, and where it stopped is as close as it gets.
        return Math.abs(container.scrollTop - before) < 0.5 ? 'aligned' : 'moved';
    }, [anchorRowIndex, findAnchorElement, resolveScrollContainer, revealFoldedMessage, scrollHistoryIndexIntoView]);

    // Installed during layout so a parent's layout effect (session entry
    // restore) already reaches this list, not the one it replaced.
    React.useLayoutEffect(() => {
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            resolveUiPageMessageId: (messageId, partId) => {
                const { projection: current, defaultActivityExpanded: expanded } = uiPageProjectionRef.current;
                const turnId = current.indexes.messageToTurnId.get(messageId);
                const turn = turnId ? current.indexes.turnById.get(turnId) : undefined;
                return uiPageMessageId(turn, expanded, messageId, partId);
            },
            scrollToUiPageRow: (messageId) => {
                const turnId = uiPageProjectionRef.current.projection.indexes.messageToTurnId.get(messageId);
                const index = turnId ? rowIndexByKey.get(`pages:${turnId}`) : undefined;
                if (index === undefined) return false;
                cancelNavigationRef.current?.();
                return scrollHistoryIndexIntoView(index);
            },
            scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => {
                cancelNavigationRef.current?.();
                const behavior = options?.behavior ?? 'auto';
                const index = turnIndexMap.get(turnId);
                if (index === undefined) {
                    return false;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const findTurnElement = () => container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                const turnElement = findTurnElement();
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, 0);
                    return true;
                }

                if (!scrollHistoryIndexIntoView(index)) {
                    return false;
                }
                if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, 0);
                return true;
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                cancelNavigationRef.current?.();
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                revealFoldedMessage(messageId);
                const didScroll = scrollMessageElementIntoView(messageId, behavior)
                    || scrollHistoryIndexIntoView(index);
                if (didScroll && behavior !== 'smooth') {
                    settleNavigationTarget(() => findMessageElement(messageId), 50);
                }
                return didScroll;
            },

            holdViewportAnchor: (anchor) => {
                settleNavigationTarget(() => findAnchorElement(anchor), anchor.offsetTop);
            },

            // The timeline is always virtualized now; the flag stays so callers
            // that branch on it keep compiling and take the virtualized path.
            isHistoryVirtualized: () => true,

            captureViewportAnchor: () => {
                const container = resolveScrollContainer();
                return container ? captureMessageViewportAnchor(container) : null;
            },

            restoreViewportAnchor: (anchor) => alignViewportAnchor(anchor) !== 'missing',

            alignViewportAnchor,

            hasMessageRow: (messageId) => messageIndexMap.has(messageId),

            scrollToBottom: () => {
                const list = listRef.current;
                if (list) {
                    void list.scrollToEnd({ animated: false });
                    return;
                }
                const container = resolveScrollContainer();
                if (!container) return;
                // Overshoot so the browser clamps to the exact fractional
                // maximum (scrollHeight is integer-rounded).
                container.scrollTop = container.scrollHeight + 4096;
            },
        };

        if (typeof ref === 'function') {
            ref(handle);
            return () => {
                ref(null);
            };
        }

        const objectRef = ref;
        objectRef.current = handle;
        return () => {
            if (objectRef.current === handle) objectRef.current = null;
        };
    }, [alignViewportAnchor, cancelNavigationRef, findAnchorElement, findMessageElement, listRef, messageIndexMap, resolveScrollContainer, revealFoldedMessage, rowIndexByKey, scrollHistoryIndexIntoView, scrollMessageElementIntoView, settleNavigationTarget, turnIndexMap, ref]);
};
