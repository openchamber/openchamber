/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { TurnGroupingContext as TurnGroupingContextType } from '../hooks/useTurnGrouping';
import { detectTurns, type Turn, type TurnActivityPart, type TurnActivityGroup } from '../hooks/useTurnGrouping';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useUIStore } from '@/stores/useUIStore';

interface ChatMessageEntry {
    info: Message;
    parts: Part[];
}

interface TurnDiffStats {
    additions: number;
    deletions: number;
    files: number;
}

interface TurnActivityInfo {
    activityParts: TurnActivityPart[];
    activityGroupSegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
    summaryBody?: string;
    diffStats?: TurnDiffStats;
}

interface NeighborInfo {
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
}

// Static data that only changes when messages change
interface TurnGroupingStaticData {
    turns: Turn[];
    messageToTurn: Map<string, Turn>;
    turnActivityInfo: Map<string, TurnActivityInfo>;
    lastTurnId: string | null;
    lastTurnMessageIds: Set<string>; // Messages belonging to the last turn
    defaultActivityExpanded: boolean;
    // Neighbor lookup - stable until messages change
    messageNeighbors: Map<string, NeighborInfo>;
}

// UI state that changes on user interaction (expand/collapse)
interface TurnGroupingUiStateData {
    turnUiStates: Map<string, { isExpanded: boolean }>;
    toggleGroup: (turnId: string) => void;
}

// Streaming state that changes frequently during assistant response
interface TurnGroupingStreamingData {
    sessionIsWorking: boolean;
    lastTurnActivityInfo?: TurnActivityInfo;
}

// Separate contexts to prevent unnecessary re-renders
const TurnGroupingStaticContext = React.createContext<TurnGroupingStaticData | null>(null);
const TurnGroupingUiStateContext = React.createContext<TurnGroupingUiStateData | null>(null);
const TurnGroupingStreamingContext = React.createContext<TurnGroupingStreamingData | null>(null);

// Track staticData reference to clear cache when it changes
let lastStaticDataRef: TurnGroupingStaticData | null = null;
const contextCache = new Map<string, TurnGroupingContextType>();

export const useTurnGroupingContextForMessage = (messageId: string): TurnGroupingContextType | undefined => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    const uiStateData = React.useContext(TurnGroupingUiStateContext);
    const streamingData = React.useContext(TurnGroupingStreamingContext);
    
    return React.useMemo(() => {
        if (!staticData || !uiStateData || !streamingData) return undefined;
        
        // Clear cache when staticData changes (new messages arrived)
        if (lastStaticDataRef !== staticData) {
            contextCache.clear();
            lastStaticDataRef = staticData;
        }
        
        const turn = staticData.messageToTurn.get(messageId);
        if (!turn) return undefined;
        
        const isAssistantMessage = turn.assistantMessages.some(
            (msg) => msg.info.id === messageId
        );
        if (!isAssistantMessage) return undefined;
        
        const isLastTurn = staticData.lastTurnId === turn.turnId;
        const lastTurnActivityVersion = isLastTurn
            ? `${streamingData.lastTurnActivityInfo?.activityParts.length ?? 0}:${streamingData.lastTurnActivityInfo?.summaryBody ?? ''}`
            : '';
        
        // Get UI state early - needed for cache key to ensure expand/collapse updates propagate
        const uiState = uiStateData.turnUiStates.get(turn.turnId) ?? { isExpanded: staticData.defaultActivityExpanded };
        const isExpanded = uiState.isExpanded;
        
        // Cache key must include:
        // - messageId: identifies the specific message
        // - isExpanded: UI state for this turn's activity group
        // - sessionIsWorking (last turn only): streaming state affects "working" indicator
        const cacheKey = isLastTurn 
            ? `${messageId}-${isExpanded}-${streamingData.sessionIsWorking}-${lastTurnActivityVersion}`
            : `${messageId}-${isExpanded}`;
        
        const cached = contextCache.get(cacheKey);
        if (cached) return cached;
        
        const activityInfo = isLastTurn
            ? streamingData.lastTurnActivityInfo
            : staticData.turnActivityInfo.get(turn.turnId);
        const activityParts = activityInfo?.activityParts ?? [];
        const activityGroupSegments = activityInfo?.activityGroupSegments ?? [];
        const hasTools = Boolean(activityInfo?.hasTools);
        const hasReasoning = Boolean(activityInfo?.hasReasoning);
        const summaryBody = activityInfo?.summaryBody;
        const diffStats = activityInfo?.diffStats;
        
        const firstAssistantId = turn.assistantMessages[0]?.info.id;
        const isFirstAssistantInTurn = messageId === firstAssistantId;
        const lastAssistantId = turn.assistantMessages[turn.assistantMessages.length - 1]?.info.id;
        const isLastAssistantInTurn = messageId === lastAssistantId;
        const headerMessageId = firstAssistantId;
        // Only the last turn can be "working"
        const isTurnWorking = isLastTurn && streamingData.sessionIsWorking;
        
        const userTimeInfo = turn.userMessage.info.time as { created?: number } | undefined;
        const userMessageCreatedAt = typeof userTimeInfo?.created === 'number' ? userTimeInfo.created : undefined;
        
        const context: TurnGroupingContextType = {
            turnId: turn.turnId,
            isFirstAssistantInTurn,
            isLastAssistantInTurn,
            summaryBody,
            activityParts,
            activityGroupSegments,
            headerMessageId,
            hasTools,
            hasReasoning,
            diffStats,
            userMessageCreatedAt,
            isWorking: isTurnWorking,
            isGroupExpanded: isExpanded,
            toggleGroup: () => uiStateData.toggleGroup(turn.turnId),
        };
        
        // Cache with size limit
        if (contextCache.size > 500) {
            const firstKey = contextCache.keys().next().value;
            if (firstKey) contextCache.delete(firstKey);
        }
        contextCache.set(cacheKey, context);
        
        return context;
    }, [staticData, uiStateData, streamingData, messageId]);
};

