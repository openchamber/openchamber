import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { flushSync } from 'react-dom';
import { elementScroll, observeElementOffset, observeElementRect, Virtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import type { ReactVirtualizerOptions, VirtualItem } from '@tanstack/react-virtual';

import ChatMessage from './ChatMessage';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import TurnItem from './components/TurnItem';
import TurnList from './components/TurnList';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatScrollManager';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { filterSyntheticParts } from '@/lib/messages/synthetic';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { useStageTurns } from './lib/turns/stageTurns';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { hasPendingUserSendAnimation, consumePendingUserSendAnimation } from '@/lib/userSendAnimation';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { StatusRow } from './StatusRow';

const MESSAGE_VIRTUALIZE_THRESHOLD = 40;
const MESSAGE_VIRTUAL_OVERSCAN_MOBILE = 2;
const MESSAGE_VIRTUAL_OVERSCAN_DESKTOP = 4;

const useStableEvent = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult) => {
    const handlerRef = React.useRef(handler);
    React.useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    return React.useCallback((...args: TArgs) => handlerRef.current(...args), []);
};

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
    sessionKey: string;
    turnStart: number;
    disableStaging?: boolean;
    messages: ChatMessageEntry[];
    permissions: PermissionRequest[];
    questions: QuestionRequest[];
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    hasMoreAbove: boolean;
    isLoadingOlder: boolean;
    onLoadOlder: () => void;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export interface MessageListHandle {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
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



interface MessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    turnGroupingContext?: TurnGroupingContext;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
    onContentChange: (reason?: ContentChangeReason) => void;
    animationHandlers: AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

const MessageRow = React.memo<MessageRowProps>(({
    message,
    previousMessage,
    nextMessage,
    turnGroupingContext,
    animateUserOnMount,
    onUserAnimationConsumed,
    onContentChange,
    animationHandlers,
    scrollToBottom,
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
        />
    );
});

MessageRow.displayName = 'MessageRow';

interface TurnBlockProps {
    turn: TurnRecord;
    isLastTurn: boolean;
    sessionIsWorking: boolean;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader?: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
}

const TurnBlock: React.FC<TurnBlockProps> = ({
    turn,
    isLastTurn,
    sessionIsWorking,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
}) => {

    const messageOrder = React.useMemo(() => {
        const ordered = [turn.userMessage, ...turn.assistantMessages];
        const lookup = new Map<string, number>();
        ordered.forEach((message, index) => {
            lookup.set(message.info.id, index);
        });
        return { ordered, lookup };
    }, [turn.assistantMessages, turn.userMessage]);

    const assistantIndexById = React.useMemo(() => {
        const lookup = new Map<string, number>();
        turn.assistantMessages.forEach((assistant, index) => {
            lookup.set(assistant.info.id, index);
        });
        return lookup;
    }, [turn.assistantMessages]);

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
        const rawVariant = (turn.userMessage.info as { variant?: unknown } | undefined)?.variant;
        const userMessageVariant = typeof rawVariant === 'string' && rawVariant.trim().length > 0
            ? rawVariant
            : undefined;
        return {
            turnId: turn.turnId,
            headerMessageId: turn.headerMessageId,
            hasTools: turn.hasTools,
            hasReasoning: turn.hasReasoning,
            diffStats: turn.diffStats,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            userMessageVariant,
        };
    }, [turn.diffStats, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.turnId, turn.userMessage.info]);

    const renderMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const messageIndex = messageOrder.lookup.get(message.info.id);
            const previousMessage = typeof messageIndex === 'number' && messageIndex > 0
                ? messageOrder.ordered[messageIndex - 1]
                : undefined;
            const nextMessage = typeof messageIndex === 'number' && messageIndex < messageOrder.ordered.length - 1
                ? messageOrder.ordered[messageIndex + 1]
                : undefined;

            const assistantIndex = assistantIndexById.get(message.info.id) ?? -1;

            const turnGroupingContext = assistantIndex >= 0
                ? {
                    ...turnGroupingContextBase,
                    isFirstAssistantInTurn: assistantIndex === 0,
                    isLastAssistantInTurn: assistantIndex === turn.assistantMessages.length - 1,
                    isWorking: isLastTurn && sessionIsWorking,
                } satisfies TurnGroupingContext
                : undefined;

            return (
                <MessageRow
                    key={message.info.id}
                    message={message}
                    previousMessage={previousMessage}
                    nextMessage={nextMessage}
                    turnGroupingContext={turnGroupingContext}
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
            assistantIndexById,
            turn.assistantMessages,
            turnGroupingContextBase,
            shouldAnimateUserMessage,
            onUserAnimationConsumed,
        ]
    );

    return (
        <TurnItem turn={turn} stickyUserHeader={stickyUserHeader} renderMessage={renderMessage} />
    );
};

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
}

