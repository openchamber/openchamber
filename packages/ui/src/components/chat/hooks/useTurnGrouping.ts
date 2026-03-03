import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useUIStore } from '@/stores/useUIStore';

export interface ChatMessageEntry {
    info: Message;
    parts: Part[];
}

export interface Turn {
    turnId: string;
    userMessage: ChatMessageEntry;
    assistantMessages: ChatMessageEntry[];
}

export type TurnActivityKind = 'tool' | 'reasoning' | 'justification';

export interface TurnActivityPart {
    id: string;
    turnId: string;
    messageId: string;
    kind: TurnActivityKind;
    part: Part;
    endedAt?: number;
}

interface TurnDiffStats {
    additions: number;
    deletions: number;
    files: number;
}

export interface TurnActivityGroup {
    id: string;
    anchorMessageId: string;
    afterToolPartId: string | null;
    parts: TurnActivityPart[];
}

export interface TurnGroupingContext {
    turnId: string;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;

    summaryBody?: string;

    activityParts: TurnActivityPart[];
    activityGroupSegments: TurnActivityGroup[];
    headerMessageId?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    diffStats?: TurnDiffStats;
    userMessageCreatedAt?: number;

    isWorking: boolean;
    isGroupExpanded: boolean;

    toggleGroup: () => void;
}


interface TurnUiState {
    isExpanded: boolean;
}

interface TurnActivityInfo {
    activityParts: TurnActivityPart[];
    activityGroupSegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
    summaryBody?: string;
    diffStats?: TurnDiffStats;
}

const ACTIVITY_STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const isActivityStandaloneTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && ACTIVITY_STANDALONE_TOOL_NAMES.has(toolName.toLowerCase());
};