// Hook to get neighbor messages - uses context instead of passed messages array
export const useMessageNeighbors = (messageId: string): NeighborInfo => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    
    // Return stable reference from context - no dependencies on messages array
    return React.useMemo(() => {
        if (!staticData) return {};
        return staticData.messageNeighbors.get(messageId) ?? {};
    }, [staticData, messageId]);
};

// Hook to get last turn message IDs - only reads static context
export const useLastTurnMessageIds = (): Set<string> => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    return staticData?.lastTurnMessageIds ?? new Set();
};

// Static-only version of turn grouping context - does NOT subscribe to streaming context
// Use this for messages NOT in the last turn to avoid re-renders during streaming
// Still subscribes to UI state context for expand/collapse functionality
export const useTurnGroupingContextStatic = (messageId: string): TurnGroupingContextType | undefined => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    const uiStateData = React.useContext(TurnGroupingUiStateContext);
    
    return React.useMemo(() => {
        if (!staticData || !uiStateData) return undefined;
        
        const turn = staticData.messageToTurn.get(messageId);
        if (!turn) return undefined;
        
        const isAssistantMessage = turn.assistantMessages.some(
            (msg) => msg.info.id === messageId
        );
        if (!isAssistantMessage) return undefined;
        
        const activityInfo = staticData.turnActivityInfo.get(turn.turnId);
        const activityParts = activityInfo?.activityParts ?? [];
        const activityGroupSegments = activityInfo?.activityGroupSegments ?? [];
        const hasTools = Boolean(activityInfo?.hasTools);
        const hasReasoning = Boolean(activityInfo?.hasReasoning);
        const summaryBody = activityInfo?.summaryBody;
        const diffStats = activityInfo?.diffStats;
        
        const firstAssistantId = turn.assistantMessages[0]?.info.id;
        const isFirstAssistantInTurn = messageId === firstAssistantId;
        const lastAssistantId = turn.assistantMessages[turn.assistantMessages.length - 1]?.info.id;
        const isLastAssistantInTurn = messageId === lastAssistantId;
        const headerMessageId = firstAssistantId;
        
        const uiState = uiStateData.turnUiStates.get(turn.turnId) ?? { isExpanded: staticData.defaultActivityExpanded };
        
        const userTimeInfo = turn.userMessage.info.time as { created?: number } | undefined;
        const userMessageCreatedAt = typeof userTimeInfo?.created === 'number' ? userTimeInfo.created : undefined;
        
        // For static context, isWorking is always false (turn is completed)
        const context: TurnGroupingContextType = {
            turnId: turn.turnId,
            isFirstAssistantInTurn,
            isLastAssistantInTurn,
            summaryBody,
            activityParts,
            activityGroupSegments,
            headerMessageId,
            hasTools,
            hasReasoning,
            diffStats,
            userMessageCreatedAt,
            isWorking: false,
            isGroupExpanded: uiState.isExpanded,
            toggleGroup: () => uiStateData.toggleGroup(turn.turnId),
        };
        
        return context;
    }, [staticData, uiStateData, messageId]);
};

