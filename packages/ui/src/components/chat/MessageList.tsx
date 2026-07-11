import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { elementScroll, useVirtualizer as useTanstackVirtualizer, type ReactVirtualizer, type VirtualItem } from '@tanstack/react-virtual';

import ChatMessage from './ChatMessage';
import { areOptionalRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './message/renderCompare';
import TurnItem from './components/TurnItem';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { buildLiveStreamingEntry } from './lib/turns/streamingTailEntry';
import { getNormalizedMessageForDisplay, hasCompactionPart } from './lib/messageDisplayNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { hasPendingUserSendAnimation, consumePendingUserSendAnimation } from '@/lib/userSendAnimation';
import { streamPerfCount, streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionParts } from '@/sync/sync-context';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import type { ReviewTransferDirection } from '@/lib/reviewFlow';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { getInitialHistoryOverscan, getNextHistoryOverscan } from './lib/historyOverscan';
import { DeferredToolHydrationProvider } from './message/parts/DeferredToolHydrationProvider';
import { MarkdownHydrationProvider } from './markdown/MarkdownHydrationProvider';
import {
    createInitialMarkdownHydratedKeys,
    ensureNewestMarkdownKeyHydrated,
    getMarkdownHydrationCandidates,
    pruneMarkdownHydratedKeys,
    type MarkdownHydrationScrollDirection,
} from './lib/markdownHydrationWindow';

const MESSAGE_LIST_VIRTUALIZE_THRESHOLD = 5;
const EMPTY_STATIC_ENTRY_MESSAGES: ChatMessageEntry[] = [];
const EMPTY_UNGROUPED_MESSAGE_IDS = new Set<string>();
const TIMELINE_CACHE_LIMIT = 16;

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((key, index) => key === b[index]);
};

// --- History virtualization (@tanstack/react-virtual) ----------------------
// The history list virtualizes with @tanstack/react-virtual on all surfaces:
// its core has bottom anchoring (anchorTo: 'end'), key-stable prepend
// preservation, and native iOS touch/momentum deferral for scroll
// adjustments — the failure modes that historically forced virtua off on
// mobile and required manual prepend compensation on desktop.
type TanstackVirtualizerInstance = ReactVirtualizer<HTMLDivElement, HTMLDivElement>;
type HistoryEngine = 'none' | 'tanstack';

const TANSTACK_ESTIMATED_ENTRY_SIZE = 320;
const TANSTACK_OVERSCAN = 8;
// Touch flings cover more distance between paints than desktop wheels; a
// larger window keeps fast mobile scrolling over mounted rows.
const TANSTACK_MOBILE_OVERSCAN = 16;
const MARKDOWN_PRELOAD_ENTRIES = 3;
const resolveTanstackOverscan = (): number => (
    isMobileSurfaceRuntime() ? TANSTACK_MOBILE_OVERSCAN : TANSTACK_OVERSCAN
);
// Post-prepend anchor hold: measurements of freshly
// prepended rows settle over multiple frames, so a single restore can be
// invalidated by the next measurement pass. Re-assert the anchor until it
// holds still for STABLE_FRAMES consecutive frames, giving up at MAX_FRAMES.
const ANCHOR_HOLD_STABLE_FRAMES = 30;
const ANCHOR_HOLD_MAX_FRAMES = 180;
// Adaptive estimate bounds: only trust the session average once a few rows
// are measured, and keep it inside sane turn-height bounds.
const TANSTACK_ESTIMATE_MIN_SAMPLES = 5;
const TANSTACK_ESTIMATE_MIN = 120;
const TANSTACK_ESTIMATE_MAX = 1200;
// "At bottom" tolerance for resize-adjustment decisions.
const TANSTACK_AT_END_THRESHOLD_PX = 80;

// Quiet-window prepend on mobile: while a touch drag or momentum scroll is
// active, iOS owns the scroll position and ANY geometry change above the
// viewport races against the native animation — a race that compensation
// logic can only lose sometimes. So freshly loaded older history is held
// (data already fetched, store already updated) and inserted into the
// rendered list only once the gesture goes quiet. Safety valves: flush when
// the user gets close to the top (a blank top is worse than a small hop) or
// after MAX_HOLD_MS.
const HISTORY_PREPEND_QUIET_MS = 160;
const HISTORY_PREPEND_MAX_HOLD_MS = 1500;
const HISTORY_PREPEND_NEAR_TOP_VIEWPORTS = 1.5;
const HISTORY_PREPEND_MONITOR_INTERVAL_MS = 90;

// A commit is a deferable prepend when older entries were inserted strictly
// above the known content: the previous first key still exists deeper in the
// list and the tail is unchanged. Anything else renders immediately.
const isPrependAboveCommit = (previous: RenderEntry[], next: RenderEntry[]): boolean => {
    if (previous.length === 0 || next.length <= previous.length) return false;
    if (previous[previous.length - 1]?.key !== next[next.length - 1]?.key) return false;
    const previousFirstKey = previous[0]?.key;
    const insertedIndex = next.findIndex((entry) => entry.key === previousFirstKey);
    return insertedIndex > 0;
};

const tanstackTimelineCache = new Map<string, { keys: readonly string[]; items: VirtualItem[] }>();

const readTanstackTimelineCache = (sessionKey: string, keys: readonly string[]): VirtualItem[] | undefined => {
    const entry = tanstackTimelineCache.get(sessionKey);
    if (!entry) return undefined;
    if (sameKeys(entry.keys, keys)) return entry.items;
    tanstackTimelineCache.delete(sessionKey);
    return undefined;
};

const writeTanstackTimelineCache = (
    sessionKey: string,
    keys: readonly string[],
    virtualizer: TanstackVirtualizerInstance | null | undefined,
): void => {
    if (!virtualizer || keys.length === 0) return;
    tanstackTimelineCache.delete(sessionKey);
    tanstackTimelineCache.set(sessionKey, { keys: keys.slice(), items: virtualizer.takeSnapshot() });
    while (tanstackTimelineCache.size > TIMELINE_CACHE_LIMIT) {
        const oldest = tanstackTimelineCache.keys().next().value;
        if (typeof oldest !== 'string') break;
        tanstackTimelineCache.delete(oldest);
    }
};

const useStableEvent = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult) => {
    const handlerRef = React.useRef(handler);
    React.useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    return React.useCallback((...args: TArgs) => handlerRef.current(...args), []);
};

const USER_SHELL_MARKER = 'The following tool was executed by the user';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

const getPartText = (part: Part): string => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    return '';
};

const normalizeCompactionSummaryMessage = (
    message: ChatMessageEntry,
    compactionCommandIds: Set<string>,
): ChatMessageEntry => {
    const role = resolveMessageRole(message);
    if (role !== 'system') {
        return message;
    }

    const parentID = getMessageParentId(message);
    if (!parentID || !compactionCommandIds.has(parentID)) {
        return message;
    }

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    if (info.clientRole === 'assistant') {
        return message;
    }

    return {
        ...message,
        info: ({
            ...(message.info as unknown as Record<string, unknown>),
            clientRole: 'assistant',
        } as unknown as typeof message.info),
    };
};

const isAssistantMessageCompleted = (message: ChatMessageEntry): boolean => {
    const info = message.info as { time?: { completed?: unknown }; status?: unknown };
    const completed = info.time?.completed;
    const status = info.status;
    if (typeof completed !== 'number' || completed <= 0) {
        return false;
    }
    if (typeof status === 'string') {
        return status === 'completed';
    }
    return true;
};

const isUserSubtaskMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;
    return message.parts.some((part) => part?.type === 'subtask');
};