export const detectTurns = (messages: ChatMessageEntry[]): Turn[] => {
    const result: Turn[] = [];
    let currentTurn: Turn | null = null;

    messages.forEach((msg) => {
        const role = (msg.info as { clientRole?: string | null | undefined }).clientRole ?? msg.info.role;

        if (role === 'user') {
            currentTurn = {
                turnId: msg.info.id,
                userMessage: msg,
                assistantMessages: [],
            };
            result.push(currentTurn);
        } else if (role === 'assistant' && currentTurn) {
            currentTurn.assistantMessages.push(msg);
        }
    });

    return result;
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
            if (!diff) {
                return;
            }
            const diffAdditions = typeof diff.additions === 'number' ? diff.additions : 0;
            const diffDeletions = typeof diff.deletions === 'number' ? diff.deletions : 0;

            if (diffAdditions !== 0 || diffDeletions !== 0) {
                files += 1;
            }
            additions += diffAdditions;
            deletions += diffDeletions;
        });

        if (files > 0) {
            diffStats = {
                additions,
                deletions,
                files,
            };
        }
    }

    let hasTools = false;
    let hasReasoning = false;

    turn.assistantMessages.forEach((msg) => {
        msg.parts.forEach((part) => {
            if (part.type === 'tool') {
                hasTools = true;
            } else if (part.type === 'reasoning') {
                hasReasoning = true;
            }
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
                if (typeof text !== 'string' || text.trim().length === 0) {
                    return;
                }
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
                const text =
                    (part as { text?: string | null | undefined; content?: string | null | undefined }).text ??
                    (part as { text?: string | null | undefined; content?: string | null | undefined }).content;
                if (typeof text !== 'string' || text.trim().length === 0) {
                    return;
                }
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
            if (!activity) {
                return;
            }

            if (activity.kind === 'tool') {
                const toolName = (activity.part as { tool?: unknown }).tool;
                if (isActivityStandaloneTool(toolName)) {
                    return;
                }
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
            if (count > 0 && !firstWithAny) {
                firstWithAny = msg.info.id;
            }
            cumulative += count;
            if (cumulative >= 2) {
                return msg.info.id;
            }
        }
        return firstWithAny;
    };

    const orderedKeys: Array<string | null> = [null, ...taskOrder];

    orderedKeys.forEach((afterToolPartId) => {
        const segmentParts = partsByAfterTool.get(afterToolPartId) ?? [];
        if (segmentParts.length === 0) {
            return;
        }

        const anchorMessageId = afterToolPartId === null
            ? pickAnchorForStartSegment(segmentParts)
            : taskMessageById.get(afterToolPartId);

        if (!anchorMessageId) {
            return;
        }

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

interface UseTurnGroupingResult {
    turns: Turn[];
    getTurnForMessage: (messageId: string) => Turn | undefined;
    getContextForMessage: (messageId: string) => TurnGroupingContext | undefined;
}

export const useTurnGrouping = (messages: ChatMessageEntry[]): UseTurnGroupingResult => {
    const { isWorking: sessionIsWorking } = useCurrentSessionActivity();
    const showTextJustificationActivity = useUIStore((state) => state.showTextJustificationActivity);

    const turns = React.useMemo(() => detectTurns(messages), [messages]);

    const lastTurnId = React.useMemo(() => {
        if (turns.length === 0) return null;
        return turns[turns.length - 1]!.turnId;
    }, [turns]);

    const messageToTurn = React.useMemo(() => {
        const map = new Map<string, Turn>();
        turns.forEach((turn) => {
            map.set(turn.userMessage.info.id, turn);
            turn.assistantMessages.forEach((msg) => {
                map.set(msg.info.id, turn);
            });
        });
        return map;
    }, [turns]);

    const turnActivityInfo = React.useMemo(() => {
        const map = new Map<string, TurnActivityInfo>();
        turns.forEach((turn) => {
            map.set(turn.turnId, getTurnActivityInfo(turn, showTextJustificationActivity));
        });
        return map;
    }, [turns, showTextJustificationActivity]);

    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, TurnUiState>>(
        () => new Map()
    );

    const toolCallExpansion = useUIStore((state) => state.toolCallExpansion);
    // Activity group is expanded for 'activity', 'detailed', and 'changes'; collapsed for 'collapsed'
    const defaultActivityExpanded =
        toolCallExpansion === 'activity' || toolCallExpansion === 'detailed' || toolCallExpansion === 'changes';

    // Reset turn UI states when the expansion preference changes
    // This ensures the setting takes precedence over manual toggles
    React.useEffect(() => {
        setTurnUiStates(new Map());
    }, [toolCallExpansion]);
    
    const getOrCreateTurnState = React.useCallback(
        (turnId: string): TurnUiState => {
            const existing = turnUiStates.get(turnId);
            if (existing) return existing;
            return { isExpanded: defaultActivityExpanded };
        },
        [turnUiStates, defaultActivityExpanded]
    );

    const toggleGroup = React.useCallback((turnId: string) => {
        setTurnUiStates((prev) => {
            const next = new Map(prev);
            const current = next.get(turnId) ?? { isExpanded: defaultActivityExpanded };
            next.set(turnId, { isExpanded: !current.isExpanded });
            return next;
        });
    }, [defaultActivityExpanded]);

    const getTurnForMessage = React.useCallback(
        (messageId: string): Turn | undefined => {
            return messageToTurn.get(messageId);
        },
        [messageToTurn]
    );

    const getContextForMessage = React.useCallback(
        (messageId: string): TurnGroupingContext | undefined => {
            const turn = messageToTurn.get(messageId);
            if (!turn) return undefined;

            const isAssistantMessage = turn.assistantMessages.some(
                (msg) => msg.info.id === messageId
            );
            if (!isAssistantMessage) return undefined;

            const activityInfo = turnActivityInfo.get(turn.turnId);
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

            const uiState = getOrCreateTurnState(turn.turnId);
            const isTurnWorking = sessionIsWorking && lastTurnId === turn.turnId;

            const userTimeInfo = turn.userMessage.info.time as { created?: number } | undefined;
            const userMessageCreatedAt = typeof userTimeInfo?.created === 'number' ? userTimeInfo.created : undefined;

            return {
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
                isGroupExpanded: uiState.isExpanded,
                toggleGroup: () => toggleGroup(turn.turnId),
            } satisfies TurnGroupingContext;
        },
        [getOrCreateTurnState, lastTurnId, messageToTurn, sessionIsWorking, toggleGroup, turnActivityInfo]
    );


    return {
        turns,
        getTurnForMessage,
        getContextForMessage,
    };
};