interface TurnGroupingProviderProps {
    messages: ChatMessageEntry[];
    children: React.ReactNode;
}

const ACTIVITY_STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const isActivityStandaloneTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && ACTIVITY_STANDALONE_TOOL_NAMES.has(toolName.toLowerCase());
};

const extractFinalAssistantText = (turn: Turn): string | undefined => {
    for (let messageIndex = turn.assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMsg = turn.assistantMessages[messageIndex];
        if (!assistantMsg) continue;

        const infoFinish = (assistantMsg.info as { finish?: string | null | undefined }).finish;
        if (infoFinish !== 'stop') continue;

        for (let partIndex = assistantMsg.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMsg.parts[partIndex];
            if (!part || part.type !== 'text') continue;

            const textContent = (part as { text?: string | null | undefined }).text ??
                (part as { content?: string | null | undefined }).content;
            if (typeof textContent === 'string' && textContent.trim().length > 0) {
                return textContent;
            }
        }
    }

    return undefined;
};

const getTurnActivityInfo = (turn: Turn, showTextJustificationActivity: boolean): TurnActivityInfo => {
    interface SummaryDiff {
        additions?: number | null | undefined;
        deletions?: number | null | undefined;
        file?: string | null | undefined;
    }
    interface UserSummaryPayload {
        body?: string | null | undefined;
        diffs?: SummaryDiff[] | null | undefined;
    }

    const summaryBody = extractFinalAssistantText(turn);

    let diffStats: TurnDiffStats | undefined;

    const summary = (turn.userMessage.info as { summary?: UserSummaryPayload | null | undefined }).summary;
    const diffs = summary?.diffs;
    if (Array.isArray(diffs) && diffs.length > 0) {
        let additions = 0;
        let deletions = 0;
        let files = 0;

        diffs.forEach((diff) => {
            if (!diff) return;
            const diffAdditions = typeof diff.additions === 'number' ? diff.additions : 0;
            const diffDeletions = typeof diff.deletions === 'number' ? diff.deletions : 0;
            if (diffAdditions !== 0 || diffDeletions !== 0) {
                files += 1;
            }
            additions += diffAdditions;
            deletions += diffDeletions;
        });

        if (files > 0) {
            diffStats = { additions, deletions, files };
        }
    }

    let hasTools = false;
    let hasReasoning = false;

    turn.assistantMessages.forEach((msg) => {
        msg.parts.forEach((part) => {
            if (part.type === 'tool') hasTools = true;
            else if (part.type === 'reasoning') hasReasoning = true;
        });
    });

    // Find the LAST assistant message that has text content - this is the summary
    // All other text messages are justification (yapping during work)
    let lastTextMessageId: string | undefined;
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
        const msg = turn.assistantMessages[i];
        if (!msg) continue;
        const hasText = msg.parts.some((p) => {
            if (p.type !== 'text') return false;
            const text = (p as { text?: string; content?: string }).text ?? 
                        (p as { text?: string; content?: string }).content;
            return typeof text === 'string' && text.trim().length > 0;
        });
        if (hasText) {
            lastTextMessageId = msg.info.id;
            break;
        }
    }

    const activityParts: TurnActivityPart[] = [];

    turn.assistantMessages.forEach((msg) => {
        const messageId = msg.info.id;
        
        // Only the LAST message with text is the summary (not justification)
        // All earlier text messages are justification
        const isFinalSummaryMessage = messageId === lastTextMessageId;

        msg.parts.forEach((part, partIndex) => {
            const baseId = `${messageId}-part-${partIndex}-${part.type}`;

            if (part.type === 'tool') {
                const state = (part as { state?: { time?: { end?: number | null | undefined } | null | undefined } | null | undefined }).state;
                const time = state?.time;
                const end = typeof time?.end === 'number' ? time.end : undefined;

                activityParts.push({
                    id: baseId,
                    turnId: turn.turnId,
                    messageId,
                    kind: 'tool',
                    part,
                    endedAt: end,
                });
                return;
            }

            if (part.type === 'reasoning') {
                const text = (part as { text?: string | null | undefined; content?: string | null | undefined }).text
                    ?? (part as { text?: string | null | undefined; content?: string | null | undefined }).content;
                if (typeof text !== 'string' || text.trim().length === 0) return;
                const time = (part as { time?: { end?: number | null | undefined } | null | undefined }).time;
                const end = typeof time?.end === 'number' ? time.end : undefined;

                activityParts.push({
                    id: baseId,
                    turnId: turn.turnId,
                    messageId,
                    kind: 'reasoning',
                    part,
                    endedAt: end,
                });
                return;
            }

            if (
                showTextJustificationActivity &&
                part.type === 'text' &&
                (hasTools || hasReasoning) &&
                !isFinalSummaryMessage
            ) {
                const text = (part as { text?: string | null | undefined; content?: string | null | undefined }).text ??
                    (part as { text?: string | null | undefined; content?: string | null | undefined }).content;
                if (typeof text !== 'string' || text.trim().length === 0) return;
                const time = (part as { time?: { end?: number | null | undefined } | null | undefined }).time;
                const end = typeof time?.end === 'number' ? time.end : undefined;

                activityParts.push({
                    id: baseId,
                    turnId: turn.turnId,
                    messageId,
                    kind: 'justification',
                    part,
                    endedAt: end,
                });
            }
        });
    });

    const activityGroupSegments: TurnActivityGroup[] = [];
    const activityByPart = new WeakMap<Part, TurnActivityPart>();
    activityParts.forEach((activity) => {
        activityByPart.set(activity.part, activity);
    });

    const taskMessageById = new Map<string, string>();
    const taskOrder: string[] = [];
    const partsByAfterTool = new Map<string | null, TurnActivityPart[]>();
    let currentAfterToolPartId: string | null = null;

    turn.assistantMessages.forEach((msg) => {
        const messageId = msg.info.id;

        msg.parts.forEach((part, partIndex) => {
            if (part.type === 'tool') {
                const toolName = (part as { tool?: unknown }).tool;
                if (isActivityStandaloneTool(toolName)) {
                    const toolPartId = `${messageId}-part-${partIndex}-${part.type}`;

                    if (!taskMessageById.has(toolPartId)) {
                        taskMessageById.set(toolPartId, messageId);
                        taskOrder.push(toolPartId);
                    }
                    currentAfterToolPartId = toolPartId;
                    return;
                }
            }

            const activity = activityByPart.get(part);
            if (!activity) return;

            if (activity.kind === 'tool') {
                const toolName = (activity.part as { tool?: unknown }).tool;
                if (isActivityStandaloneTool(toolName)) return;
            }

            const list = partsByAfterTool.get(currentAfterToolPartId) ?? [];
            list.push(activity);
            partsByAfterTool.set(currentAfterToolPartId, list);
        });
    });

    const pickAnchorForStartSegment = (segmentParts: TurnActivityPart[]): string | undefined => {
        if (segmentParts.length === 0) return undefined;

        const countByMessage = new Map<string, number>();
        segmentParts.forEach((activity) => {
            countByMessage.set(activity.messageId, (countByMessage.get(activity.messageId) ?? 0) + 1);
        });

        let firstWithAny: string | undefined;
        let cumulative = 0;
        for (const msg of turn.assistantMessages) {
            const count = countByMessage.get(msg.info.id) ?? 0;
            if (count > 0 && !firstWithAny) firstWithAny = msg.info.id;
            cumulative += count;
            if (cumulative >= 2) return msg.info.id;
        }
        return firstWithAny;
    };

    const orderedKeys: Array<string | null> = [null, ...taskOrder];

    orderedKeys.forEach((afterToolPartId) => {
        const segmentParts = partsByAfterTool.get(afterToolPartId) ?? [];
        if (segmentParts.length === 0) return;

        const anchorMessageId = afterToolPartId === null
            ? pickAnchorForStartSegment(segmentParts)
            : taskMessageById.get(afterToolPartId);

        if (!anchorMessageId) return;

        activityGroupSegments.push({
            id: `${turn.turnId}:${anchorMessageId}:${afterToolPartId ?? 'start'}`,
            anchorMessageId,
            afterToolPartId,
            parts: segmentParts,
        });
    });

    return {
        activityParts,
        activityGroupSegments,
        hasTools,
        hasReasoning,
        summaryBody,
        diffStats,
    };
};