const getMessageId = (message: ChatMessageEntry | undefined): string | null => {
    if (!message) return null;
    const id = (message.info as unknown as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

const getMessageParentId = (message: ChatMessageEntry): string | null => {
    const parentID = (message.info as unknown as { parentID?: unknown }).parentID;
    return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

const isInsideStuckSticky = (node: HTMLElement, container: HTMLElement, containerTop: number): boolean => {
    if (typeof window === 'undefined') return false;

    let current: HTMLElement | null = node;
    while (current && current !== container) {
        const computed = window.getComputedStyle(current);
        if (computed.position === 'sticky' && current.getBoundingClientRect().top <= containerTop + 1) {
            return true;
        }
        current = current.parentElement;
    }

    return false;
};

const isUserShellMarkerMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;

    return message.parts.some((part) => {
        if (part?.type !== 'text') return false;
        const text = (part as unknown as { text?: unknown }).text;
        const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
        return synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER);
    });
};

type ShellBridgeDetails = {
    command?: string;
    output?: string;
    status?: string;
};

const getShellBridgeAssistantDetails = (message: ChatMessageEntry, expectedParentId: string | null): { hide: boolean; details: ShellBridgeDetails | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, details: null };
    }

    if (expectedParentId && getMessageParentId(message) !== expectedParentId) {
        return { hide: false, details: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, details: null };
    }

    const part = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
        state?: {
            status?: unknown;
            input?: { command?: unknown };
            output?: unknown;
            metadata?: { output?: unknown };
        };
    };

    if (part?.type !== 'tool') {
        return { hide: false, details: null };
    }

    const toolName = typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
    if (toolName !== 'bash') {
        return { hide: false, details: null };
    }

    const command = typeof part.state?.input?.command === 'string' ? part.state.input.command : undefined;
    const output =
        (typeof part.state?.output === 'string' ? part.state.output : undefined)
        ?? (typeof part.state?.metadata?.output === 'string' ? part.state.metadata.output : undefined);
    const status = typeof part.state?.status === 'string' ? part.state.status : undefined;

    return {
        hide: true,
        details: {
            command,
            output,
            status,
        },
    };
};

const readTaskSessionId = (toolPart: Part): string | null => {
    const partRecord = toolPart as unknown as {
        state?: {
            metadata?: {
                sessionId?: unknown;
                sessionID?: unknown;
            };
            output?: unknown;
        };
    };
    const metadata = partRecord.state?.metadata;
    const fromMetadata =
        (typeof metadata?.sessionID === 'string' && metadata.sessionID.trim().length > 0
            ? metadata.sessionID.trim()
            : null)
        ?? (typeof metadata?.sessionId === 'string' && metadata.sessionId.trim().length > 0
            ? metadata.sessionId.trim()
            : null);
    if (fromMetadata) return fromMetadata;

    const output = partRecord.state?.output;
    if (typeof output === 'string') {
        const match = output.match(/task_id\s*:\s*([^\s<"']+)/i);
        if (match?.[1]) {
            return match[1];
        }
    }

    return null;
};

const isSyntheticSubtaskBridgeAssistant = (message: ChatMessageEntry): { hide: boolean; taskSessionId: string | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, taskSessionId: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, taskSessionId: null };
    }

    const onlyPart = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
    } | null | undefined;

    if (onlyPart?.type !== 'tool') {
        return { hide: false, taskSessionId: null };
    }

    const toolName = typeof onlyPart.tool === 'string' ? onlyPart.tool.toLowerCase() : '';
    if (toolName !== 'task') {
        return { hide: false, taskSessionId: null };
    }

    return {
        hide: true,
        taskSessionId: readTaskSessionId(message.parts[0]),
    };
};

const withSubtaskSessionId = (message: ChatMessageEntry, taskSessionId: string | null): ChatMessageEntry => {
    if (!taskSessionId) return message;
    const nextParts = message.parts.map((part) => {
        if (part?.type !== 'subtask') return part;
        const existing = (part as unknown as { taskSessionID?: unknown }).taskSessionID;
        if (typeof existing === 'string' && existing.trim().length > 0) return part;
        return {
            ...part,
            taskSessionID: taskSessionId,
        } as Part;
    });

    return {
        ...message,
        parts: nextParts,
    };
};

const withShellBridgeDetails = (message: ChatMessageEntry, details: ShellBridgeDetails | null): ChatMessageEntry => {
    const command = typeof details?.command === 'string' ? details.command.trim() : '';
    const output = typeof details?.output === 'string' ? details.output : '';
    const status = typeof details?.status === 'string' ? details.status.trim() : '';

    const nextParts: Part[] = [];
    let injected = false;

    for (const part of message.parts) {
        if (!injected && part?.type === 'text') {
            const text = (part as unknown as { text?: unknown }).text;
            const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
            if (synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER)) {
                nextParts.push({
                    type: 'text',
                    text: '/shell',
                    shellAction: {
                        ...(command ? { command } : {}),
                        ...(output ? { output } : {}),
                        ...(status ? { status } : {}),
                    },
                } as unknown as Part);
                injected = true;
                continue;
            }
        }
        nextParts.push(part);
    }

    if (!injected) {
        nextParts.push({
            type: 'text',
            text: '/shell',
            shellAction: {
                ...(command ? { command } : {}),
                ...(output ? { output } : {}),
                ...(status ? { status } : {}),
            },
        } as unknown as Part);
    }

    return {
        ...message,
        parts: nextParts,
    };
};

interface MessageListProps {
    sessionKey: string;
    disableStaging?: boolean;
    messages: ChatMessageEntry[];
    sessionIsWorking?: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    retryOverlay?: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    isLoadingOlder: boolean;
    scrollToBottom?: () => void;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    directory?: string;
}

export interface MessageListHandle {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: () => void;
}

type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type TurnUiState = { isExpanded: boolean };



interface MessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    turnGroupingContext?: TurnGroupingContext;
    assistantHeaderMessageId?: string;
    isInActiveTurn?: boolean;
    activeStreamingPhase?: StreamPhase | null;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
    onContentChange: (reason?: ContentChangeReason) => void;
    animationHandlers: AnimationHandlers;
    scrollToBottom?: () => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const MessageRow = React.memo<MessageRowProps>(({ 
    message,
    previousMessage,
    nextMessage,
    turnGroupingContext,
    assistantHeaderMessageId,
    isInActiveTurn,
    activeStreamingPhase,
    animateUserOnMount,
    onUserAnimationConsumed,
    onContentChange,
    animationHandlers,
    scrollToBottom,
    reviewTransferDirection,
}) => {
    return (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={animateUserOnMount}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onContentChange}
            animationHandlers={animationHandlers}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
            assistantHeaderMessageId={assistantHeaderMessageId}
            isInActiveTurn={isInActiveTurn}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
}, (prev, next) => {
    const prevTurn = prev.turnGroupingContext;
    const nextTurn = next.turnGroupingContext;

    return areRenderRelevantMessagesEqual(prev.message, next.message)
        && areOptionalRenderRelevantMessagesEqual(prev.previousMessage, next.previousMessage)
        && areOptionalRenderRelevantMessagesEqual(prev.nextMessage, next.nextMessage)
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && prev.onContentChange === next.onContentChange
        && prev.scrollToBottom === next.scrollToBottom
        && areRelevantTurnGroupingContextsEqual(prevTurn, nextTurn, prev.message.info.id, resolveMessageRole(prev.message) === 'user')
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.reviewTransferDirection === next.reviewTransferDirection
        && prev.animationHandlers?.onChunk === next.animationHandlers?.onChunk
        && prev.animationHandlers?.onComplete === next.animationHandlers?.onComplete
        && prev.animationHandlers?.onStreamingCandidate === next.animationHandlers?.onStreamingCandidate
        && prev.animationHandlers?.onAnimationStart === next.animationHandlers?.onAnimationStart
        && prev.animationHandlers?.onReservationCancelled === next.animationHandlers?.onReservationCancelled
        && prev.animationHandlers?.onReasoningBlock === next.animationHandlers?.onReasoningBlock
        && prev.animationHandlers?.onAnimatedHeightChange === next.animationHandlers?.onAnimatedHeightChange;
});

