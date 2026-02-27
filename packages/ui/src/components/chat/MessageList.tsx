import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { flushSync } from 'react-dom';
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import type { ReactVirtualizerOptions, VirtualItem } from '@tanstack/react-virtual';

import ChatMessage from './ChatMessage';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatScrollManager';
import { filterSyntheticParts } from '@/lib/messages/synthetic';
import { detectTurns, type Turn } from './hooks/useTurnGrouping';
import { TurnGroupingProvider, useMessageNeighbors, useTurnGroupingContextForMessage, useTurnGroupingContextStatic } from './contexts/TurnGroupingContext';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDeviceInfo } from '@/lib/device';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';

const MESSAGE_VIRTUALIZE_THRESHOLD = 40;
const MESSAGE_VIRTUAL_OVERSCAN_MOBILE = 2;
const MESSAGE_VIRTUAL_OVERSCAN_DESKTOP = 4;

type MessageListVirtualizerOptions<TItemElement extends Element> = Omit<
    ReactVirtualizerOptions<HTMLElement, TItemElement>,
    'scrollToFn' | 'observeElementRect' | 'observeElementOffset'
>

const useMessageListVirtualizer = <TItemElement extends Element>(
    options: MessageListVirtualizerOptions<TItemElement>,
): Virtualizer<HTMLElement, TItemElement> => {
    const [, forceRender] = React.useReducer(() => ({}), {});
    const { useFlushSync = true, onChange, ...baseOptions } = options;

    const handleChange = React.useCallback((instance: Virtualizer<HTMLElement, TItemElement>, sync: boolean) => {
        if (useFlushSync && sync) {
            flushSync(forceRender);
        } else {
            forceRender();
        }

        onChange?.(instance, sync);
    }, [onChange, useFlushSync]);

    const [virtualizer] = React.useState(() => new Virtualizer<HTMLElement, TItemElement>({
        ...baseOptions,
        onChange: handleChange,
        observeElementRect,
        observeElementOffset,
        scrollToFn: elementScroll,
    }));

    virtualizer.setOptions({
        ...baseOptions,
        onChange: handleChange,
        observeElementRect,
        observeElementOffset,
        scrollToFn: elementScroll,
    });

    React.useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
    React.useLayoutEffect(() => virtualizer._willUpdate(), [virtualizer]);

    return virtualizer;
};

interface ChatMessageEntry {
    info: Message;
    parts: Part[];
}

const USER_SHELL_MARKER = 'The following tool was executed by the user';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
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

    if (part.type !== 'tool') {
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
            metadata?: { sessionId?: unknown; sessionID?: unknown };
            output?: unknown;
        };
    };
    const metadata = partRecord.state?.metadata;
    const fromMetadata =
        (typeof metadata?.sessionId === 'string' && metadata.sessionId.trim().length > 0
            ? metadata.sessionId.trim()
            : null)
        ?? (typeof metadata?.sessionID === 'string' && metadata.sessionID.trim().length > 0
            ? metadata.sessionID.trim()
            : null);
    if (fromMetadata) return fromMetadata;

    const output = partRecord.state?.output;
    if (typeof output === 'string') {
        const match = output.match(/task_id:\s*([a-zA-Z0-9_]+)/);
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
    };

    if (onlyPart.type !== 'tool') {
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
    messages: ChatMessageEntry[];
    permissions: PermissionRequest[];
    questions: QuestionRequest[];
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    hasMoreAbove: boolean;
    isLoadingOlder: boolean;
    onLoadOlder: () => void;
    hasRenderEarlier?: boolean;
    onRenderEarlier?: () => void;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export interface MessageListHandle {
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
}

type RenderEntry =
    | { kind: 'ungrouped'; key: string; message: ChatMessageEntry; isInLastTurn: boolean }
    | { kind: 'turn'; key: string; turn: Turn; isLastTurn: boolean };

interface MessageRowProps {
    message: ChatMessageEntry;
    onContentChange: (reason?: ContentChangeReason) => void;
    animationHandlers: AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

// Static MessageRow - does NOT subscribe to dynamic context
// Used for messages NOT in the last turn - no re-renders during streaming
const StaticMessageRow = React.memo<MessageRowProps>(({
    message,
    onContentChange,
    animationHandlers,
    scrollToBottom,
}) => {
    const { previousMessage, nextMessage } = useMessageNeighbors(message.info.id);
    const turnGroupingContext = useTurnGroupingContextStatic(message.info.id);
    
    return (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            onContentChange={onContentChange}
            animationHandlers={animationHandlers}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
        />
    );
});

StaticMessageRow.displayName = 'StaticMessageRow';

// Dynamic MessageRow - subscribes to dynamic context for streaming state
// Used for messages in the LAST turn only
const DynamicMessageRow = React.memo<MessageRowProps>(({
    message,
    onContentChange,
    animationHandlers,
    scrollToBottom,
}) => {
    const { previousMessage, nextMessage } = useMessageNeighbors(message.info.id);
    const turnGroupingContext = useTurnGroupingContextForMessage(message.info.id);
    
    return (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            onContentChange={onContentChange}
            animationHandlers={animationHandlers}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
        />
    );
});

DynamicMessageRow.displayName = 'DynamicMessageRow';

interface TurnBlockProps {
    turn: Turn;
    isLastTurn: boolean;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader?: boolean;
}

const TurnBlock: React.FC<TurnBlockProps> = ({
    turn,
    isLastTurn,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
}) => {
    const renderMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const role = (message.info as { clientRole?: string | null | undefined }).clientRole ?? message.info.role;
            const isInLastTurn = role !== 'user' && isLastTurn;
            const RowComponent = isInLastTurn ? DynamicMessageRow : StaticMessageRow;

            return (
                <RowComponent
                    key={message.info.id}
                    message={message}
                    onContentChange={onMessageContentChange}
                    animationHandlers={getAnimationHandlers(message.info.id)}
                    scrollToBottom={scrollToBottom}
                />
            );
        },
        [getAnimationHandlers, isLastTurn, onMessageContentChange, scrollToBottom]
    );

    return (
        <section className="relative w-full" data-turn-id={turn.turnId}>
            {stickyUserHeader ? (
                <div className="sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
                    <div className="relative z-10">
                        {renderMessage(turn.userMessage)}
                    </div>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-full z-0 h-8 bg-gradient-to-b from-[var(--surface-background)] to-transparent"
                    />
                </div>
            ) : (
                renderMessage(turn.userMessage)
            )}

            <div className="relative z-0">
                {turn.assistantMessages.map((message) => renderMessage(message))}
            </div>
        </section>
    );
};

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    isInLastTurn: boolean;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