// Build neighbor lookup map from messages
const buildNeighborMap = (messages: ChatMessageEntry[]): Map<string, NeighborInfo> => {
    const map = new Map<string, NeighborInfo>();
    messages.forEach((message, index) => {
        map.set(message.info.id, {
            previousMessage: index > 0 ? messages[index - 1] : undefined,
            nextMessage: index < messages.length - 1 ? messages[index + 1] : undefined,
        });
    });
    return map;
};

const getMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null | undefined }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const hasSameTurnStructure = (prev: ChatMessageEntry[], next: ChatMessageEntry[]): boolean => {
    if (prev === next) {
        return true;
    }
    if (prev.length !== next.length) {
        return false;
    }

    for (let index = 0; index < prev.length; index += 1) {
        if (prev[index] !== next[index]) {
            return false;
        }
        if (prev[index]?.info?.id !== next[index]?.info?.id) {
            return false;
        }
        if (getMessageRole(prev[index]) !== getMessageRole(next[index])) {
            return false;
        }
    }

    return true;
};

const getStructureKey = (messages: ChatMessageEntry[]): string => {
    if (messages.length === 0) return '';
    return messages
        .map((message) => `${message.info?.id ?? ''}:${getMessageRole(message)}`)
        .join('|');
};

const isAppendOnlyChange = (prev: ChatMessageEntry[], next: ChatMessageEntry[]): boolean => {
    if (prev.length > next.length) {
        return false;
    }

    for (let index = 0; index < prev.length; index += 1) {
        if (prev[index] !== next[index]) {
            return false;
        }
        if (prev[index]?.info?.id !== next[index]?.info?.id) {
            return false;
        }
        if (getMessageRole(prev[index]) !== getMessageRole(next[index])) {
            return false;
        }
    }

    return true;
};