MessageRow.displayName = 'MessageRow';

interface TurnBlockProps {
    turn: TurnRecord;
    isLastTurn: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const TurnBlock = React.memo(({
    turn,
    isLastTurn,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: TurnBlockProps) => {
    const turnUiState = turnUiStates.get(turn.turnId) ?? { isExpanded: defaultActivityExpanded };
    const handleToggleTurnGroup = React.useCallback(() => {
        onToggleTurnGroup(turn.turnId);
    }, [onToggleTurnGroup, turn.turnId]);

    const messageOrder = React.useMemo(() => {
        const ordered = [turn.userMessage, ...turn.assistantMessages];
        const lookup = new Map<string, number>();
        ordered.forEach((message, index) => {
            lookup.set(message.info.id, index);
        });
        return { ordered, lookup };
    }, [turn.assistantMessages, turn.userMessage]);

    const streamingAssistantMessageId = React.useMemo(() => {
        if (activeStreamingMessageId && turn.assistantMessages.some((assistant) => assistant.info.id === activeStreamingMessageId)) {
            return activeStreamingMessageId;
        }

        for (let index = turn.assistantMessages.length - 1; index >= 0; index -= 1) {
            const assistant = turn.assistantMessages[index];
            if (!isAssistantMessageCompleted(assistant)) {
                return assistant.info.id;
            }
        }

        return null;
    }, [activeStreamingMessageId, turn.assistantMessages]);

    const visibleAssistantMessages = React.useMemo(() => {
        if (chatRenderMode === 'live') {
            return turn.assistantMessages;
        }

        const completed = turn.assistantMessages.filter(isAssistantMessageCompleted);
        if (completed.length === turn.assistantMessages.length) {
            return turn.assistantMessages;
        }

        if (streamingAssistantMessageId) {
            const completedIds = new Set(completed.map((assistant) => assistant.info.id));
            return turn.assistantMessages.filter((assistant) => (
                completedIds.has(assistant.info.id)
                || assistant.info.id === streamingAssistantMessageId
            ));
        }

        if (completed.length > 0) {
            return completed;
        }
        const firstAssistant = turn.assistantMessages[0];
        return firstAssistant ? [firstAssistant] : [];
    }, [chatRenderMode, streamingAssistantMessageId, turn.assistantMessages]);

    const completedAssistantMessages = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.assistantMessages;
        }
        return turn.assistantMessages.filter(isAssistantMessageCompleted);
    }, [chatRenderMode, turn.assistantMessages]);

    const visibleAssistantIds = React.useMemo(() => {
        const ids = new Map<string, number>();
        visibleAssistantMessages.forEach((assistant, index) => {
            ids.set(assistant.info.id, index);
        });
        return ids;
    }, [visibleAssistantMessages]);

    const completedAssistantIdSet = React.useMemo(() => {
        return new Set(completedAssistantMessages.map((assistant) => assistant.info.id));
    }, [completedAssistantMessages]);

    const visibleActivityMessageIdSet = React.useMemo(() => {
        const ids = new Set(completedAssistantIdSet);
        if (streamingAssistantMessageId) {
            ids.add(streamingAssistantMessageId);
        }
        return ids;
    }, [completedAssistantIdSet, streamingAssistantMessageId]);

    const turnIsInActiveStream = React.useMemo(() => {
        return turnContainsMessageId(turn, streamingAssistantMessageId);
    }, [turn, streamingAssistantMessageId]);

    const activityOwnerMessageId = React.useMemo(() => {
        if (turnIsInActiveStream && streamingAssistantMessageId) {
            return streamingAssistantMessageId;
        }
        return visibleAssistantMessages[0]?.info.id;
    }, [streamingAssistantMessageId, turnIsInActiveStream, visibleAssistantMessages]);