const UngroupedMessageRow: React.FC<UngroupedMessageRowProps> = React.memo(({
    message,
    isInLastTurn,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
}) => {
    const RowComponent = isInLastTurn ? DynamicMessageRow : StaticMessageRow;

    return (
        <RowComponent
            message={message}
            onContentChange={onMessageContentChange}
            animationHandlers={getAnimationHandlers(message.info.id)}
            scrollToBottom={scrollToBottom}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';

interface MessageListEntryProps {
    entry: RenderEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader?: boolean;
}

const MessageListEntry: React.FC<MessageListEntryProps> = React.memo(({
    entry,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
}) => {
    if (entry.kind === 'ungrouped') {
        return (
            <UngroupedMessageRow
                message={entry.message}
                isInLastTurn={entry.isInLastTurn}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
            />
        );
    }

    return (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
        />
    );
}, areMessageListEntryPropsEqual);

MessageListEntry.displayName = 'MessageListEntry';

function areMessageListEntryPropsEqual(prevProps: MessageListEntryProps, nextProps: MessageListEntryProps): boolean {
    if (prevProps.stickyUserHeader !== nextProps.stickyUserHeader) return false;
    if (prevProps.onMessageContentChange !== nextProps.onMessageContentChange) return false;
    if (prevProps.getAnimationHandlers !== nextProps.getAnimationHandlers) return false;
    if (prevProps.scrollToBottom !== nextProps.scrollToBottom) return false;

    const prevEntry = prevProps.entry;
    const nextEntry = nextProps.entry;
    if (prevEntry.kind !== nextEntry.kind) return false;
    if (prevEntry.key !== nextEntry.key) return false;

    if (prevEntry.kind === 'turn' && nextEntry.kind === 'turn') {
        return prevEntry.turn === nextEntry.turn && prevEntry.isLastTurn === nextEntry.isLastTurn;
    }

    if (prevEntry.kind === 'ungrouped' && nextEntry.kind === 'ungrouped') {
        return prevEntry.message === nextEntry.message && prevEntry.isInLastTurn === nextEntry.isInLastTurn;
    }

    return false;
}

// Inner component that renders messages with access to context hooks
const MessageListContent: React.FC<{
    entries: RenderEntry[];
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}> = ({ entries, onMessageContentChange, getAnimationHandlers, scrollToBottom }) => {
    return (
        <>
            {entries.map((entry) => (
                <MessageListEntry
                    key={entry.key}
                    entry={entry}
                    onMessageContentChange={onMessageContentChange}
                    getAnimationHandlers={getAnimationHandlers}
                    scrollToBottom={scrollToBottom}
                    stickyUserHeader
                />
            ))}
        </>
    );
};

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({ 
    messages,
    permissions,
    questions,
    onMessageContentChange,
    getAnimationHandlers,
    hasMoreAbove,
    isLoadingOlder,
    onLoadOlder,
    hasRenderEarlier,
    onRenderEarlier,
    scrollToBottom,
    scrollRef,
}, ref) => {
    const { isMobile } = useDeviceInfo();

    React.useEffect(() => {
        if (permissions.length === 0 && questions.length === 0) {
            return;
        }
        onMessageContentChange('permission');
    }, [permissions, questions, onMessageContentChange]);

    const baseDisplayMessages = React.useMemo(() => {
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
            dedupedMessages.push(message);
        }
        dedupedMessages.reverse();

        const normalizedMessages = dedupedMessages
            .map((message) => {
                const filteredParts = filterSyntheticParts(message.parts);
                const normalized = filteredParts === message.parts
                    ? message
                    : {
                        ...message,
                        parts: filteredParts,
                    };
                return normalized;
            });

        const output: ChatMessageEntry[] = [];

        for (let index = 0; index < normalizedMessages.length; index += 1) {
            const current = normalizedMessages[index];
            const previous = output.length > 0 ? output[output.length - 1] : undefined;

            if (isUserSubtaskMessage(previous)) {
                const bridge = isSyntheticSubtaskBridgeAssistant(current);
                if (bridge.hide) {
                    output[output.length - 1] = withSubtaskSessionId(previous as ChatMessageEntry, bridge.taskSessionId);
                    continue;
                }
            }

            if (isUserShellMarkerMessage(previous)) {
                const bridge = getShellBridgeAssistantDetails(current, getMessageId(previous));
                if (bridge.hide) {
                    output[output.length - 1] = withShellBridgeDetails(previous as ChatMessageEntry, bridge.details);
                    continue;
                }
            }

            output.push(current);
        }

        return output;
    }, [messages]);

    const activeRetryStatus = useSessionStore(
        useShallow((state) => {
            const sessionId = state.currentSessionId;
            if (!sessionId) return null;
            const status = state.sessionStatus?.get(sessionId);
            if (!status || status.type !== 'retry') return null;
            const rawMessage = typeof status.message === 'string' ? status.message.trim() : '';
            return {
                sessionId,
                message: rawMessage || 'Quota limit reached. Retrying automatically.',
                confirmedAt: status.confirmedAt,
            };
        })
    );

    const activeRetrySessionId = activeRetryStatus?.sessionId ?? null;
    const activeRetryMessage = activeRetryStatus?.message
        ?? 'Quota limit reached. Retrying automatically.';
    const activeRetryConfirmedAt = activeRetryStatus?.confirmedAt;

    const [fallbackRetryTimestamp, setFallbackRetryTimestamp] = React.useState<number>(0);
    const fallbackRetrySessionRef = React.useRef<string | null>(null);
    const [scrollContainer, setScrollContainer] = React.useState<HTMLDivElement | null>(null);

    React.useLayoutEffect(() => {
        setScrollContainer(scrollRef?.current ?? null);
    }, [scrollRef]);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
            fallbackRetrySessionRef.current = null;
            setFallbackRetryTimestamp(0);
            return;
        }

        if (fallbackRetrySessionRef.current !== activeRetryStatus.sessionId) {
            fallbackRetrySessionRef.current = activeRetryStatus.sessionId;
            setFallbackRetryTimestamp(Date.now());
        }
    }, [activeRetryStatus, activeRetryStatus?.sessionId, activeRetryStatus?.confirmedAt]);

    const displayMessages = React.useMemo(() => {
        if (!activeRetrySessionId) {
            return baseDisplayMessages;
        }

        const retryError = {
            name: 'SessionRetry',
            message: activeRetryMessage,
            data: { message: activeRetryMessage },
        };

        let lastUserIndex = -1;
        for (let index = baseDisplayMessages.length - 1; index >= 0; index -= 1) {
            if (resolveMessageRole(baseDisplayMessages[index]) === 'user') {
                lastUserIndex = index;
                break;
            }
        }

        if (lastUserIndex < 0) {
            return baseDisplayMessages;
        }

        // Prefer attaching retry error to the assistant message in the current turn (if one exists)
        // to avoid rendering a separate header-only placeholder + error block.
        let targetAssistantIndex = -1;
        for (let index = baseDisplayMessages.length - 1; index > lastUserIndex; index -= 1) {
            if (resolveMessageRole(baseDisplayMessages[index]) === 'assistant') {
                targetAssistantIndex = index;
                break;
            }
        }

        if (targetAssistantIndex >= 0) {
            const existing = baseDisplayMessages[targetAssistantIndex];
            const existingInfo = existing.info as unknown as { error?: unknown };
            if (existingInfo.error) {
                return baseDisplayMessages;
            }

            return baseDisplayMessages.map((message, index) => {
                if (index !== targetAssistantIndex) {
                    return message;
                }
                return {
                    ...message,
                    info: {
                        ...(message.info as unknown as Record<string, unknown>),
                        error: retryError,
                    } as unknown as Message,
                };
            });
        }

        const eventTime = typeof activeRetryConfirmedAt === 'number' ? activeRetryConfirmedAt : fallbackRetryTimestamp;
        const syntheticId = `synthetic_retry_notice_${activeRetrySessionId}`;
        const synthetic: ChatMessageEntry = {
            info: {
                id: syntheticId,
                sessionID: activeRetrySessionId,
                role: 'assistant',
                time: { created: eventTime, completed: eventTime },
                finish: 'stop',
                error: retryError,
            } as unknown as Message,
            parts: [],
        };

        const next = baseDisplayMessages.slice();
        next.splice(lastUserIndex + 1, 0, synthetic);
        return next;
    }, [activeRetryMessage, activeRetryConfirmedAt, activeRetrySessionId, baseDisplayMessages, fallbackRetryTimestamp]);

    const turns = React.useMemo(() => detectTurns(displayMessages), [displayMessages]);

    const renderEntries = React.useMemo<RenderEntry[]>(() => {
        const entries: RenderEntry[] = [];
        const turnByUserId = new Map<string, Turn>();
        const groupedAssistantIds = new Set<string>();
        const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
        const lastTurnId = lastTurn?.turnId ?? null;
        const lastTurnMessageIds = new Set<string>();
        if (lastTurn) {
            lastTurnMessageIds.add(lastTurn.userMessage.info.id);
            lastTurn.assistantMessages.forEach((assistantMessage: ChatMessageEntry) => {
                lastTurnMessageIds.add(assistantMessage.info.id);
            });
        }

        turns.forEach((turn: Turn) => {
            turnByUserId.set(turn.userMessage.info.id, turn);
            turn.assistantMessages.forEach((assistantMessage: ChatMessageEntry) => {
                groupedAssistantIds.add(assistantMessage.info.id);
            });
        });

        displayMessages.forEach((message: ChatMessageEntry) => {
            const turn = turnByUserId.get(message.info.id);
            if (turn) {
                entries.push({
                    kind: 'turn',
                    key: `turn:${turn.turnId}`,
                    turn,
                    isLastTurn: turn.turnId === lastTurnId,
                });
                return;
            }

            if (groupedAssistantIds.has(message.info.id)) {
                return;
            }

            entries.push({
                kind: 'ungrouped',
                key: `msg:${message.info.id}`,
                message,
                isInLastTurn: lastTurnMessageIds.has(message.info.id),
            });
        });

        return entries;
    }, [displayMessages, turns]);

    const shouldVirtualize = Boolean(scrollContainer) && renderEntries.length >= MESSAGE_VIRTUALIZE_THRESHOLD;

    const estimateEntrySize = React.useCallback(
        (index: number): number => {
            const entry = renderEntries[index];
            if (!entry) {
                return 300;
            }
            if (entry.kind === 'turn') {
                const assistantCount = entry.turn.assistantMessages.length;
                return Math.min(3600, 140 + assistantCount * 260);
            }
            const role = resolveMessageRole(entry.message);
            return role === 'user' ? 120 : 280;
        },
        [renderEntries]
    );

    const virtualizer = useMessageListVirtualizer<Element>({
        count: renderEntries.length,
        getScrollElement: () => scrollContainer,
        estimateSize: estimateEntrySize,
        overscan: isMobile ? MESSAGE_VIRTUAL_OVERSCAN_MOBILE : MESSAGE_VIRTUAL_OVERSCAN_DESKTOP,
        getItemKey: (index: number) => renderEntries[index]?.key ?? index,
        enabled: shouldVirtualize,
        useFlushSync: false,
    });

    const virtualRows = shouldVirtualize ? virtualizer.getVirtualItems() : [];

    const scrollVirtualizerToIndex = React.useCallback((index: number, behavior: ScrollBehavior = 'auto') => {
        if (!virtualizer) {
            return;
        }
        const normalizedBehavior: 'auto' | 'smooth' = behavior === 'instant' ? 'auto' : behavior;
        virtualizer.scrollToIndex(index, { align: 'start', behavior: normalizedBehavior });
    }, [virtualizer]);

    const messageIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();

        renderEntries.forEach((entry, index) => {
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
    }, [renderEntries]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = scrollContainer;
        if (!container) {
            return null;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    }, [scrollContainer]);

    const scrollMessageElementIntoView = React.useCallback((messageId: string, behavior: ScrollBehavior = 'auto') => {
        const container = scrollContainer;
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
    }, [findMessageElement, scrollContainer]);

    React.useLayoutEffect(() => {
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                if (shouldVirtualize) {
                    scrollVirtualizerToIndex(index, behavior === 'instant' ? 'auto' : behavior);
                    if (typeof window !== 'undefined') {
                        window.requestAnimationFrame(() => {
                            window.requestAnimationFrame(() => {
                                scrollMessageElementIntoView(messageId, behavior);
                            });
                        });
                    }
                    return true;
                }

                return scrollMessageElementIntoView(messageId, behavior);
            },

            captureViewportAnchor: () => {
                const container = scrollContainer;
                if (!container) {
                    return null;
                }

                const containerRect = container.getBoundingClientRect();
                const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
                const firstVisible = nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top + 1);
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
                const container = scrollContainer;
                if (!container) {
                    return false;
                }

                const index = messageIndexMap.get(anchor.messageId);
                if (index === undefined) {
                    return false;
                }

                if (shouldVirtualize) {
                    scrollVirtualizerToIndex(index, 'auto');
                }

                if (typeof window !== 'undefined') {
                    window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                            const element = findMessageElement(anchor.messageId);
                            if (!element) {
                                return;
                            }
                            const containerRect = container.getBoundingClientRect();
                            const targetTop = element.getBoundingClientRect().top - containerRect.top;
                            const delta = targetTop - anchor.offsetTop;
                            if (delta !== 0) {
                                container.scrollTop += delta;
                            }
                        });
                    });
                }

                return true;
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
    }, [findMessageElement, messageIndexMap, scrollMessageElementIntoView, scrollContainer, scrollVirtualizerToIndex, shouldVirtualize, ref]);

    const disableFadeIn = shouldVirtualize && virtualizer.isScrolling;

    return (
        <TurnGroupingProvider messages={displayMessages}>
            <div>
                {hasRenderEarlier && (
                    <div className="flex justify-center py-3">
                        <button
                            type="button"
                            onClick={onRenderEarlier}
                            className="text-xs uppercase tracking-wide text-muted-foreground/80 hover:text-foreground"
                        >
                            Render earlier messages
                        </button>
                    </div>
                )}

                {hasMoreAbove && (
                    <div className="flex justify-center py-3">
                        {isLoadingOlder ? (
                            <span className="text-xs uppercase tracking-wide text-muted-foreground/80">
                                Loading…
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={onLoadOlder}
                                className="text-xs uppercase tracking-wide text-muted-foreground/80 hover:text-foreground"
                            >
                                Load older messages
                            </button>
                        )}
                    </div>
                )}

                <FadeInDisabledProvider disabled={disableFadeIn}>
                    {shouldVirtualize ? (
                        <div
                            className="relative w-full"
                            style={{ height: `${virtualizer.getTotalSize()}px` }}
                        >
                            {virtualRows.map((virtualRow: VirtualItem) => {
                                const entry = renderEntries[virtualRow.index];
                                if (!entry) {
                                    return null;
                                }

                                return (
                                    <div
                                        key={entry.key}
                                        data-index={virtualRow.index}
                                        ref={virtualizer.measureElement}
                                        className="absolute left-0 top-0 w-full [overflow-anchor:none]"
                                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                                    >
                                        <MessageListEntry
                                            entry={entry}
                                            onMessageContentChange={onMessageContentChange}
                                            getAnimationHandlers={getAnimationHandlers}
                                            scrollToBottom={scrollToBottom}
                                            stickyUserHeader={false}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <MessageListContent
                            entries={renderEntries}
                            onMessageContentChange={onMessageContentChange}
                            getAnimationHandlers={getAnimationHandlers}
                            scrollToBottom={scrollToBottom}
                        />
                    )}
                </FadeInDisabledProvider>

                {(questions.length > 0 || permissions.length > 0) && (
                    <div>
                        {questions.map((question) => (
                            <QuestionCard key={question.id} question={question} />
                        ))}
                        {permissions.map((permission) => (
                            <PermissionCard key={permission.id} permission={permission} />
                        ))}
                    </div>
                )}

                {/* Bottom spacer */}
                <div className="flex-shrink-0" style={{ height: isMobile ? '8px' : '10vh' }} aria-hidden="true" />
            </div>
        </TurnGroupingProvider>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