const appendTurnsIncremental = (prevTurns: Turn[], appendedMessages: ChatMessageEntry[]): Turn[] => {
    if (appendedMessages.length === 0) {
        return prevTurns;
    }

    const nextTurns = prevTurns.length > 0
        ? [
            ...prevTurns.slice(0, -1),
            {
                ...prevTurns[prevTurns.length - 1],
                assistantMessages: [...prevTurns[prevTurns.length - 1].assistantMessages],
            },
        ]
        : [];

    let currentTurn = nextTurns.length > 0 ? nextTurns[nextTurns.length - 1] : null;

    appendedMessages.forEach((message) => {
        const role = getMessageRole(message);
        if (role === 'user') {
            currentTurn = {
                turnId: message.info.id,
                userMessage: message,
                assistantMessages: [],
            };
            nextTurns.push(currentTurn);
            return;
        }

        if (role === 'assistant' && currentTurn) {
            currentTurn.assistantMessages.push(message);
        }
    });

    return nextTurns;
};

const appendNeighborsIncremental = (
    prevNeighbors: Map<string, NeighborInfo>,
    prevMessages: ChatMessageEntry[],
    nextMessages: ChatMessageEntry[],
): Map<string, NeighborInfo> => {
    if (nextMessages.length <= prevMessages.length) {
        return prevNeighbors;
    }

    const appended = nextMessages.slice(prevMessages.length);
    if (appended.length === 0) {
        return prevNeighbors;
    }

    const nextNeighbors = new Map(prevNeighbors);
    const previousTail = prevMessages.length > 0 ? prevMessages[prevMessages.length - 1] : undefined;
    if (previousTail) {
        nextNeighbors.set(previousTail.info.id, {
            previousMessage: prevMessages.length > 1 ? prevMessages[prevMessages.length - 2] : undefined,
            nextMessage: appended[0],
        });
    }

    appended.forEach((message, index) => {
        const previousMessage = index === 0 ? previousTail : appended[index - 1];
        const nextMessage = index < appended.length - 1 ? appended[index + 1] : undefined;
        nextNeighbors.set(message.info.id, {
            previousMessage,
            nextMessage,
        });
    });

    return nextNeighbors;
};