    const visibleActivityParts = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.activityParts;
        }
        if (visibleActivityMessageIdSet.size === turn.assistantMessages.length) {
            return turn.activityParts;
        }
        return turn.activityParts.filter((activity) => visibleActivityMessageIdSet.has(activity.messageId));
    }, [chatRenderMode, visibleActivityMessageIdSet, turn.activityParts, turn.assistantMessages.length]);

    const visibleActivitySegments = React.useMemo(() => {
        if (chatRenderMode !== 'sorted') {
            return turn.activitySegments;
        }
        if (visibleActivityMessageIdSet.size === turn.assistantMessages.length) {
            return turn.activitySegments;
        }
        return turn.activitySegments
            .map((segment) => {
                const parts = segment.parts.filter((activity) => visibleActivityMessageIdSet.has(activity.messageId));
                if (parts.length === 0) {
                    return null;
                }
                const anchorMessageId = visibleActivityMessageIdSet.has(segment.anchorMessageId)
                    ? segment.anchorMessageId
                    : parts[0]?.messageId;
                if (!anchorMessageId) {
                    return null;
                }
                return {
                    ...segment,
                    anchorMessageId,
                    parts,
                };
            })
            .filter((segment): segment is NonNullable<typeof segment> => segment !== null);
    }, [chatRenderMode, visibleActivityMessageIdSet, turn.activitySegments, turn.assistantMessages.length]);

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
        // OpenCode 1.4.0 moved variant from top-level to model.variant on UserMessage.
        // Prefer the new location, fall back to the legacy one for older servers.
        const info = turn.userMessage.info as { variant?: unknown; model?: { variant?: unknown } } | undefined;
        const rawVariant = info?.model?.variant ?? info?.variant;
        const userMessageVariant = typeof rawVariant === 'string' && rawVariant.trim().length > 0
            ? rawVariant
            : undefined;
        return {
            turnId: turn.turnId,
            summaryBody: turn.summaryText,
            activityParts: visibleActivityParts,
            activityGroupSegments: visibleActivitySegments,
            headerMessageId: turn.headerMessageId,
            hasTools: turn.hasTools,
            hasReasoning: turn.hasReasoning,
            diffStats: turn.diffStats,
            changedFiles: turn.changedFiles,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            userMessageVariant,
        };
    }, [turn.changedFiles, turn.diffStats, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.summaryText, turn.turnId, turn.userMessage.info, visibleActivityParts, visibleActivitySegments]);

    const renderMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const messageRole = resolveMessageRole(message);
            const isUserMessage = messageRole === 'user';
            const messageIndex = messageOrder.lookup.get(message.info.id);
            const assistantIndex = visibleAssistantIds.get(message.info.id) ?? -1;
            const isAssistantMessage = assistantIndex >= 0;
            const isFirstAssistant = assistantIndex === 0;
            const isLastAssistant = assistantIndex === visibleAssistantMessages.length - 1;
            const isActivityOwner = Boolean(activityOwnerMessageId) && message.info.id === activityOwnerMessageId;
            const hasAnchoredActivitySegment = visibleActivitySegments.some((segment) => segment.anchorMessageId === message.info.id);
            const shouldAttachFullTurnContext = chatRenderMode === 'sorted'
                ? isAssistantMessage
                : (isActivityOwner || isFirstAssistant || isLastAssistant);
            const assistantHeaderMessageId = visibleAssistantMessages[0]?.info.id ?? turn.headerMessageId;

            const previousMessage = isUserMessage
                ? undefined
                : (isAssistantMessage
                    ? (isFirstAssistant
                        ? turn.userMessage
                        : undefined)
                    : (typeof messageIndex === 'number' && messageIndex > 0
                        ? messageOrder.ordered[messageIndex - 1]
                        : undefined));
            const nextMessage = undefined;

            const turnGroupingContext = isAssistantMessage
                ? {
                    turnId: turn.turnId,
                    activityOwnerMessageId,
                    isFirstAssistantInTurn: isFirstAssistant,
                    isLastAssistantInTurn: isLastAssistant,
                    isLatestTurn: isLastTurn,
                    isWorking: isLastTurn && sessionIsWorking && (
                        chatRenderMode === 'sorted'
                            ? hasAnchoredActivitySegment
                            : message.info.id === streamingAssistantMessageId
                    ),
                    hasTools: turn.hasTools,
                    hasReasoning: turn.hasReasoning,
                    ...(shouldAttachFullTurnContext ? {
                        summaryBody: turnGroupingContextBase.summaryBody,
                        activityParts: turnGroupingContextBase.activityParts,
                        activityGroupSegments: turnGroupingContextBase.activityGroupSegments,
                        headerMessageId: turnGroupingContextBase.headerMessageId,
                        diffStats: turnGroupingContextBase.diffStats,
                        changedFiles: turnGroupingContextBase.changedFiles,
                        userMessageCreatedAt: turnGroupingContextBase.userMessageCreatedAt,
                        userMessageVariant: turnGroupingContextBase.userMessageVariant,
                        isGroupExpanded: turnUiState.isExpanded,
                        toggleGroup: handleToggleTurnGroup,
                    } : {}),
                } satisfies TurnGroupingContext
                : undefined;

            return (
                <MessageRow
                    key={message.info.id}
                    message={message}
                    previousMessage={previousMessage}
                    nextMessage={nextMessage}
                    turnGroupingContext={turnGroupingContext}
                    assistantHeaderMessageId={assistantHeaderMessageId}
                    isInActiveTurn={Boolean(streamingAssistantMessageId) && message.info.id === streamingAssistantMessageId}
                    activeStreamingPhase={message.info.id === streamingAssistantMessageId ? activeStreamingPhase : null}
                    reviewTransferDirection={reviewTransferDirection}
                    animateUserOnMount={shouldAnimateUserMessage(message)}
                    onUserAnimationConsumed={onUserAnimationConsumed}
                    onContentChange={onMessageContentChange}
                    animationHandlers={getAnimationHandlers(message.info.id)}
                    scrollToBottom={scrollToBottom}
                />
            );
        },
        [
            getAnimationHandlers,
            isLastTurn,
            messageOrder.lookup,
            messageOrder.ordered,
            onMessageContentChange,
            scrollToBottom,
            sessionIsWorking,
            chatRenderMode,
            turn.headerMessageId,
            turn.hasReasoning,
            turn.hasTools,
            turn.turnId,
            turn.userMessage,
            turnUiState.isExpanded,
            turnGroupingContextBase,
            streamingAssistantMessageId,
            activeStreamingPhase,
            reviewTransferDirection,
            visibleAssistantMessages,
            visibleAssistantIds,
            visibleActivitySegments,
            activityOwnerMessageId,
            shouldAnimateUserMessage,
            onUserAnimationConsumed,
            handleToggleTurnGroup,
        ]
    );

    const renderableTurn = React.useMemo(() => {
        if (visibleAssistantMessages === turn.assistantMessages) {
            return turn;
        }
        return {
            ...turn,
            assistantMessages: visibleAssistantMessages,
        };
    }, [turn, visibleAssistantMessages]);

    return (
        <TurnItem turn={renderableTurn} stickyUserHeader={stickyUserHeader} renderMessage={renderMessage} />
    );
});

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const UngroupedMessageRow = React.memo(({
    message,
    previousMessage,
    nextMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: UngroupedMessageRowProps) => {
    return (
        <MessageRow
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onMessageContentChange}
            animationHandlers={getAnimationHandlers(message.info.id)}
            scrollToBottom={scrollToBottom}
            isInActiveTurn={Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId}
            activeStreamingPhase={message.info.id === activeStreamingMessageId ? activeStreamingPhase : null}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';

interface MessageListEntryProps {
    entry: RenderEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}

const turnContainsMessageId = (turn: TurnRecord, messageId: string | null | undefined): boolean => {
    if (!messageId) {
        return false;
    }

    if (turn.userMessage.info.id === messageId) {
        return true;
    }

    return turn.assistantMessages.some((assistant) => assistant.info.id === messageId);
};

const MessageListEntry = React.memo(({
    entry,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}: MessageListEntryProps) => {
    if (entry.kind === 'ungrouped') {
        return (
            <UngroupedMessageRow
                message={entry.message}
                previousMessage={entry.previousMessage}
                nextMessage={entry.nextMessage}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                activeStreamingMessageId={activeStreamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                reviewTransferDirection={reviewTransferDirection}
            />
        );
    }

    return (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnUiStates={turnUiStates}
            onToggleTurnGroup={onToggleTurnGroup}
            chatRenderMode={chatRenderMode}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
        />
    );
});

MessageListEntry.displayName = 'MessageListEntry';

// Inner component that renders staged turn entries.
type StaticHistoryListProps = {
    entries: RenderEntry[];
    engine: HistoryEngine;
    contentRef: React.RefObject<HTMLDivElement | null>;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    registerTanstackVirtualizer?: (virtualizer: TanstackVirtualizerInstance | null) => void;
    virtualizerKey: string;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    reviewTransferDirection?: ReviewTransferDirection | null;
};

const StaticHistoryList = React.memo(({ entries, engine, contentRef, scrollRef, registerTanstackVirtualizer, virtualizerKey, onMessageContentChange, getAnimationHandlers, scrollToBottom, stickyUserHeader, defaultActivityExpanded, turnUiStates, onToggleTurnGroup, chatRenderMode, shouldAnimateUserMessage, onUserAnimationConsumed, reviewTransferDirection }: StaticHistoryListProps) => {
    const isTanstack = engine === 'tanstack';

    // --- Quiet-window prepend (mobile) --------------------------------------
    // Gesture tracking for the deferred-prepend decision. Refs only: reading
    // them never re-renders, and the render-phase reconcile below needs them.
    const touchActiveRef = React.useRef(false);
    const lastScrollAtRef = React.useRef(0);
    const holdSinceRef = React.useRef<number | null>(null);
    const deferPrepends = isTanstack && isMobileSurfaceRuntime();

    React.useEffect(() => {
        if (!deferPrepends) return;
        const element = scrollRef?.current;
        if (!element) return;
        const onTouchStart = () => { touchActiveRef.current = true; };
        const onTouchEnd = () => { touchActiveRef.current = false; };
        const onScroll = () => { lastScrollAtRef.current = performance.now(); };
        element.addEventListener('touchstart', onTouchStart, { passive: true });
        element.addEventListener('touchend', onTouchEnd, { passive: true });
        element.addEventListener('touchcancel', onTouchEnd, { passive: true });
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            element.removeEventListener('touchstart', onTouchStart);
            element.removeEventListener('touchend', onTouchEnd);
            element.removeEventListener('touchcancel', onTouchEnd);
            element.removeEventListener('scroll', onScroll);
        };
    }, [deferPrepends, scrollRef]);

    const isGestureActive = React.useCallback(() => (
        touchActiveRef.current
        || performance.now() - lastScrollAtRef.current < HISTORY_PREPEND_QUIET_MS
    ), []);

    const isNearTop = React.useCallback(() => {
        const element = scrollRef?.current;
        if (!element) return true;
        return element.scrollTop < element.clientHeight * HISTORY_PREPEND_NEAR_TOP_VIEWPORTS;
    }, [scrollRef]);

    const [displayEntries, setDisplayEntries] = React.useState(entries);
    // Render-phase reconcile (official derived-state pattern): adopt the new
    // entries immediately unless this commit is a pure prepend-above landing
    // in the middle of an active touch gesture — those wait for quiet.
    let renderEntries = displayEntries;
    if (entries !== displayEntries) {
        const shouldHold = deferPrepends
            && isPrependAboveCommit(displayEntries, entries)
            && isGestureActive()
            && !isNearTop()
            && (holdSinceRef.current === null
                || performance.now() - holdSinceRef.current < HISTORY_PREPEND_MAX_HOLD_MS);
        if (shouldHold) {
            if (holdSinceRef.current === null) holdSinceRef.current = performance.now();
        } else {
            holdSinceRef.current = null;
            setDisplayEntries(entries);
            renderEntries = entries;
        }
    } else if (holdSinceRef.current !== null) {
        holdSinceRef.current = null;
    }

    // While a prepend is held, poll for the quiet window (touch/momentum have
    // no completion event we can await) and flush by re-rendering.
    const [, forceFlushTick] = React.useReducer((tick: number) => tick + 1, 0);
    React.useEffect(() => {
        if (!deferPrepends) return;
        const timer = window.setInterval(() => {
            if (holdSinceRef.current === null) return;
            const expired = performance.now() - holdSinceRef.current >= HISTORY_PREPEND_MAX_HOLD_MS;
            if (!isGestureActive() || isNearTop() || expired) {
                forceFlushTick();
            }
        }, HISTORY_PREPEND_MONITOR_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [deferPrepends, isGestureActive, isNearTop]);

    const entriesRef = React.useRef(renderEntries);
    entriesRef.current = renderEntries;
    const entryKeys = React.useMemo(
        () => renderEntries.map((entry) => entry.key),
        [renderEntries],
    );
    const targetOverscan = resolveTanstackOverscan();
    const [historyOverscan, setHistoryOverscan] = React.useState(() => getInitialHistoryOverscan(targetOverscan));
    React.useEffect(() => {
        if (!isTanstack || historyOverscan >= targetOverscan) {
            return;
        }
        return scheduleAfterPaintTask(() => {
            React.startTransition(() => {
                setHistoryOverscan((current) => getNextHistoryOverscan(current, targetOverscan));
            });
        });
    }, [historyOverscan, isTanstack, targetOverscan]);
    // Initial-only read: measurement cache restore is a mount-time concern;
    // afterwards the live virtualizer owns measurements.
    const [initialMeasurements] = React.useState(() => (
        isTanstack
            ? readTanstackTimelineCache(virtualizerKey, entries.map((entry) => entry.key))
            : undefined
    ));

    const sizeContainerRef = React.useRef<HTMLDivElement | null>(null);
    // Adaptive estimate: rows this session has actually measured are a far
    // better predictor for the still-unmeasured ones than a fixed constant.
    // Smaller estimate error → smaller anchor corrections when prepended rows
    // measure in → less visible drift. The ref keeps estimateSize's identity
    // stable so updating the average never triggers a global remeasure.
    const estimatedEntrySizeRef = React.useRef(TANSTACK_ESTIMATED_ENTRY_SIZE);
    const tanstackVirtualizer = useTanstackVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: renderEntries.length,
        enabled: isTanstack,
        getScrollElement: () => scrollRef?.current ?? null,
        estimateSize: () => estimatedEntrySizeRef.current,
        overscan: historyOverscan,
        scrollToFn: (offset, options, instance) => {
            // Expose the new total height before core writes an anchor
            // correction so the browser does not clamp the offset to the old
            // height.
            const sizeElement = sizeContainerRef.current;
            if (sizeElement) sizeElement.style.height = `${instance.getTotalSize()}px`;
            elementScroll(offset, options, instance);
        },
        getItemKey: (index) => entriesRef.current[index]?.key ?? `index:${index}`,
        // Bottom-anchored chat semantics: prepending older entries above the
        // viewport must not move what the user is reading, and iOS-specific
        // touch/momentum deferral for those adjustments lives in the core.
        anchorTo: 'end',
        initialOffset: () => Number.MAX_SAFE_INTEGER,
        initialMeasurementsCache: initialMeasurements,
    });
    // Only compensate scroll for rows growing ABOVE the viewport (history
    // remeasures, prepended pages). A row growing inside the viewport —
    // expanding a tool call or thinking block — must grow DOWNWARD naturally;
    // the end-anchored default made it expand upward. At the bottom,
    // app-level auto-follow owns pinning, so skip there too instead of
    // double-writing. (This is an instance field, not a constructor option.)
    tanstackVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
        if (instance.isAtEnd(TANSTACK_AT_END_THRESHOLD_PX)) return false;
        const firstVisibleIndex = instance.range?.startIndex;
        return firstVisibleIndex !== undefined && item.index < firstVisibleIndex;
    };
    const virtualItems = tanstackVirtualizer.getVirtualItems();
    const mountedIndexes = virtualItems.map((item) => item.index);
    const [hydratedMarkdownEntryKeys, setHydratedMarkdownEntryKeys] = React.useState(() => (
        createInitialMarkdownHydratedKeys(entryKeys)
    ));
    // Streaming-tail Markdown is already painted. When that turn remounts into
    // history it must stay hydrated in this same render — an after-paint seed
    // would flash the deferred skeleton over finished content.
    const activeHydratedMarkdownEntryKeys = ensureNewestMarkdownKeyHydrated(
        hydratedMarkdownEntryKeys,
        entryKeys,
    );
    if (activeHydratedMarkdownEntryKeys !== hydratedMarkdownEntryKeys) {
        setHydratedMarkdownEntryKeys(activeHydratedMarkdownEntryKeys);
    }
    const lastScrollDirectionRef = React.useRef<MarkdownHydrationScrollDirection>(null);
    if (tanstackVirtualizer.scrollDirection) {
        lastScrollDirectionRef.current = tanstackVirtualizer.scrollDirection;
    }
    const visibleRangeStart = tanstackVirtualizer.range?.startIndex
        ?? virtualItems[0]?.index
        ?? Math.max(0, renderEntries.length - 1);
    const visibleRangeEnd = tanstackVirtualizer.range?.endIndex
        ?? virtualItems[virtualItems.length - 1]?.index
        ?? Math.max(0, renderEntries.length - 1);
    const markdownHydrationCandidates = getMarkdownHydrationCandidates({
        entryKeys,
        mountedIndexes,
        visibleStartIndex: visibleRangeStart,
        visibleEndIndex: visibleRangeEnd,
        scrollDirection: lastScrollDirectionRef.current,
        preloadEntries: MARKDOWN_PRELOAD_ENTRIES,
        hydratedKeys: activeHydratedMarkdownEntryKeys,
    });
    const nextMarkdownHydrationKey = markdownHydrationCandidates[0];
    const deferMarkdownHydrationForMobileScroll = isMobileSurfaceRuntime()
        && tanstackVirtualizer.isScrolling;

    React.useEffect(() => {
        if (!isTanstack || !nextMarkdownHydrationKey || deferMarkdownHydrationForMobileScroll) {
            return;
        }
        return scheduleAfterPaintTask(() => {
            React.startTransition(() => {
                setHydratedMarkdownEntryKeys((current) => {
                    if (current.has(nextMarkdownHydrationKey)) {
                        return current;
                    }
                    const next = new Set(current);
                    next.add(nextMarkdownHydrationKey);
                    return next;
                });
            });
        });
    }, [deferMarkdownHydrationForMobileScroll, isTanstack, nextMarkdownHydrationKey]);

    React.useEffect(() => {
        setHydratedMarkdownEntryKeys((current) => pruneMarkdownHydratedKeys(current, entryKeys));
    }, [entryKeys]);

    React.useEffect(() => {
        if (!isTanstack) return;
        const sizes = tanstackVirtualizer.itemSizeCache;
        if (sizes.size >= TANSTACK_ESTIMATE_MIN_SAMPLES) {
            let total = 0;
            for (const size of sizes.values()) total += size;
            estimatedEntrySizeRef.current = Math.min(
                TANSTACK_ESTIMATE_MAX,
                Math.max(TANSTACK_ESTIMATE_MIN, Math.round(total / sizes.size)),
            );
        }
    });

    React.useEffect(() => {
        if (!isTanstack) return;
        registerTanstackVirtualizer?.(tanstackVirtualizer);
        return () => {
            writeTanstackTimelineCache(
                virtualizerKey,
                entriesRef.current.map((entry) => entry.key),
                tanstackVirtualizer,
            );
            registerTanstackVirtualizer?.(null);
        };
    }, [isTanstack, registerTanstackVirtualizer, tanstackVirtualizer, virtualizerKey]);

    const renderEntry = React.useCallback((entry: RenderEntry, hydrateMarkdown = true) => {
        return (
            <MarkdownHydrationProvider enabled={hydrateMarkdown}>
                <MessageListEntry
                    key={entry.key}
                    entry={entry}
                    onMessageContentChange={onMessageContentChange}
                    getAnimationHandlers={getAnimationHandlers}
                    scrollToBottom={scrollToBottom}
                    stickyUserHeader={stickyUserHeader}
                    sessionIsWorking={false}
                    defaultActivityExpanded={defaultActivityExpanded}
                    turnUiStates={turnUiStates}
                    onToggleTurnGroup={onToggleTurnGroup}
                    chatRenderMode={chatRenderMode}
                    shouldAnimateUserMessage={shouldAnimateUserMessage}
                    onUserAnimationConsumed={onUserAnimationConsumed}
                    activeStreamingMessageId={null}
                    activeStreamingPhase={null}
                    reviewTransferDirection={reviewTransferDirection}
                />
            </MarkdownHydrationProvider>
        );
    }, [chatRenderMode, defaultActivityExpanded, getAnimationHandlers, onMessageContentChange, onToggleTurnGroup, onUserAnimationConsumed, reviewTransferDirection, scrollToBottom, shouldAnimateUserMessage, stickyUserHeader, turnUiStates]);

    if (engine === 'none') {
        return (
            <div ref={contentRef} className="relative w-full">
                {renderEntries.map((entry) => (
                    <div
                        key={entry.key}
                        data-turn-entry={entry.key}
                    >
                        {renderEntry(entry)}
                    </div>
                ))}
            </div>
        );
    }

    if (engine === 'tanstack') {
        const startOffset = virtualItems[0]?.start ?? 0;
        // Rendered rows stay in normal flow inside a single offset wrapper (not
        // per-row absolute positioning) so per-turn sticky user headers keep
        // working against the scroll container. The offset MUST be padding, not
        // transform: a transformed ancestor becomes the sticky containing block,
        // so headers would stick to the wrapper's (arbitrary, overscan-dependent)
        // top edge mid-list and float over the previous turn. Padding only
        // changes when the virtual window shifts — not per scroll frame — so the
        // layout cost is negligible.
        return (
            <div ref={sizeContainerRef} className="relative w-full" style={{ height: tanstackVirtualizer.getTotalSize() }}>
                <div style={{ paddingTop: `${startOffset}px` }}>
                    {virtualItems.map((item) => {
                        const entry = renderEntries[item.index];
                        if (!entry) return null;
                        return (
                            <div
                                key={entry.key}
                                data-index={item.index}
                                ref={tanstackVirtualizer.measureElement}
                                data-turn-entry={entry.key}
                            >
                                {renderEntry(
                                    entry,
                                    activeHydratedMarkdownEntryKeys.has(entry.key),
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    return null;
});

StaticHistoryList.displayName = 'StaticHistoryList';

const StreamingTailContent: React.FC<{
    entry: RenderEntry;
    directory?: string;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    defaultActivityExpanded: boolean;
    turnUiStates: Map<string, TurnUiState>;
    onToggleTurnGroup: (turnId: string) => void;
    chatRenderMode: 'sorted' | 'live';
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    reviewTransferDirection?: ReviewTransferDirection | null;
}> = ({
    entry,
    directory,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    defaultActivityExpanded,
    turnUiStates,
    onToggleTurnGroup,
    chatRenderMode,
    showTurnChangedFiles,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    reviewTransferDirection,
}) => {
    const liveParts = useSessionParts(activeStreamingMessageId ?? '', directory);
    const liveEntry = React.useMemo(() => buildLiveStreamingEntry(entry, {
        activeStreamingMessageId,
        liveParts,
        showTextJustificationActivity: chatRenderMode === 'sorted',
        showTurnChangedFiles,
    }), [activeStreamingMessageId, chatRenderMode, entry, liveParts, showTurnChangedFiles]);

    return (
        <MessageListEntry
            entry={liveEntry}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
            sessionIsWorking={sessionIsWorking}
            defaultActivityExpanded={defaultActivityExpanded}
            turnUiStates={turnUiStates}
            onToggleTurnGroup={onToggleTurnGroup}
            chatRenderMode={chatRenderMode}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            reviewTransferDirection={reviewTransferDirection}
        />
    );
};

StreamingTailContent.displayName = 'StreamingTailContent';

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
    sessionKey,
    messages,
    sessionIsWorking = false,
    activeStreamingMessageId = null,
    activeStreamingPhase = null,
    retryOverlay = null,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    scrollRef,
    directory,
}, ref) => {
    streamPerfCount('ui.message_list.render');
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const activityRenderMode = useUIStore((state) => state.activityRenderMode);
    const showTurnChangedFiles = useUIStore((state) => state.showTurnChangedFiles);
    const defaultActivityExpanded = activityRenderMode === 'summary';
    const reviewTransferDirection = useGlobalSessionsStore((state) => {
        return state.reviewTransferBySessionId.get(sessionKey) ?? null;
    });
    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, TurnUiState>>(() => new Map());
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });
    const stableGetAnimationHandlers = useStableEvent(getAnimationHandlers);
    const stableScrollToBottom = useStableEvent(() => {
        scrollToBottom?.();
    });

    React.useEffect(() => {
        setTurnUiStates(new Map());
    }, [activityRenderMode]);

    const toggleTurnGroup = React.useCallback((turnId: string) => {
        setTurnUiStates((previous) => {
            const next = new Map(previous);
            const current = next.get(turnId) ?? { isExpanded: defaultActivityExpanded };
            next.set(turnId, { isExpanded: !current.isExpanded });
            return next;
        });
    }, [defaultActivityExpanded]);


    const baseDisplayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.base_display_ms', () => {
        const seenIdsFromTail = new Set<string>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            const messageId = message.info?.id;
            if (typeof messageId === 'string') {
                if (seenIdsFromTail.has(messageId)) {
                    continue;
                }
                seenIdsFromTail.add(messageId);
            }
            dedupedMessages.push(getNormalizedMessageForDisplay(message));
        }
        dedupedMessages.reverse();

        const output: ChatMessageEntry[] = [];
        const compactionCommandIds = new Set<string>();
        for (let index = 0; index < dedupedMessages.length; index += 1) {
            const current = dedupedMessages[index];
            const currentWithRole = normalizeCompactionSummaryMessage(current, compactionCommandIds);
            if (hasCompactionPart(current) || current.parts.some((part) => part.type === 'text' && getPartText(part).trim() === '/compact')) {
                compactionCommandIds.add(current.info.id);
            }
            const previous = output.length > 0 ? output[output.length - 1] : undefined;

            if (isUserSubtaskMessage(previous)) {
                const bridge = isSyntheticSubtaskBridgeAssistant(currentWithRole);
                if (bridge.hide) {
                    output[output.length - 1] = withSubtaskSessionId(previous as ChatMessageEntry, bridge.taskSessionId);
                    continue;
                }
            }

            if (isUserShellMarkerMessage(previous)) {
                const bridge = getShellBridgeAssistantDetails(currentWithRole, getMessageId(previous));
                if (bridge.hide) {
                    output[output.length - 1] = withShellBridgeDetails(previous as ChatMessageEntry, bridge.details);
                    continue;
                }
            }

            output.push(currentWithRole);
        }

        return output;
    }), [messages]);

    const historyContentRef = React.useRef<HTMLDivElement | null>(null);
    const resolveScrollContainer = React.useCallback((): HTMLDivElement | null => {
        if (scrollRef?.current) {
            return scrollRef.current;
        }
        if (typeof document === 'undefined') {
            return null;
        }
        return document.querySelector<HTMLDivElement>('[data-scrollbar="chat"]');
    }, [scrollRef]);

    const displayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.retry_overlay_ms', () => {
        return applyRetryOverlay(baseDisplayMessages, {
            sessionId: retryOverlay?.sessionId ?? null,
            message: retryOverlay?.message ?? 'Quota limit reached. Retrying automatically.',
            confirmedAt: retryOverlay?.confirmedAt,
            fallbackTimestamp: retryOverlay?.fallbackTimestamp ?? 0,
        });
    }), [baseDisplayMessages, retryOverlay]);

    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTextJustificationActivity: chatRenderMode === 'sorted',
        showTurnChangedFiles,
        hasLiveTail: sessionIsWorking || Boolean(activeStreamingMessageId),
    });
    const hasUngroupedStaticEntries = projection.ungroupedMessageIds.size > 0;
    const staticEntryMessages = hasUngroupedStaticEntries ? displayMessages : EMPTY_STATIC_ENTRY_MESSAGES;
    const staticEntryUngroupedIds = hasUngroupedStaticEntries ? projection.ungroupedMessageIds : EMPTY_UNGROUPED_MESSAGE_IDS;
    const staticRenderEntries = React.useMemo<RenderEntry[]>(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const turnEntries = staticTurns.map((turn) => ({
            kind: 'turn' as const,
            key: `turn:${turn.turnId}`,
            turn,
            isLastTurn: turn.turnId === projection.lastTurnId,
        }));

        if (staticEntryUngroupedIds.size === 0) {
            return turnEntries;
        }

        const turnEntryByUserMessageId = new Map<string, RenderEntry>();
        turnEntries.forEach((entry) => {
            turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry);
        });

        const orderedEntries: RenderEntry[] = [];
        staticEntryMessages.forEach((message, index) => {
            const turnEntry = turnEntryByUserMessageId.get(message.info.id);
            if (turnEntry) {
                orderedEntries.push(turnEntry);
                return;
            }

            if (!staticEntryUngroupedIds.has(message.info.id)) {
                return;
            }

            orderedEntries.push({
                kind: 'ungrouped',
                key: `msg:${message.info.id}`,
                message,
                previousMessage: index > 0 ? staticEntryMessages[index - 1] : undefined,
                nextMessage: index < staticEntryMessages.length - 1 ? staticEntryMessages[index + 1] : undefined,
            });
        });

        return orderedEntries;
    }), [projection.lastTurnId, staticEntryMessages, staticEntryUngroupedIds, staticTurns]);

    const trailingStreamingEntry = React.useMemo<RenderEntry | undefined>(() => {
        if (streamingTurn) {
            return {
                kind: 'turn',
                key: `turn:${streamingTurn.turnId}`,
                turn: streamingTurn,
                isLastTurn: streamingTurn.turnId === projection.lastTurnId,
            } satisfies RenderEntry;
        }

        if (projection.ungroupedMessageIds.size === 0) {
            return undefined;
        }

        const lastMessage = displayMessages[displayMessages.length - 1];
        if (!lastMessage || !projection.ungroupedMessageIds.has(lastMessage.info.id)) {
            return undefined;
        }

        return {
            kind: 'ungrouped',
            key: `msg:${lastMessage.info.id}`,
            message: lastMessage,
            previousMessage: displayMessages.length > 1 ? displayMessages[displayMessages.length - 2] : undefined,
            nextMessage: undefined,
        } satisfies RenderEntry;
    }, [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, streamingTurn]);

    if (trailingStreamingEntry) {
        streamPerfCount('ui.message_list.render.streaming');
    }

    const historyEntries = staticRenderEntries;
    // All surfaces virtualize with @tanstack/react-virtual (see the engine
    // note at the top of the file). An unvirtualized list is kept only for
    // tiny histories where windowing overhead is not worth it.
    const shouldVirtualizeHistory = historyEntries.length >= MESSAGE_LIST_VIRTUALIZE_THRESHOLD;
    const historyEngine: HistoryEngine = shouldVirtualizeHistory ? 'tanstack' : 'none';
    const tanstackVirtualizerRef = React.useRef<TanstackVirtualizerInstance | null>(null);
    const registerTanstackVirtualizer = React.useCallback((virtualizer: TanstackVirtualizerInstance | null) => {
        tanstackVirtualizerRef.current = virtualizer;
    }, []);

    const allEntries = React.useMemo(() => {
        return trailingStreamingEntry ? [...historyEntries, trailingStreamingEntry] : historyEntries;
    }, [historyEntries, trailingStreamingEntry]);

    const stableHistoryContentChange = useStableEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const stableTailContentChange = useStableEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const currentUserOrder = React.useMemo(() => {
        return messages
            .filter((message) => resolveMessageRole(message) === 'user')
            .map((message) => message.info.id);
    }, [messages]);

    // Detect new user messages SYNCHRONOUSLY during render.
    // Must happen during render (not in useEffect) so that ToolRevealOnMount
    // receives animate=true on the FIRST render of the new message,
    // starting it hidden (opacity 0). An effect-based approach causes
    // the message to flash visible before the animation starts.
    {
        const anim = userAnimationRef.current;

        // Reset on session switch
        if (anim.sessionKey !== sessionKey) {
            anim.sessionKey = sessionKey;
            anim.previousOrder = currentUserOrder;
            anim.animatedIds = new Set();
        }

        // Detect appended user messages
        const prev = anim.previousOrder;
        if (currentUserOrder.length > prev.length) {
            const isAppendOnly = prev.every((id, i) => currentUserOrder[i] === id);
            if (isAppendOnly && hasPendingUserSendAnimation(sessionKey)) {
                for (let i = prev.length; i < currentUserOrder.length; i += 1) {
                    const id = currentUserOrder[i];
                    if (id && !anim.animatedIds.has(id)) {
                        if (!consumePendingUserSendAnimation(sessionKey)) break;
                        anim.animatedIds.add(id);
                    }
                }
            }
        }
        anim.previousOrder = currentUserOrder;
    }

    const shouldAnimateUserMessage = React.useCallback((message: ChatMessageEntry): boolean => {
        if (resolveMessageRole(message) !== 'user') return false;
        return userAnimationRef.current.animatedIds.has(message.info.id);
    }, []);

    const onUserAnimationConsumed = React.useCallback((messageId: string) => {
        userAnimationRef.current.animatedIds.delete(messageId);
    }, []);

    const messageIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();

        allEntries.forEach((entry, index) => {
            if (entry.kind === 'ungrouped') {
                indexMap.set(entry.message.info.id, index);
                return;
            }
            indexMap.set(entry.turn.userMessage.info.id, index);
            entry.turn.assistantMessages.forEach((message) => {
                indexMap.set(message.info.id, index);
            });
        });

        return indexMap;
    }, [allEntries]);

    const turnIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();
        allEntries.forEach((entry, index) => {
            if (entry.kind === 'turn') {
                indexMap.set(entry.turn.turnId, index);
            }
        });
        return indexMap;
    }, [allEntries]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    }, [resolveScrollContainer]);

    const scrollHistoryIndexIntoView = React.useCallback((index: number, behavior: ScrollBehavior = 'auto') => {
        if (index < 0 || index >= historyEntries.length) {
            return false;
        }

        if (!shouldVirtualizeHistory) {
            return false;
        }

        const virtualizer = tanstackVirtualizerRef.current;
        if (!virtualizer) {
            return false;
        }

        virtualizer.scrollToIndex(index, { align: 'start', behavior: behavior === 'smooth' ? 'smooth' : 'auto' });
        return true;
    }, [historyEntries.length, shouldVirtualizeHistory]);

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

    React.useEffect(() => {
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = turnIndexMap.get(turnId);
                if (index === undefined) {
                    return false;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const turnElement = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    return true;
                }

                const targetIsTail = trailingStreamingEntry !== undefined && index >= historyEntries.length;
                if (targetIsTail) {
                    return false;
                }

                return scrollHistoryIndexIntoView(index, behavior);
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                return scrollMessageElementIntoView(messageId, behavior)
                    || (
                        trailingStreamingEntry !== undefined && index >= historyEntries.length
                            ? false
                            : scrollHistoryIndexIntoView(index, behavior)
                    );
            },

            holdViewportAnchor: (anchor) => {
                const container = resolveScrollContainer();
                if (!container || typeof window === 'undefined') {
                    return;
                }

                let frames = 0;
                let stable = 0;
                let cancelled = false;
                const cancelOnUserInput = () => {
                    cancelled = true;
                    container.removeEventListener('touchstart', cancelOnUserInput);
                    container.removeEventListener('wheel', cancelOnUserInput);
                };
                container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
                container.addEventListener('wheel', cancelOnUserInput, { passive: true });
                const step = () => {
                    if (cancelled) return;
                    const element = findMessageElement(anchor.messageId);
                    if (element) {
                        const delta = element.getBoundingClientRect().top
                            - container.getBoundingClientRect().top
                            - anchor.offsetTop;
                        if (Math.abs(delta) > 0.5) {
                            container.scrollTop += delta;
                            stable = 0;
                        } else {
                            stable += 1;
                        }
                    }
                    frames += 1;
                    if (stable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                        container.removeEventListener('touchstart', cancelOnUserInput);
                        container.removeEventListener('wheel', cancelOnUserInput);
                        return;
                    }
                    window.requestAnimationFrame(step);
                };
                window.requestAnimationFrame(step);
            },

            isHistoryVirtualized: () => shouldVirtualizeHistory,

            captureViewportAnchor: () => {
                const container = resolveScrollContainer();
                if (!container) {
                    return null;
                }

                const containerRect = container.getBoundingClientRect();
                const nodes: HTMLElement[] = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
                const firstVisible = nodes.find((node) => {
                    const rect = node.getBoundingClientRect();
                    if (rect.bottom <= containerRect.top + 1) {
                        return false;
                    }

                    if (typeof window === 'undefined') {
                        return true;
                    }

                    return !isInsideStuckSticky(node, container, containerRect.top);
                }) ?? nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top + 1);
                if (!firstVisible) {
                    return null;
                }

                const messageId = firstVisible.dataset.messageId;
                if (!messageId) {
                    return null;
                }

                return {
                    messageId,
                    offsetTop: firstVisible.getBoundingClientRect().top - containerRect.top,
                };
            },

            restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => {
                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }

                if (!messageIndexMap.has(anchor.messageId)) {
                    return false;
                }

                const applyAnchor = (): boolean => {
                    const element = findMessageElement(anchor.messageId);
                    if (!element) {
                        return false;
                    }
                    const containerRect = container.getBoundingClientRect();
                    const targetTop = element.getBoundingClientRect().top - containerRect.top;
                    const delta = targetTop - anchor.offsetTop;
                    if (delta !== 0) {
                        container.scrollTop += delta;
                    }
                    return true;
                };

                if (!applyAnchor()) {
                    const index = messageIndexMap.get(anchor.messageId);
                    if (typeof index === 'number' && index < historyEntries.length) {
                        return scrollHistoryIndexIntoView(index, 'auto');
                    }
                }

                return applyAnchor();
            },

            scrollToBottom: () => {
                if (shouldVirtualizeHistory && historyEntries.length > 0 && tanstackVirtualizerRef.current) {
                    tanstackVirtualizerRef.current.scrollToEnd();
                    return;
                }
                const container = resolveScrollContainer();
                if (!container) return;
                container.scrollTop = container.scrollHeight;
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
            objectRef.current = null;
        };
    }, [findMessageElement, historyEntries.length, messageIndexMap, resolveScrollContainer, scrollHistoryIndexIntoView, scrollMessageElementIntoView, shouldVirtualizeHistory, trailingStreamingEntry, turnIndexMap, ref]);

    const disableFadeIn = false;

    return (
        <div>
                <FadeInDisabledProvider disabled={disableFadeIn}>
                    <div className="relative w-full">
                        {/* Virtualized history rows unmount/remount during scroll;
                            re-running the reveal fade on every remount reads as
                            blinking. History content is never "new", so fade-in
                            is disabled there — the streaming tail keeps it. */}
                        <FadeInDisabledProvider disabled={shouldVirtualizeHistory}>
                            <DeferredToolHydrationProvider enabled={true}>
                                <StaticHistoryList
                                    key={sessionKey}
                                    entries={historyEntries}
                                    engine={historyEngine}
                                    contentRef={historyContentRef}
                                    scrollRef={scrollRef}
                                    registerTanstackVirtualizer={registerTanstackVirtualizer}
                                    virtualizerKey={sessionKey}
                                    onMessageContentChange={stableHistoryContentChange}
                                    getAnimationHandlers={stableGetAnimationHandlers}
                                    scrollToBottom={stableScrollToBottom}
                                    stickyUserHeader={stickyUserHeader}
                                    defaultActivityExpanded={defaultActivityExpanded}
                                    turnUiStates={turnUiStates}
                                    onToggleTurnGroup={toggleTurnGroup}
                                    chatRenderMode={chatRenderMode}
                                    shouldAnimateUserMessage={shouldAnimateUserMessage}
                                    onUserAnimationConsumed={onUserAnimationConsumed}
                                    reviewTransferDirection={reviewTransferDirection}
                                />
                            </DeferredToolHydrationProvider>
                        </FadeInDisabledProvider>
                        {trailingStreamingEntry ? (
                            <StreamingTailContent
                                entry={trailingStreamingEntry}
                                directory={directory}
                                onMessageContentChange={stableTailContentChange}
                                getAnimationHandlers={stableGetAnimationHandlers}
                                scrollToBottom={stableScrollToBottom}
                                stickyUserHeader={stickyUserHeader}
                                sessionIsWorking={sessionIsWorking}
                                defaultActivityExpanded={defaultActivityExpanded}
                                turnUiStates={turnUiStates}
                                onToggleTurnGroup={toggleTurnGroup}
                                chatRenderMode={chatRenderMode}
                                showTurnChangedFiles={showTurnChangedFiles}
                                shouldAnimateUserMessage={shouldAnimateUserMessage}
                                onUserAnimationConsumed={onUserAnimationConsumed}
                                activeStreamingMessageId={activeStreamingMessageId}
                                activeStreamingPhase={activeStreamingPhase}
                                reviewTransferDirection={reviewTransferDirection}
                            />
                        ) : null}
                    </div>
                </FadeInDisabledProvider>

        </div>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
