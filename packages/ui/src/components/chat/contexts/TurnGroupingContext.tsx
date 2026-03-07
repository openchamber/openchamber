/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { TurnGroupingContext as TurnGroupingContextType } from '../lib/turns/types';
import type { ChatMessageEntry, TurnProjectionResult } from '../lib/turns/types';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useUIStore } from '@/stores/useUIStore';

interface NeighborInfo {
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
}

interface TurnGroupingStaticData {
    structureKey: string;
    projection: TurnProjectionResult;
    messageNeighbors: Map<string, NeighborInfo>;
    defaultActivityExpanded: boolean;
}

interface TurnGroupingUiStateData {
    turnUiStates: Map<string, { isExpanded: boolean }>;
    toggleGroup: (turnId: string) => void;
}

interface TurnGroupingStreamingData {
    sessionIsWorking: boolean;
}

const TurnGroupingStaticContext = React.createContext<TurnGroupingStaticData | null>(null);
const TurnGroupingUiStateContext = React.createContext<TurnGroupingUiStateData | null>(null);
const TurnGroupingStreamingContext = React.createContext<TurnGroupingStreamingData | null>(null);

const contextCache = new Map<string, TurnGroupingContextType>();

const getMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const getStructureKey = (messages: ChatMessageEntry[]): string => {
    if (messages.length === 0) {
        return '';
    }
    return messages
        .map((message) => `${message.info.id}:${getMessageRole(message)}`)
        .join('|');
};

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

const buildTurnGroupingContext = (
    projection: TurnProjectionResult,
    messageId: string,
    isWorking: boolean,
    isExpanded: boolean,
    toggleGroup: (turnId: string) => void,
): TurnGroupingContextType | undefined => {
    const messageMeta = projection.indexes.messageMetaById.get(messageId);
    if (!messageMeta || !messageMeta.isAssistantMessage) {
        return undefined;
    }

    const turn = projection.indexes.turnById.get(messageMeta.turnId);
    if (!turn) {
        return undefined;
    }

    const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
    return {
        turnId: turn.turnId,
        isFirstAssistantInTurn: messageMeta.isFirstAssistantInTurn,
        isLastAssistantInTurn: messageMeta.isLastAssistantInTurn,
        summaryBody: turn.summaryText,
        activityParts: turn.activityParts,
        activityGroupSegments: turn.activitySegments,
        headerMessageId: turn.headerMessageId,
        hasTools: turn.hasTools,
        hasReasoning: turn.hasReasoning,
        diffStats: turn.diffStats,
        userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
        isWorking,
        isGroupExpanded: isExpanded,
        toggleGroup: () => toggleGroup(turn.turnId),
    };
};

export const useTurnGroupingContextForMessage = (messageId: string): TurnGroupingContextType | undefined => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    const uiStateData = React.useContext(TurnGroupingUiStateContext);
    const streamingData = React.useContext(TurnGroupingStreamingContext);

    return React.useMemo(() => {
        if (!staticData || !uiStateData || !streamingData) {
            return undefined;
        }

        const messageMeta = staticData.projection.indexes.messageMetaById.get(messageId);
        if (!messageMeta || !messageMeta.isAssistantMessage) {
            return undefined;
        }

        const isLastTurn = staticData.projection.lastTurnId === messageMeta.turnId;
        const isWorking = isLastTurn && streamingData.sessionIsWorking;
        const isExpanded = (uiStateData.turnUiStates.get(messageMeta.turnId) ?? { isExpanded: staticData.defaultActivityExpanded }).isExpanded;
        const cacheKey = `${staticData.structureKey}:${messageId}:${isExpanded}:${isWorking ? 1 : 0}`;
        const cached = contextCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const context = buildTurnGroupingContext(
            staticData.projection,
            messageId,
            isWorking,
            isExpanded,
            uiStateData.toggleGroup,
        );

        if (!context) {
            return undefined;
        }

        if (contextCache.size > 600) {
            const firstKey = contextCache.keys().next().value;
            if (firstKey) {
                contextCache.delete(firstKey);
            }
        }
        contextCache.set(cacheKey, context);
        return context;
    }, [messageId, staticData, streamingData, uiStateData]);
};

export const useTurnGroupingContextStatic = (messageId: string): TurnGroupingContextType | undefined => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    const uiStateData = React.useContext(TurnGroupingUiStateContext);

    return React.useMemo(() => {
        if (!staticData || !uiStateData) {
            return undefined;
        }

        const messageMeta = staticData.projection.indexes.messageMetaById.get(messageId);
        if (!messageMeta || !messageMeta.isAssistantMessage) {
            return undefined;
        }

        const isExpanded = (uiStateData.turnUiStates.get(messageMeta.turnId) ?? { isExpanded: staticData.defaultActivityExpanded }).isExpanded;
        return buildTurnGroupingContext(
            staticData.projection,
            messageId,
            false,
            isExpanded,
            uiStateData.toggleGroup,
        );
    }, [messageId, staticData, uiStateData]);
};

export const useMessageNeighbors = (messageId: string): NeighborInfo => {
    const staticData = React.useContext(TurnGroupingStaticContext);

    return React.useMemo(() => {
        if (!staticData) {
            return {};
        }
        return staticData.messageNeighbors.get(messageId) ?? {};
    }, [messageId, staticData]);
};

export const useLastTurnMessageIds = (): Set<string> => {
    const staticData = React.useContext(TurnGroupingStaticContext);
    return staticData?.projection.lastTurnMessageIds ?? new Set<string>();
};

interface TurnGroupingProviderProps {
    messages: ChatMessageEntry[];
    projection?: TurnProjectionResult;
    children: React.ReactNode;
}

export const TurnGroupingProvider: React.FC<TurnGroupingProviderProps> = ({ messages, projection, children }) => {
    const { isWorking: sessionIsWorking } = useCurrentSessionActivity();
    const toolCallExpansion = useUIStore((state) => state.toolCallExpansion);
    const showTextJustificationActivity = useUIStore((state) => state.showTextJustificationActivity);

    const defaultActivityExpanded =
        toolCallExpansion === 'activity' || toolCallExpansion === 'detailed' || toolCallExpansion === 'changes';
    const structureKey = React.useMemo(() => getStructureKey(messages), [messages]);

    const staticValue = React.useMemo<TurnGroupingStaticData>(() => {
        return {
            structureKey,
            projection: projection ?? projectTurnRecords(messages, { showTextJustificationActivity }),
            messageNeighbors: buildNeighborMap(messages),
            defaultActivityExpanded,
        };
    }, [defaultActivityExpanded, messages, projection, showTextJustificationActivity, structureKey]);

    const [turnUiStates, setTurnUiStates] = React.useState<Map<string, { isExpanded: boolean }>>(() => new Map());
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

    const uiStateValue = React.useMemo<TurnGroupingUiStateData>(() => {
        return { turnUiStates, toggleGroup };
    }, [toggleGroup, turnUiStates]);

    const streamingValue = React.useMemo<TurnGroupingStreamingData>(() => {
        return { sessionIsWorking };
    }, [sessionIsWorking]);

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

export const clearTurnGroupingCache = (): void => {
    contextCache.clear();
};