export const TurnGroupingProvider: React.FC<TurnGroupingProviderProps> = ({ messages, children }) => {
    const { isWorking: sessionIsWorking } = useCurrentSessionActivity();
    const toolCallExpansion = useUIStore((state) => state.toolCallExpansion);
    const showTextJustificationActivity = useUIStore((state) => state.showTextJustificationActivity);
    const defaultActivityExpanded = toolCallExpansion === 'activity' || toolCallExpansion === 'detailed';
    const structureKeyCacheRef = React.useRef<{ messages: ChatMessageEntry[]; key: string } | null>(null);
    const structureKey = React.useMemo(() => {
        const cached = structureKeyCacheRef.current;
        if (cached && hasSameTurnStructure(cached.messages, messages)) {
            return cached.key;
        }

        const key = getStructureKey(messages);
        structureKeyCacheRef.current = {
            messages,
            key,
        };
        return key;
    }, [messages]);
    const staticCacheRef = React.useRef<{
        messages: ChatMessageEntry[];
        structureKey: string;
        defaultActivityExpanded: boolean;
        showTextJustificationActivity: boolean;
        value: TurnGroupingStaticData;
    } | null>(null);

    // Static data - avoid identity churn while assistant streams within existing turn structure.
    const staticValue = React.useMemo<TurnGroupingStaticData>(() => {
        const cached = staticCacheRef.current;
        if (
            cached &&
            hasSameTurnStructure(cached.messages, messages) &&
            cached.structureKey === structureKey &&
            cached.defaultActivityExpanded === defaultActivityExpanded &&
            cached.showTextJustificationActivity === showTextJustificationActivity
        ) {
            return cached.value;
        }

        if (
            cached &&
            cached.defaultActivityExpanded === defaultActivityExpanded &&
            cached.showTextJustificationActivity === showTextJustificationActivity &&
            isAppendOnlyChange(cached.messages, messages)
        ) {
            const appendedMessages = messages.slice(cached.messages.length);
            const turns = appendTurnsIncremental(cached.value.turns, appendedMessages);
            const lastTurnId = turns.length > 0 ? turns[turns.length - 1]!.turnId : null;

            const messageToTurn = new Map(cached.value.messageToTurn);
            let currentTurn = turns.length > 0 ? turns[turns.length - 1] : null;
            appendedMessages.forEach((message) => {
                const role = getMessageRole(message);
                if (role === 'user') {
                    currentTurn = turns.find((turn) => turn.turnId === message.info.id) ?? null;
                    if (currentTurn) {
                        messageToTurn.set(message.info.id, currentTurn);
                    }
                    return;
                }
                if (role === 'assistant' && currentTurn) {
                    messageToTurn.set(message.info.id, currentTurn);
                }
            });

            const turnActivityInfo = new Map(cached.value.turnActivityInfo);
            const previousLastTurnId = cached.value.lastTurnId;
            if (previousLastTurnId && previousLastTurnId !== lastTurnId) {
                const finalizedTurn = turns.find((turn) => turn.turnId === previousLastTurnId);
                if (finalizedTurn) {
                    turnActivityInfo.set(previousLastTurnId, getTurnActivityInfo(finalizedTurn, showTextJustificationActivity));
                }
            }
            if (lastTurnId) {
                turnActivityInfo.delete(lastTurnId);
            }

            const messageNeighbors = appendNeighborsIncremental(cached.value.messageNeighbors, cached.messages, messages);

            const lastTurnMessageIds = new Set<string>();
            if (turns.length > 0) {
                const lastTurn = turns[turns.length - 1]!;
                lastTurnMessageIds.add(lastTurn.userMessage.info.id);
                lastTurn.assistantMessages.forEach((msg) => {
                    lastTurnMessageIds.add(msg.info.id);
                });
            }

            const value: TurnGroupingStaticData = {
                turns,
                messageToTurn,
                turnActivityInfo,
                lastTurnId,
                lastTurnMessageIds,
                defaultActivityExpanded,
                messageNeighbors,
            };

            staticCacheRef.current = {
                messages,
                structureKey,
                defaultActivityExpanded,
                showTextJustificationActivity,
                value,
            };

            return value;
        }

        const turns = detectTurns(messages);
        const lastTurnId = turns.length > 0 ? turns[turns.length - 1]!.turnId : null;
        
        const messageToTurn = new Map<string, Turn>();
        turns.forEach((turn) => {
            messageToTurn.set(turn.userMessage.info.id, turn);
            turn.assistantMessages.forEach((msg) => {
                messageToTurn.set(msg.info.id, turn);
            });
        });

        const turnActivityInfo = new Map<string, TurnActivityInfo>();
        turns.forEach((turn) => {
            if (turn.turnId === lastTurnId) return;
            turnActivityInfo.set(turn.turnId, getTurnActivityInfo(turn, showTextJustificationActivity));
        });

        const messageNeighbors = buildNeighborMap(messages);

        // Build set of message IDs belonging to the last turn
        const lastTurnMessageIds = new Set<string>();
        if (turns.length > 0) {
            const lastTurn = turns[turns.length - 1]!;
            lastTurnMessageIds.add(lastTurn.userMessage.info.id);
            lastTurn.assistantMessages.forEach((msg) => {
                lastTurnMessageIds.add(msg.info.id);
            });
        }

        const value: TurnGroupingStaticData = {
            turns,
            messageToTurn,
            turnActivityInfo,
            lastTurnId,
            lastTurnMessageIds,
            defaultActivityExpanded,
            messageNeighbors,
        };

        staticCacheRef.current = {
            messages,
            structureKey,
            defaultActivityExpanded,
            showTextJustificationActivity,
            value,
        };

        return value;
    }, [defaultActivityExpanded, messages, showTextJustificationActivity, structureKey]);

    const lastTurnActivityInfo = React.useMemo<TurnActivityInfo | undefined>(() => {
        const lastTurnId = staticValue.lastTurnId;
        if (!lastTurnId) return undefined;
        // Find the last turn's user message in the current messages array to pick up
        // streaming content changes without a second full detectTurns() pass.
        const turns = staticValue.turns;
        const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
        if (!lastTurn) return undefined;
        // Re-slice assistant messages from the live `messages` array so that
        // streamed part updates are reflected without re-detecting all turns.
        const lastTurnUserId = lastTurn.userMessage.info.id;
        const liveAssistant: ChatMessageEntry[] = [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const candidate = messages[index];
            if (!candidate) {
                continue;
            }

            if (candidate.info.id === lastTurnUserId) {
                break;
            }

            const role = (candidate.info as { clientRole?: string | null }).clientRole ?? candidate.info.role;
            if (role === 'assistant') {
                liveAssistant.push(candidate);
            }
        }

        if (liveAssistant.length === 0 && messages.every((message) => message.info.id !== lastTurnUserId)) {
            return getTurnActivityInfo(lastTurn, showTextJustificationActivity);
        }

        liveAssistant.reverse();
        const liveTurn: Turn = { ...lastTurn, assistantMessages: liveAssistant };
        return getTurnActivityInfo(liveTurn, showTextJustificationActivity);
    }, [staticValue, messages, showTextJustificationActivity]);

    // UI state for expansion toggles
    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, { isExpanded: boolean }>>(
        () => new Map()
    );

    // Reset turn UI states when expansion preference changes
    React.useEffect(() => {
        setTurnUiStates(new Map());
    }, [toolCallExpansion]);

    const toggleGroup = React.useCallback((turnId: string) => {
        setTurnUiStates((prev) => {
            const next = new Map(prev);
            const current = next.get(turnId) ?? { isExpanded: defaultActivityExpanded };
            next.set(turnId, { isExpanded: !current.isExpanded });
            return next;
        });
    }, [defaultActivityExpanded]);

    // UI state - changes on user interaction (expand/collapse)
    const uiStateValue = React.useMemo<TurnGroupingUiStateData>(() => ({
        turnUiStates,
        toggleGroup,
    }), [turnUiStates, toggleGroup]);

    // Streaming state - changes frequently during assistant response
    const streamingValue = React.useMemo<TurnGroupingStreamingData>(() => ({
        sessionIsWorking,
        lastTurnActivityInfo,
    }), [lastTurnActivityInfo, sessionIsWorking]);

    return (
        <TurnGroupingStaticContext.Provider value={staticValue}>
            <TurnGroupingUiStateContext.Provider value={uiStateValue}>
                <TurnGroupingStreamingContext.Provider value={streamingValue}>
                    {children}
                </TurnGroupingStreamingContext.Provider>
            </TurnGroupingUiStateContext.Provider>
        </TurnGroupingStaticContext.Provider>
    );
};

// Clear context cache on unmount or session change
export const clearTurnGroupingCache = (): void => {
    contextCache.clear();
};
