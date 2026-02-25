import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useShallow } from 'zustand/react/shallow';

import ChatMessage from './ChatMessage';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatScrollManager';
import { filterSyntheticParts } from '@/lib/messages/synthetic';
import { detectTurns, type Turn } from './hooks/useTurnGrouping';
import { TurnGroupingProvider, useMessageNeighbors, useTurnGroupingContextForMessage, useTurnGroupingContextStatic, useLastTurnMessageIds } from './contexts/TurnGroupingContext';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDeviceInfo } from '@/lib/device';

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

const hasSameTurnStructure = (prev: ChatMessageEntry[], next: ChatMessageEntry[]): boolean => {
    if (prev === next) {
        return true;
    }
    if (prev.length !== next.length) {
        return false;
    }

    for (let index = 0; index < prev.length; index += 1) {
        const prevMessage = prev[index];
        const nextMessage = next[index];

        if (prevMessage !== nextMessage) {
            return false;
        }

        if (prevMessage.info.id !== nextMessage.info.id) {
            return false;
        }

        if (resolveMessageRole(prevMessage) !== resolveMessageRole(nextMessage)) {
            return false;
        }

        if (getMessageParentId(prevMessage) !== getMessageParentId(nextMessage)) {
            return false;
        }
    }

    return true;
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
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

const TurnBlock: React.FC<TurnBlockProps> = ({
    turn,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
}) => {
    const lastTurnMessageIds = useLastTurnMessageIds();

    const renderMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const role = (message.info as { clientRole?: string | null | undefined }).clientRole ?? message.info.role;
            const isInLastTurn = role !== 'user' && lastTurnMessageIds.has(message.info.id);
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
        [getAnimationHandlers, lastTurnMessageIds, onMessageContentChange, scrollToBottom]
    );

    return (
        <section className="relative w-full" data-turn-id={turn.turnId}>
            <div className="sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
                <div className="relative z-10">
                    {renderMessage(turn.userMessage)}
                </div>
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-full z-0 h-8 bg-gradient-to-b from-[var(--surface-background)] to-transparent"
                />
            </div>

            <div className="relative z-0">
                {turn.assistantMessages.map((message) => renderMessage(message))}
            </div>
        </section>
    );
};

TurnBlock.displayName = 'TurnBlock';

// Inner component that renders messages with access to context hooks
const MessageListContent: React.FC<{
    turns: Turn[];
    ungroupedMessages: ChatMessageEntry[];
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}> = ({ turns, ungroupedMessages, onMessageContentChange, getAnimationHandlers, scrollToBottom }) => {
    const lastTurnMessageIds = useLastTurnMessageIds();

    const renderUngroupedMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const role = (message.info as { clientRole?: string | null | undefined }).clientRole ?? message.info.role;
            const isInLastTurn = role !== 'user' && lastTurnMessageIds.has(message.info.id);
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
        [getAnimationHandlers, lastTurnMessageIds, onMessageContentChange, scrollToBottom]
    );
    
    return (
        <>
            {ungroupedMessages.map((message) => renderUngroupedMessage(message))}

            {turns.map((turn) => (
                <TurnBlock
                    key={turn.turnId}
                    turn={turn}
                    onMessageContentChange={onMessageContentChange}
                    getAnimationHandlers={getAnimationHandlers}
                    scrollToBottom={scrollToBottom}
                />
            ))}
        </>
    );
};

const MessageList: React.FC<MessageListProps> = ({
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
}) => {
    const { isMobile } = useDeviceInfo();
    const turnStructureCacheRef = React.useRef<{
        messages: ChatMessageEntry[];
        turns: Turn[];
        ungroupedMessages: ChatMessageEntry[];
    } | null>(null);
    const normalizedMessageCacheRef = React.useRef<Map<string, { source: ChatMessageEntry; normalized: ChatMessageEntry }>>(new Map());

    React.useEffect(() => {
        if (permissions.length === 0 && questions.length === 0) {
            return;
        }
        onMessageContentChange('permission');
    }, [permissions, questions, onMessageContentChange]);

    const baseDisplayMessages = React.useMemo(() => {
        const seenIdsFromTail = new Set<string>();
        const nextNormalizedCache = new Map<string, { source: ChatMessageEntry; normalized: ChatMessageEntry }>();

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
            .map((message, index) => {
                const messageId = typeof message.info?.id === 'string' && message.info.id.length > 0
                    ? message.info.id
                    : `__idx_${index}`;
                const cacheKey = `${messageId}:${resolveMessageRole(message) ?? 'unknown'}`;
                const cached = normalizedMessageCacheRef.current.get(cacheKey);
                if (cached && cached.source === message) {
                    nextNormalizedCache.set(cacheKey, cached);
                    return cached.normalized;
                }

                const filteredParts = filterSyntheticParts(message.parts);
                const normalized = filteredParts === message.parts
                    ? message
                    : {
                        ...message,
                        parts: filteredParts,
                    };
                nextNormalizedCache.set(cacheKey, { source: message, normalized });
                return normalized;
            });

        normalizedMessageCacheRef.current = nextNormalizedCache;

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

    const displayMessages = React.useMemo(() => {
        if (!activeRetryStatus) {
            return baseDisplayMessages;
        }

        const retryError = {
            name: 'SessionRetry',
            message: activeRetryStatus.message,
            data: { message: activeRetryStatus.message },
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

        const eventTime = typeof activeRetryStatus.confirmedAt === 'number' ? activeRetryStatus.confirmedAt : Date.now();
        const syntheticId = `synthetic_retry_notice_${activeRetryStatus.sessionId}`;
        const synthetic: ChatMessageEntry = {
            info: {
                id: syntheticId,
                sessionID: activeRetryStatus.sessionId,
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
    }, [activeRetryStatus, baseDisplayMessages]);

    const { turns, ungroupedMessages } = React.useMemo(() => {
        const cached = turnStructureCacheRef.current;
        if (cached && hasSameTurnStructure(cached.messages, displayMessages)) {
            return {
                turns: cached.turns,
                ungroupedMessages: cached.ungroupedMessages,
            };
        }

        const groupedTurns = detectTurns(displayMessages);
        const groupedMessageIds = new Set<string>();

        groupedTurns.forEach((turn) => {
            groupedMessageIds.add(turn.userMessage.info.id);
            turn.assistantMessages.forEach((message) => {
                groupedMessageIds.add(message.info.id);
            });
        });

        const ungrouped = displayMessages.filter((message) => !groupedMessageIds.has(message.info.id));
        const nextValue = {
            turns: groupedTurns,
            ungroupedMessages: ungrouped,
        };

        turnStructureCacheRef.current = {
            messages: displayMessages,
            turns: groupedTurns,
            ungroupedMessages: ungrouped,
        };

        return nextValue;
    }, [displayMessages]);

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

                <MessageListContent
                    turns={turns}
                    ungroupedMessages={ungroupedMessages}
                    onMessageContentChange={onMessageContentChange}
                    getAnimationHandlers={getAnimationHandlers}
                    scrollToBottom={scrollToBottom}
                />

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
};

export default React.memo(MessageList);
