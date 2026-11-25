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
import { readStuckHeaderHeight, replyTopInset } from '../lib/scroll/replyTopInset';
import { MESSAGE_JUMP_GAP_PX } from '../lib/scroll/scrollGaps';
import { findReplyProseElement } from '../message/replyProse';

type TurnProjection = ReturnType<typeof useTurnRecords>['projection'];

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

    const resolveScrollContainer = React.useCallback((): HTMLElement | null => {
        return listRef.current?.getScrollableNode() ?? null;
    }, [listRef]);

    const uiPageProjectionRef = React.useRef({ projection, defaultActivityExpanded });
    React.useLayoutEffect(() => {
        uiPageProjectionRef.current = { projection, defaultActivityExpanded };
    }, [projection, defaultActivityExpanded]);

    const anchorRowIndex = React.useCallback((anchor: MessageViewportAnchor): number | undefined => {
        if (anchor.kept) return rowIndexByKey.get(anchor.kept.row);
        return (anchor.slice ? rowIndexByKey.get(`step:${anchor.messageId}:${anchor.slice}`) : undefined)
            ?? messageIndexMap.get(anchor.messageId);
    }, [messageIndexMap, rowIndexByKey]);

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
        if (isReasoningRevealTarget(messageId)) {
            const reasoning = container.querySelector<HTMLElement>(`[data-reasoning-message-id="${messageId}"]`);
            if (reasoning) return reasoning;
        }
        return container.querySelector(`[data-message-id="${messageId}"]:not([data-message-slice])`);
    }, [resolveScrollContainer]);

    const findReplyStartElement = React.useCallback((messageId: string): HTMLElement | null => {
        const messageElement = findMessageElement(messageId);
        if (!messageElement) {
            return null;
        }
        return findReplyProseElement(messageElement);
    }, [findMessageElement]);

    const findAnchorElement = React.useCallback((anchor: MessageViewportAnchor): HTMLElement | null => {
        if (anchor.kept) {
            return resolveScrollContainer()?.querySelector<HTMLElement>(`[data-message-hoisted="${CSS.escape(anchor.kept.partId)}"]`) ?? null;
        }
        return anchor.slice && rowIndexByKey.has(`step:${anchor.messageId}:${anchor.slice}`)
            ? resolveScrollContainer()?.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"][data-message-slice="${anchor.slice}"]`) ?? null
            : findMessageElement(anchor.messageId);
    }, [findMessageElement, resolveScrollContainer, rowIndexByKey]);

    const scrollHistoryIndexIntoView = React.useCallback((index: number) => {
        if (index < 0 || index >= rows.length) {
            return false;
        }

        const list = listRef.current;
        if (!list) {
            return false;
        }

        void list.scrollToIndex({ index, animated: false, viewPosition: 0 });
        return true;
    }, [listRef, rows.length]);

    const { cancelNavigationRef, settleNavigationTarget } = useNavigationSettle(sessionKey, resolveScrollContainer, listRef);

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
        const top = messageRect.top - containerRect.top + container.scrollTop - MESSAGE_JUMP_GAP_PX;
        container.scrollTo({ top, behavior });
        return true;
    }, [findMessageElement, resolveScrollContainer]);

    const alignViewportAnchor = React.useCallback((anchor: MessageViewportAnchor): ViewportAnchorAlignment => {
        const index = anchorRowIndex(anchor);
        const container = resolveScrollContainer();
        if (index === undefined || !container) {
            return 'missing';
        }
        if (!anchor.kept && revealFoldedMessage(anchor.messageId)) {
            scrollHistoryIndexIntoView(index);
            return 'moved';
        }

        const element = findAnchorElement(anchor);
        if (!element) {
            if (anchor.kept && container.querySelector(`[data-row-key="${CSS.escape(anchor.kept.row)}"]`)) return 'missing';
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
        return Math.abs(container.scrollTop - before) < 0.5 ? 'aligned' : 'moved';
    }, [anchorRowIndex, findAnchorElement, resolveScrollContainer, revealFoldedMessage, scrollHistoryIndexIntoView]);

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
                    if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, () => 0);
                    return true;
                }

                if (!scrollHistoryIndexIntoView(index)) {
                    return false;
                }
                if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, () => 0);
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
                    settleNavigationTarget(() => findMessageElement(messageId), () => MESSAGE_JUMP_GAP_PX);
                }
                return didScroll;
            },

            findPreviousReplyStart: (candidateMessageIds: readonly string[]) => {
                const container = resolveScrollContainer();
                if (!container || candidateMessageIds.length === 0) {
                    return null;
                }

                const containerTop = container.getBoundingClientRect().top;
                const contentTop = readStuckHeaderHeight(container);
                const mounted = new Map<string, HTMLElement>();
                let boundaryIndex: number | undefined;
                let boundaryTop = Number.NEGATIVE_INFINITY;
                let boundaryIsSlice = false;
                let boundaryMessageId: string | null = null;
                for (const element of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
                    const id = element.getAttribute('data-message-id');
                    if (!id) continue;
                    const slice = element.hasAttribute('data-message-slice');
                    if (!slice) mounted.set(id, element);
                    if (element.closest('[data-turn-sticky-header]')) {
                        if (boundaryIndex === undefined) boundaryIndex = messageIndexMap.get(id);
                        continue;
                    }
                    const top = element.getBoundingClientRect().top - containerTop;
                    if (top <= contentTop && top > boundaryTop) {
                        boundaryTop = top;
                        boundaryIndex = messageIndexMap.get(id);
                        boundaryIsSlice = slice;
                        boundaryMessageId = id;
                    }
                }

                for (let position = candidateMessageIds.length - 1; position >= 0; position -= 1) {
                    const id = candidateMessageIds[position];
                    if (!id) continue;
                    const index = messageIndexMap.get(id);
                    if (index === undefined) continue;
                    const element = mounted.get(id);
                    if (element) {
                        const start = findReplyProseElement(element);
                        if (start && start.getBoundingClientRect().top - containerTop < contentTop) {
                            return id;
                        }
                        continue;
                    }
                    if (boundaryMessageId === id && boundaryIsSlice) {
                        return id;
                    }
                    if (boundaryIndex !== undefined && index < boundaryIndex) {
                        return id;
                    }
                }
                return null;
            },

            scrollToReplyStart: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                cancelNavigationRef.current?.();
                const behavior = options?.behavior ?? 'auto';
                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }

                let element = findReplyStartElement(messageId);
                if (!element) {
                    revealFoldedMessage(messageId);
                    element = findReplyStartElement(messageId);
                }
                const readInset = () => {
                    const start = findReplyStartElement(messageId);
                    return start ? replyTopInset(container, start) : MESSAGE_JUMP_GAP_PX;
                };
                if (element) {
                    const inset = replyTopInset(container, element);
                    const containerRect = container.getBoundingClientRect();
                    const elementRect = element.getBoundingClientRect();
                    const top = elementRect.top - containerRect.top + container.scrollTop - inset;
                    const list = listRef.current;
                    if (list && behavior !== 'smooth') {
                        void list.scrollToOffset({ offset: Math.max(0, top), animated: false });
                    } else {
                        container.scrollTo({ top, behavior });
                    }
                    if (behavior !== 'smooth') {
                        settleNavigationTarget(
                            () => findReplyStartElement(messageId),
                            readInset,
                            { throughList: true, rearmOnMeasurement: true },
                        );
                    }
                    return true;
                }

                const index = messageIndexMap.get(messageId);
                if (index === undefined || !scrollHistoryIndexIntoView(index)) {
                    return false;
                }
                if (behavior !== 'smooth') {
                    settleNavigationTarget(
                        () => findReplyStartElement(messageId),
                        readInset,
                        { throughList: true, rearmOnMeasurement: true },
                    );
                }
                return true;
            },

            holdViewportAnchor: (anchor) => {
                settleNavigationTarget(() => findAnchorElement(anchor), () => anchor.offsetTop);
            },

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
    }, [alignViewportAnchor, cancelNavigationRef, findAnchorElement, findMessageElement, findReplyStartElement, listRef, messageIndexMap, resolveScrollContainer, revealFoldedMessage, rowIndexByKey, scrollHistoryIndexIntoView, scrollMessageElementIntoView, settleNavigationTarget, turnIndexMap, ref]);
};