const UngroupedMessageRow: React.FC<UngroupedMessageRowProps> = React.memo(({
    message,
    previousMessage,
    nextMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
}) => {
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
    sessionIsWorking: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
}

const MessageListEntry: React.FC<MessageListEntryProps> = React.memo(({
    entry,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
}) => {
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
            />
        );
    }

    return (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            sessionIsWorking={sessionIsWorking}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
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
    if (prevProps.shouldAnimateUserMessage !== nextProps.shouldAnimateUserMessage) return false;

    const prevEntry = prevProps.entry;
    const nextEntry = nextProps.entry;
    if (prevEntry.kind !== nextEntry.kind) return false;
    if (prevEntry.key !== nextEntry.key) return false;

    if (prevEntry.kind === 'turn' && nextEntry.kind === 'turn') {
        if (prevEntry.turn !== nextEntry.turn || prevEntry.isLastTurn !== nextEntry.isLastTurn) {
            return false;
        }

        if (prevEntry.isLastTurn && prevProps.sessionIsWorking !== nextProps.sessionIsWorking) {
            return false;
        }

        return true;
    }

    if (prevEntry.kind === 'ungrouped' && nextEntry.kind === 'ungrouped') {
        return (
            prevEntry.message === nextEntry.message
            && prevEntry.previousMessage === nextEntry.previousMessage
            && prevEntry.nextMessage === nextEntry.nextMessage
        );
    }

    return false;
}

// Inner component that renders staged turn entries.
const MessageListContent: React.FC<{
    entries: RenderEntry[];
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
}> = ({ entries, onMessageContentChange, getAnimationHandlers, scrollToBottom, stickyUserHeader, sessionIsWorking, shouldAnimateUserMessage, onUserAnimationConsumed }) => {
    const renderEntry = React.useCallback((entry: RenderEntry) => {
        return (
            <MessageListEntry
                key={entry.key}
                entry={entry}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                stickyUserHeader={stickyUserHeader}
                sessionIsWorking={sessionIsWorking}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
            />
        );
    }, [getAnimationHandlers, onMessageContentChange, onUserAnimationConsumed, scrollToBottom, sessionIsWorking, shouldAnimateUserMessage, stickyUserHeader]);

    return (
        <TurnList entries={entries} renderEntry={renderEntry} />
    );
};

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({ 
    sessionKey,
    turnStart,
    disableStaging,
    messages,
    permissions,
    questions,
    onMessageContentChange,
    getAnimationHandlers,
    hasMoreAbove,
    isLoadingOlder,
    onLoadOlder,
    scrollToBottom,
    scrollRef,
}, ref) => {
    const { isMobile } = useDeviceInfo();
    const { isWorking: sessionIsWorking } = useCurrentSessionActivity();
    const { working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });

    const stableOnMessageContentChange = useStableEvent(onMessageContentChange);
    const stableGetAnimationHandlers = useStableEvent(getAnimationHandlers);
    const stableOnLoadOlder = useStableEvent(onLoadOlder);
    const stableScrollToBottom = useStableEvent((options?: { instant?: boolean; force?: boolean }) => {
        scrollToBottom?.(options);
    });

    React.useEffect(() => {
        if (permissions.length === 0 && questions.length === 0) {
            return;
        }
        stableOnMessageContentChange('permission');
    }, [permissions, questions, stableOnMessageContentChange]);


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
    const resolveScrollContainer = React.useCallback((): HTMLDivElement | null => {
        if (scrollRef?.current) {
            return scrollRef.current;
        }
        if (typeof document === 'undefined') {
            return null;
        }
        return document.querySelector<HTMLDivElement>('[data-scrollbar="chat"]');
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
        return applyRetryOverlay(baseDisplayMessages, {
            sessionId: activeRetrySessionId,
            message: activeRetryMessage,
            confirmedAt: activeRetryConfirmedAt,
            fallbackTimestamp: fallbackRetryTimestamp,
        });
    }, [activeRetryMessage, activeRetryConfirmedAt, activeRetrySessionId, baseDisplayMessages, fallbackRetryTimestamp]);

    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages);
    const turns = React.useMemo(() => {
        if (!streamingTurn) {
            return staticTurns;
        }
        return [...staticTurns, streamingTurn];
    }, [staticTurns, streamingTurn]);

    const renderEntries = React.useMemo<RenderEntry[]>(() => {
        const turnEntries = turns.map((turn) => ({
            kind: 'turn' as const,
            key: `turn:${turn.turnId}`,
            turn,
            isLastTurn: turn.turnId === projection.lastTurnId,
        }));

        if (projection.ungroupedMessageIds.size === 0) {
            return turnEntries;
        }

        const turnEntryByUserMessageId = new Map<string, RenderEntry>();
        turnEntries.forEach((entry) => {
            turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry);
        });

        const orderedEntries: RenderEntry[] = [];
        displayMessages.forEach((message, index) => {
            const turnEntry = turnEntryByUserMessageId.get(message.info.id);
            if (turnEntry) {
                orderedEntries.push(turnEntry);
                return;
            }

            if (!projection.ungroupedMessageIds.has(message.info.id)) {
                return;
            }

            orderedEntries.push({
                kind: 'ungrouped',
                key: `msg:${message.info.id}`,
                message,
                previousMessage: index > 0 ? displayMessages[index - 1] : undefined,
                nextMessage: index < displayMessages.length - 1 ? displayMessages[index + 1] : undefined,
            });
        });

        return orderedEntries;
    }, [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, turns]);

    const staging = useStageTurns({
        sessionKey,
        turnStart,
        totalTurns: renderEntries.length,
        disabled: disableStaging,
    });

    const stagedEntries = React.useMemo(() => {
        if (staging.stageStartIndex <= 0) {
            return renderEntries;
        }
        return renderEntries.slice(staging.stageStartIndex);
    }, [renderEntries, staging.stageStartIndex]);

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

    const onUserAnimationConsumed = React.useCallback(() => {
        // Animation plays once via ToolRevealOnMount; no cleanup needed.
        // The ref-based animatedIds set is reset on session switch.
    }, []);

    const shouldVirtualize = Boolean(resolveScrollContainer()) && stagedEntries.length >= MESSAGE_VIRTUALIZE_THRESHOLD;

    const estimateEntrySize = React.useCallback(
        (index: number): number => {
            const entry = stagedEntries[index];
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
        [stagedEntries]
    );

    const virtualizer = useMessageListVirtualizer<Element>({
        count: stagedEntries.length,
        getScrollElement: resolveScrollContainer,
        estimateSize: estimateEntrySize,
        overscan: isMobile ? MESSAGE_VIRTUAL_OVERSCAN_MOBILE : MESSAGE_VIRTUAL_OVERSCAN_DESKTOP,
        getItemKey: (index: number) => stagedEntries[index]?.key ?? index,
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

        stagedEntries.forEach((entry, index) => {
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
    }, [stagedEntries]);

    const turnIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();
        stagedEntries.forEach((entry, index) => {
            if (entry.kind === 'turn') {
                indexMap.set(entry.turn.turnId, index);
            }
        });
        return indexMap;
    }, [stagedEntries]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    }, [resolveScrollContainer]);

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

    React.useLayoutEffect(() => {
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

                if (shouldVirtualize) {
                    scrollVirtualizerToIndex(index, behavior === 'instant' ? 'auto' : behavior);
                    if (typeof window !== 'undefined') {
                        window.requestAnimationFrame(() => {
                            const container = resolveScrollContainer();
                            if (!container) {
                                return;
                            }
                            const turnElement = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                            if (turnElement) {
                                turnElement.scrollIntoView({ behavior, block: 'start' });
                            }
                        });
                    }
                    return true;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const turnElement = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                if (!turnElement) {
                    return false;
                }
                turnElement.scrollIntoView({ behavior, block: 'start' });
                return true;
            },

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
                const container = resolveScrollContainer();
                if (!container) {
                    return null;
                }

                const containerRect = container.getBoundingClientRect();
                const nodes: HTMLElement[] = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
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
                const container = resolveScrollContainer();
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
    }, [findMessageElement, messageIndexMap, scrollMessageElementIntoView, resolveScrollContainer, scrollVirtualizerToIndex, shouldVirtualize, turnIndexMap, ref]);

    const disableFadeIn = shouldVirtualize && virtualizer.isScrolling;

    return (
        <div>
                {(turnStart > 0 || hasMoreAbove) && (
                    <div className="flex justify-center py-3">
                        {isLoadingOlder ? (
                            <span className="text-xs uppercase tracking-wide text-muted-foreground/80">
                                Loading…
                            </span>
                        ) : (
                            <button
                                type="button"
                                onClick={stableOnLoadOlder}
                                className="text-xs uppercase tracking-wide text-muted-foreground/80 hover:text-foreground"
                            >
                                Load older messages
                            </button>
                        )}
                    </div>
                )}

                {staging.isStaging ? (
                    <div className="flex justify-center py-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                            Revealing history…
                        </span>
                    </div>
                ) : null}

                <FadeInDisabledProvider disabled={disableFadeIn}>
                    {shouldVirtualize ? (
                        <div
                            className="relative w-full"
                            style={{ height: `${virtualizer.getTotalSize()}px` }}
                        >
                            {virtualRows.map((virtualRow: VirtualItem) => {
                                const entry = stagedEntries[virtualRow.index];
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
                                            onMessageContentChange={stableOnMessageContentChange}
                                            getAnimationHandlers={stableGetAnimationHandlers}
                                            scrollToBottom={stableScrollToBottom}
                                            stickyUserHeader={false}
                                            sessionIsWorking={sessionIsWorking}
                                            shouldAnimateUserMessage={shouldAnimateUserMessage}
                                            onUserAnimationConsumed={onUserAnimationConsumed}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="relative w-full">
                        <MessageListContent
                            entries={stagedEntries}
                            onMessageContentChange={stableOnMessageContentChange}
                            getAnimationHandlers={stableGetAnimationHandlers}
                            scrollToBottom={stableScrollToBottom}
                            stickyUserHeader={stickyUserHeader}
                            sessionIsWorking={sessionIsWorking}
                            shouldAnimateUserMessage={shouldAnimateUserMessage}
                            onUserAnimationConsumed={onUserAnimationConsumed}
                        />
                        </div>
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

                <div className="mb-3">
                    <StatusRow
                        isWorking={working.isWorking}
                        statusText={working.statusText}
                        isGenericStatus={working.isGenericStatus}
                        isWaitingForPermission={working.isWaitingForPermission}
                        wasAborted={working.wasAborted}
                        abortActive={working.abortActive}
                        retryInfo={working.retryInfo}
                        showAssistantStatus
                        showTodos={false}
                        agentName={currentAgentName}
                    />
                </div>

                {/* Bottom spacer */}
                <div className="flex-shrink-0" style={{ height: isMobile ? '40px' : '10vh' }} aria-hidden="true" />
        </div>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
