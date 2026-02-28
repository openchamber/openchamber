import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useShallow } from 'zustand/react/shallow';

import { defaultCodeDark, defaultCodeLight } from '@/lib/codeTheme';
import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { useSessionStore } from '@/stores/useSessionStore';
import { useMessageStore } from '@/stores/messageStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useContextStore } from '@/stores/contextStore';
import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import { cn } from '@/lib/utils';

import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatScrollManager';
import MessageHeader from './message/MessageHeader';
import MessageBody from './message/MessageBody';
import type { AgentMentionInfo } from './message/types';
import type { StreamPhase, ToolPopupContent } from './message/types';
import { deriveMessageRole } from './message/messageRole';
import { filterVisibleParts } from './message/partUtils';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import type { TurnGroupingContext } from './hooks/useTurnGrouping';
import { copyTextToClipboard } from '@/lib/clipboard';

const ToolOutputDialog = React.lazy(() => import('./message/ToolOutputDialog'));

const DETAILED_DEFAULT_TOOLS = new Set(['task', 'edit', 'multiedit', 'write', 'apply_patch', 'bash', 'todowrite']);
const EXPANDED_TOOLS_CACHE_MAX = 4000;
const expandedToolsStateCache = new Map<string, Set<string>>();

const readExpandedToolsCache = (messageId: string): Set<string> => {
    const cached = expandedToolsStateCache.get(messageId);
    return cached ? new Set(cached) : new Set();
};

const writeExpandedToolsCache = (messageId: string, value: Set<string>): void => {
    if (expandedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX && !expandedToolsStateCache.has(messageId)) {
        const oldest = expandedToolsStateCache.keys().next().value;
        if (typeof oldest === 'string') {
            expandedToolsStateCache.delete(oldest);
        }
    }
    expandedToolsStateCache.set(messageId, new Set(value));
};

const isDetailedDefaultTool = (toolName: unknown): boolean =>
    typeof toolName === 'string' && DETAILED_DEFAULT_TOOLS.has(toolName.toLowerCase());

function useStickyDisplayValue<T>(value: T | null | undefined): T | null | undefined {
    const [stickyValue, setStickyValue] = React.useState<T | null | undefined>(value);

    React.useEffect(() => {
        if (value !== undefined && value !== null) {
            setStickyValue(value);
        }
    }, [value]);

    return value ?? stickyValue;
}

const getMessageInfoProp = (info: unknown, key: string): unknown => {
    if (typeof info === 'object' && info !== null) {
        return (info as Record<string, unknown>)[key];
    }
    return undefined;
};

interface ChatMessageProps {
    message: {
        info: Message;
        parts: Part[];
    };
    previousMessage?: {
        info: Message;
        parts: Part[];
    };
    nextMessage?: {
        info: Message;
        parts: Part[];
    };
    onContentChange?: (reason?: ContentChangeReason) => void;
    animationHandlers?: AnimationHandlers;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
    turnGroupingContext?: TurnGroupingContext;
}

const ChatMessage: React.FC<ChatMessageProps> = ({
    message,
    previousMessage,
    nextMessage,
    onContentChange,
    animationHandlers,
    turnGroupingContext,
}) => {
    const { isMobile, hasTouchInput } = useDeviceInfo();
    const { currentTheme } = useThemeSystem();
    const messageContainerRef = React.useRef<HTMLDivElement | null>(null);

    const sessionState = useSessionStore(
        useShallow((state) => ({
            lifecyclePhase: state.messageStreamStates.get(message.info.id)?.phase ?? null,
            isStreamingMessage: (() => {
                const sessionId =
                    (message.info as { sessionID?: string }).sessionID ??
                    state.currentSessionId ??
                    null;
                if (!sessionId) return false;
                return (state.streamingMessageIds.get(sessionId) ?? null) === message.info.id;
            })(),
            currentSessionId: state.currentSessionId,
            getAgentModelForSession: state.getAgentModelForSession,
            getSessionModelSelection: state.getSessionModelSelection,
            revertToMessage: state.revertToMessage,
            forkFromMessage: state.forkFromMessage,
        }))
    );

    const {
        lifecyclePhase,
        isStreamingMessage,
        currentSessionId,
        getAgentModelForSession,
        getSessionModelSelection,
        revertToMessage,
        forkFromMessage,
    } = sessionState;

    const providers = useConfigStore((state) => state.providers);
    const { showReasoningTraces, toolCallExpansion } = useUIStore(
        useShallow((state) => ({
            showReasoningTraces: state.showReasoningTraces,
            toolCallExpansion: state.toolCallExpansion,
        }))
    );

    React.useEffect(() => {
        if (currentSessionId) {
            MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
        }
    }, [currentSessionId]);

    const [copiedCode, setCopiedCode] = React.useState<string | null>(null);
    const [copiedMessage, setCopiedMessage] = React.useState(false);
    const [expandedTools, setExpandedTools] = React.useState<Set<string>>(() => readExpandedToolsCache(message.info.id));
    const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });

    React.useEffect(() => {
        setExpandedTools(readExpandedToolsCache(message.info.id));
    }, [message.info.id]);

    React.useEffect(() => {
        expandedToolsStateCache.clear();
        setExpandedTools(new Set());
    }, [toolCallExpansion]);

    const messageRole = React.useMemo(() => deriveMessageRole(message.info), [message.info]);
    const isUser = messageRole.isUser;

    const sessionId = message.info.sessionID;

    // Subscribe to context changes so badges update immediately on mode switches.
    const { currentContextAgent, savedSessionAgentSelection } = useContextStore(
        useShallow((state) => ({
            currentContextAgent: sessionId ? state.currentAgentContext.get(sessionId) : undefined,
            savedSessionAgentSelection: sessionId ? state.sessionAgentSelections.get(sessionId) : undefined,
        }))
    );

    const normalizedParts = React.useMemo(() => {
        if (!isUser) {
            return message.parts;
        }

        const keepSyntheticUserText = (text: string): boolean => {
            const trimmed = text.trim();
            if (trimmed.startsWith('User has requested to enter plan mode')) return true;
            if (trimmed.startsWith('The plan at ')) return true;
            if (trimmed.startsWith('The following tool was executed by the user')) return true;
            return false;
        };

        return message.parts
            .filter((part) => {
                const synthetic = (part as unknown as { synthetic?: boolean })?.synthetic === true;
                if (!synthetic) return true;
                if (part.type !== 'text') return false;
                const text = (part as unknown as { text?: unknown })?.text;
                return typeof text === 'string' ? keepSyntheticUserText(text) : false;
            })
            .map((part) => {
            const rawPart = part as Record<string, unknown>;
            if (rawPart.type === 'compaction') {
                return { type: 'text', text: '/compact' } as Part;
            }
            if (rawPart.type === 'text') {
                const text = typeof rawPart.text === 'string' ? rawPart.text.trim() : '';
                if (text.startsWith('The following tool was executed by the user')) {
                    return { type: 'text', text: '/shell' } as Part;
                }
            }
            return part;
        });
    }, [isUser, message.parts]);

    const previousUserMetadata = React.useMemo(() => {
        if (isUser || !previousMessage) {
            return null;
        }

        const clientRole = getMessageInfoProp(previousMessage.info, 'clientRole');
        const role = getMessageInfoProp(previousMessage.info, 'role');
        const previousRole = typeof clientRole === 'string' ? clientRole : (typeof role === 'string' ? role : undefined);
        if (previousRole !== 'user') {
            return null;
        }

        const mode = getMessageInfoProp(previousMessage.info, 'mode');
        const agent = getMessageInfoProp(previousMessage.info, 'agent');
        const providerID = getMessageInfoProp(previousMessage.info, 'providerID');
        const modelID = getMessageInfoProp(previousMessage.info, 'modelID');
        const variant = getMessageInfoProp(previousMessage.info, 'variant');
        const resolvedAgent =
            typeof mode === 'string' && mode.trim().length > 0
                ? mode
                : (typeof agent === 'string' && agent.trim().length > 0 ? agent : undefined);
        const resolvedProvider = typeof providerID === 'string' && providerID.trim().length > 0 ? providerID : undefined;
        const resolvedModel = typeof modelID === 'string' && modelID.trim().length > 0 ? modelID : undefined;
        const resolvedVariant = typeof variant === 'string' && variant.trim().length > 0 ? variant : undefined;

        if (!resolvedAgent && !resolvedProvider && !resolvedModel && !resolvedVariant) {
            return null;
        }

        return {
            agentName: resolvedAgent,
            providerId: resolvedProvider,
            modelId: resolvedModel,
            variant: resolvedVariant,
        };
    }, [isUser, previousMessage]);

    const previousIsModeSwitchMessage = React.useMemo(() => {
        if (isUser || !previousMessage) return false;
        const parts = Array.isArray(previousMessage.parts) ? previousMessage.parts : [];
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i] as unknown as { type?: string; text?: string; synthetic?: boolean };
            if (part?.type !== 'text') continue;
            if (part?.synthetic !== true) continue;
            const text = typeof part.text === 'string' ? part.text.trim() : '';
            if (text.startsWith('User has requested to enter plan mode') || text.startsWith('The plan at ')) {
                return true;
            }
        }
        return false;
    }, [isUser, previousMessage]);

    const agentName = React.useMemo(() => {
        if (isUser) return undefined;

        // While the assistant message is streaming, if the immediately previous user message is a
        // synthetic mode switch, trust that mode for the badge.
        const timeInfo = message.info.time as { completed?: number } | undefined;
        const isCompleted = typeof timeInfo?.completed === 'number' && timeInfo.completed > 0;
        if (!isCompleted && previousIsModeSwitchMessage && previousUserMetadata?.agentName) {
            return previousUserMetadata.agentName;
        }

        const messageMode = getMessageInfoProp(message.info, 'mode');
        if (typeof messageMode === 'string' && messageMode.trim().length > 0) {
            return messageMode;
        }

        const messageAgent = getMessageInfoProp(message.info, 'agent');
        if (typeof messageAgent === 'string' && messageAgent.trim().length > 0) {
            return messageAgent;
        }

        if (previousUserMetadata?.agentName) {
            return previousUserMetadata.agentName;
        }

        if (!sessionId) {
            return undefined;
        }

        if (currentContextAgent) {
            return currentContextAgent;
        }

        return savedSessionAgentSelection ?? undefined;
    }, [isUser, message.info, previousIsModeSwitchMessage, previousUserMetadata, sessionId, currentContextAgent, savedSessionAgentSelection]);

    const messageProviderID = !isUser ? getMessageInfoProp(message.info, 'providerID') : null;
    const messageModelID = !isUser ? getMessageInfoProp(message.info, 'modelID') : null;

    const contextModelSelection = React.useMemo(() => {
        if (isUser || !sessionId) return null;

        if (previousUserMetadata?.providerId && previousUserMetadata?.modelId) {
            return {
                providerId: previousUserMetadata.providerId,
                modelId: previousUserMetadata.modelId,
            };
        }

        if (agentName) {
            const agentSelection = getAgentModelForSession(sessionId, agentName);
            if (agentSelection?.providerId && agentSelection?.modelId) {
                return agentSelection;
            }
        }

        const sessionSelection = getSessionModelSelection(sessionId);
        if (sessionSelection?.providerId && sessionSelection?.modelId) {
            return sessionSelection;
        }

        return null;
    }, [isUser, sessionId, agentName, previousUserMetadata, getAgentModelForSession, getSessionModelSelection]);

    const providerID = React.useMemo(() => {
        if (isUser) return null;
        if (typeof messageProviderID === 'string' && messageProviderID.trim().length > 0) {
            return messageProviderID;
        }
        return contextModelSelection?.providerId ?? null;
    }, [isUser, messageProviderID, contextModelSelection]);

    const modelID = React.useMemo(() => {
        if (isUser) return null;
        if (typeof messageModelID === 'string' && messageModelID.trim().length > 0) {
            return messageModelID;
        }
        return contextModelSelection?.modelId ?? null;
    }, [isUser, messageModelID, contextModelSelection]);

    const modelName = React.useMemo(() => {
        if (isUser) return undefined;

        if (providerID && modelID && providers.length > 0) {
            const provider = providers.find((p) => p.id === providerID);
            if (provider?.models && Array.isArray(provider.models)) {
                const model = provider.models.find((m: Record<string, unknown>) => (m as Record<string, unknown>).id === modelID);
                const modelObj = model as Record<string, unknown> | undefined;
                const name = modelObj?.name;
                return typeof name === 'string' ? name : undefined;
            }
        }

        return undefined;
    }, [isUser, providerID, modelID, providers]);

    const modelHasVariants = React.useMemo(() => {
        if (isUser) return false;
        if (!providerID || !modelID) return false;

        const provider = providers.find((p) => p.id === providerID);
        if (!provider?.models || !Array.isArray(provider.models)) {
            return false;
        }

        const model = provider.models.find((m: Record<string, unknown>) => (m as Record<string, unknown>).id === modelID) as
            | { variants?: Record<string, unknown> }
            | undefined;

        const variants = model?.variants;
        return Boolean(variants && Object.keys(variants).length > 0);
    }, [isUser, modelID, providerID, providers]);

    const displayAgentName = useStickyDisplayValue<string>(agentName);
    const displayProviderIDValue = useStickyDisplayValue<string>(providerID ?? undefined);
    const displayModelName = useStickyDisplayValue<string>(modelName);

    const headerAgentName = displayAgentName ?? undefined;
    const headerProviderID = displayProviderIDValue ?? null;
    const headerModelName = displayModelName ?? undefined;

    const messageCompletedAt = React.useMemo(() => {
        const timeInfo = message.info.time as { completed?: number } | undefined;
        return typeof timeInfo?.completed === 'number' ? timeInfo.completed : null;
    }, [message.info.time]);

    const messageCreatedAt = React.useMemo(() => {
        const timeInfo = message.info.time as { created?: number } | undefined;
        return typeof timeInfo?.created === 'number' ? timeInfo.created : null;
    }, [message.info.time]);

    const isMessageCompleted = React.useMemo(() => {
        if (isUser) return true;
        return Boolean(messageCompletedAt && messageCompletedAt > 0);
    }, [isUser, messageCompletedAt]);

    const messageFinish = React.useMemo(() => {
        const finish = (message.info as { finish?: string }).finish;
        return typeof finish === 'string' ? finish : undefined;
    }, [message.info]);

    const visibleParts = React.useMemo(
        () =>
            filterVisibleParts(normalizedParts, {
                includeReasoning: showReasoningTraces,
            }),
        [normalizedParts, showReasoningTraces]
    );

    const displayParts = React.useMemo(() => {
        if (isUser) {
            return visibleParts;
        }

        return isMessageCompleted ? visibleParts : [];
    }, [isUser, isMessageCompleted, visibleParts]);


    const assistantTextParts = React.useMemo(() => {
        if (isUser) {
            return [];
        }
        return visibleParts.filter((part) => part.type === 'text');
    }, [isUser, visibleParts]);

    const toolParts = React.useMemo(() => {
        if (isUser) {
            return [];
        }
        const filtered = visibleParts.filter((part) => part.type === 'tool');
        return filtered;
    }, [isUser, visibleParts]);

    const effectiveExpandedTools = React.useMemo(() => {
        // 'collapsed': Activity and tools start collapsed
        // 'activity': Activity expanded, tools collapsed
        // 'detailed': Activity expanded, only key tools expanded

        if (toolCallExpansion === 'collapsed' || toolCallExpansion === 'activity') {
            // Tools default collapsed: expandedTools contains IDs of tools that ARE expanded
            return expandedTools;
        }

        // 'detailed': expand only allowlisted tools by default.
        // expandedTools acts as a "toggled" set (XOR with defaults).
        const defaultExpandedToolIds = new Set<string>();

        for (const part of toolParts) {
            const toolName = (part as { tool?: unknown }).tool;
            if (part.id && isDetailedDefaultTool(toolName)) {
                defaultExpandedToolIds.add(part.id);
            }
        }

        if (turnGroupingContext?.isFirstAssistantInTurn) {
            for (const activity of turnGroupingContext.activityParts) {
                if (activity.kind !== 'tool') {
                    continue;
                }

                const toolPart = activity.part as unknown as { id?: string; tool?: unknown };
                if (isDetailedDefaultTool(toolPart.tool)) {
                    if (toolPart.id) {
                        defaultExpandedToolIds.add(toolPart.id);
                    }
                    if (activity.id) {
                        defaultExpandedToolIds.add(activity.id);
                    }
                }
            }
        }

        const effective = new Set(defaultExpandedToolIds);
        for (const id of expandedTools) {
            if (effective.has(id)) {
                effective.delete(id);
            } else {
                effective.add(id);
            }
        }
        return effective;
    }, [expandedTools, toolCallExpansion, toolParts, turnGroupingContext]);

    const agentMention = React.useMemo(() => {
        if (!isUser) {
            return undefined;
        }
        const mentionPart = message.parts.find((part) => part.type === 'agent');
        if (!mentionPart) {
            return undefined;
        }
        const partWithName = mentionPart as { name?: string; source?: { value?: string } };
        const name = typeof partWithName.name === 'string' ? partWithName.name : undefined;
        if (!name) {
            return undefined;
        }
        const rawValue = partWithName.source && typeof partWithName.source.value === 'string' && partWithName.source.value.trim().length > 0
            ? partWithName.source.value
            : `@${name}`;
        return { name, token: rawValue } satisfies AgentMentionInfo;
    }, [isUser, message.parts]);

    const shouldHideUserMessage = isUser && displayParts.length === 0;

    // Message is considered to have an "open step" if info.finish is not yet present
    const hasOpenStep = typeof messageFinish !== 'string';

    const shouldCoordinateRendering = React.useMemo(() => {
        if (isUser) {
            return false;
        }
        if (assistantTextParts.length === 0 || toolParts.length === 0) {
            return hasOpenStep;
        }
        return true;
    }, [assistantTextParts.length, toolParts.length, hasOpenStep, isUser]);

    const themeVariant = currentTheme?.metadata.variant;
    const isDarkTheme = React.useMemo(() => {
        if (themeVariant) {
            return themeVariant === 'dark';
        }
        if (typeof document !== 'undefined') {
            return document.documentElement.classList.contains('dark');
        }
        return false;
    }, [themeVariant]);

    const syntaxTheme = React.useMemo(() => {
        if (currentTheme) {
            return generateSyntaxTheme(currentTheme);
        }
        return isDarkTheme ? defaultCodeDark : defaultCodeLight;
    }, [currentTheme, isDarkTheme]);

    const shouldAnimateMessage = React.useMemo(() => {
        if (isUser) return false;
        const freshnessDetector = MessageFreshnessDetector.getInstance();
        return freshnessDetector.shouldAnimateMessage(message.info, currentSessionId || message.info.sessionID);
    }, [message.info, currentSessionId, isUser]);

    const [hasStartedStreamingHeader, setHasStartedStreamingHeader] = React.useState(false);

    const previousRole = React.useMemo(() => {
        if (!previousMessage) return null;
        return deriveMessageRole(previousMessage.info);
    }, [previousMessage]);

    const nextRole = React.useMemo(() => {
        if (!nextMessage) return null;
        return deriveMessageRole(nextMessage.info);
    }, [nextMessage]);

    const isFollowedByAssistant = React.useMemo(() => {
        if (isUser) return false;
        if (!nextRole) return false;
        return !nextRole.isUser && nextRole.role === 'assistant';
    }, [isUser, nextRole]);

    const streamPhase: StreamPhase = React.useMemo(() => {
        if (isMessageCompleted) {
            return 'completed';
        }
        if (lifecyclePhase) {
            return lifecyclePhase;
        }
        return isStreamingMessage ? 'streaming' : 'completed';
    }, [isMessageCompleted, lifecyclePhase, isStreamingMessage]);

    React.useEffect(() => {
        setHasStartedStreamingHeader(false);
    }, [message.info.id]);

    React.useEffect(() => {
        const headerMessageId = turnGroupingContext?.headerMessageId;
        if (isUser || !headerMessageId || headerMessageId !== message.info.id) {
            return;
        }

        const isCurrentlyStreaming = streamPhase === 'streaming' || streamPhase === 'cooldown';
        if (isCurrentlyStreaming) {
            setHasStartedStreamingHeader(true);
        }
    }, [isUser, message.info.id, streamPhase, turnGroupingContext?.headerMessageId]);

    const shouldShowHeader = React.useMemo(() => {
        if (isUser) return true;

        // Use turn grouping context if available for more precise control
        const headerMessageId = turnGroupingContext?.headerMessageId;
        if (headerMessageId) {
            // For turn grouping: only show header for the first assistant message in the turn
            const isFirstAssistantInTurn = message.info.id === headerMessageId;

            if (isFirstAssistantInTurn) {
                // For completed messages, always show header (historical messages)
                if (streamPhase === 'completed') {
                    return true;
                }

                // For streaming messages: show header when streaming starts and keep it visible
                const isCurrentlyStreaming = streamPhase === 'streaming' || streamPhase === 'cooldown';
                return hasStartedStreamingHeader || isCurrentlyStreaming;
            }

            // For non-first assistant messages, don't show header
            return false;
        }

        // Fallback to original logic when turn grouping is not available
        if (!previousRole) return true;
        return previousRole.isUser;
    }, [hasStartedStreamingHeader, isUser, previousRole, turnGroupingContext, streamPhase, message.info]);

    const handleCopyCode = React.useCallback((code: string) => {
        void copyTextToClipboard(code).then((result) => {
            if (!result.ok) {
                return;
            }
            setCopiedCode(code);
            setTimeout(() => setCopiedCode(null), 2000);
        });
    }, []);

    const userMessageIdForTurn = turnGroupingContext?.turnId;
    const { assistantSummaryFromStore, variantFromTurnStore } = useMessageStore(
        useShallow((state) => {
            if (!userMessageIdForTurn || !message.info.sessionID) {
                return { assistantSummaryFromStore: undefined, variantFromTurnStore: undefined };
            }
            const sessionMessages = state.messages.get(message.info.sessionID);
            if (!sessionMessages) {
                return { assistantSummaryFromStore: undefined, variantFromTurnStore: undefined };
            }
            const userMsg = sessionMessages.find((entry) => entry.info?.id === userMessageIdForTurn);
            if (!userMsg) {
                return { assistantSummaryFromStore: undefined, variantFromTurnStore: undefined };
            }
            const summary = (userMsg.info as { summary?: { body?: string | null | undefined } | null | undefined }).summary;
            const body = summary?.body;
            const variant = (userMsg.info as { variant?: unknown }).variant;
            return {
                assistantSummaryFromStore: typeof body === 'string' && body.trim().length > 0 ? body : undefined,
                variantFromTurnStore: typeof variant === 'string' && variant.trim().length > 0 ? variant : undefined,
            };
        })
    );

    const headerVariantRaw = !isUser ? (variantFromTurnStore ?? previousUserMetadata?.variant) : undefined;

    const headerVariant = !isUser && modelHasVariants ? (headerVariantRaw ?? 'Default') : undefined;

    const assistantSummaryCandidate =
        typeof turnGroupingContext?.summaryBody === 'string' && turnGroupingContext.summaryBody.trim().length > 0
            ? turnGroupingContext.summaryBody
            : assistantSummaryFromStore;

    const [assistantSummaryForCopy, setAssistantSummaryForCopy] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        setAssistantSummaryForCopy(undefined);
    }, [userMessageIdForTurn]);

    React.useEffect(() => {
        if (assistantSummaryCandidate && assistantSummaryCandidate.trim().length > 0) {
            setAssistantSummaryForCopy(assistantSummaryCandidate);
        }
    }, [assistantSummaryCandidate]);

    const assistantErrorText = React.useMemo(() => {
        if (isUser) {
            return undefined;
        }
        const errorInfo = (message.info as { error?: unknown } | undefined)?.error as
            | { data?: { message?: unknown }; message?: unknown; name?: unknown }
            | undefined;
        if (!errorInfo) {
            return undefined;
        }
        const dataMessage = typeof errorInfo.data?.message === 'string' ? errorInfo.data.message : undefined;
        const errorMessage = typeof errorInfo.message === 'string' ? errorInfo.message : undefined;
        const errorName = typeof errorInfo.name === 'string' ? errorInfo.name : undefined;
        const detail = dataMessage || errorMessage || errorName;
        if (!detail) {
            return undefined;
        }
        if (errorName === 'SessionRetry') {
            return `Opencode failed to send a message. Retry attempt info: \n\`${detail}\``;
        }
        if (isLikelyProviderAuthFailure(detail)) {
            return PROVIDER_AUTH_FAILURE_MESSAGE;
        }
        return `Opencode failed to send message with error:\n\`${detail}\``;
    }, [isUser, message.info]);

    const messageTextContent = React.useMemo(() => {
        if (isUser) {
            const shellOutputs = displayParts
                .filter((part): part is Part & { type: 'text'; shellAction?: { output?: unknown } } => part.type === 'text')
                .map((part) => {
                    const output = part.shellAction?.output;
                    return typeof output === 'string' ? output.trim() : '';
                })
                .filter((output) => output.length > 0);

            if (shellOutputs.length > 0) {
                return shellOutputs.join('\n\n');
            }

            const shellCommands = displayParts
                .filter((part): part is Part & { type: 'text'; shellAction?: { command?: unknown } } => part.type === 'text')
                .map((part) => {
                    const command = part.shellAction?.command;
                    return typeof command === 'string' ? command.trim() : '';
                })
                .filter((command) => command.length > 0);

            if (shellCommands.length > 0) {
                return shellCommands.join('\n');
            }

            const textParts = displayParts
                .filter((part): part is Part & { type: 'text'; text?: string; content?: string } => part.type === 'text')
                .map((part) => {
                    const text = part.text || part.content || '';
                    return text.trim();
                })
                .filter((text) => text.length > 0);

            const combined = textParts.join('\n');
            return combined.replace(/\n\s*\n+/g, '\n');
        }

        if (assistantErrorText && assistantErrorText.trim().length > 0) {
            return assistantErrorText;
        }

        if (assistantSummaryForCopy && assistantSummaryForCopy.trim().length > 0) {
            return assistantSummaryForCopy;
        }

        return flattenAssistantTextParts(displayParts);
    }, [assistantErrorText, assistantSummaryForCopy, displayParts, isUser]);

    const hasTextContent = messageTextContent.length > 0;

    const handleCopyMessage = React.useCallback(async () => {
        const result = await copyTextToClipboard(messageTextContent);
        if (!result.ok) {
            return;
        }
        setCopiedMessage(true);
        setTimeout(() => setCopiedMessage(false), 2000);
    }, [messageTextContent]);

    const handleRevert = React.useCallback(() => {
        if (!sessionId || !message.info.id) return;
        revertToMessage(sessionId, message.info.id);
    }, [sessionId, message.info.id, revertToMessage]);

    // NEW: Fork handler
    const handleFork = React.useCallback(() => {
        if (!sessionId || !message.info.id) return;
        forkFromMessage(sessionId, message.info.id);
    }, [sessionId, message.info.id, forkFromMessage]);

    const handleToggleTool = React.useCallback((toolId: string) => {
        setExpandedTools((prev) => {
            const next = new Set(prev);
            if (next.has(toolId)) {
                next.delete(toolId);
            } else {
                next.add(toolId);
            }
            writeExpandedToolsCache(message.info.id, next);
            return next;
        });
    }, [message.info.id]);

    const resolvedAnimationHandlers = animationHandlers ?? null;
    const hasAnnouncedAuxiliaryScrollRef = React.useRef(false);

    const animationCompletedRef = React.useRef(false);
    const hasRequestedReservationRef = React.useRef(false);
    const animationStartNotifiedRef = React.useRef(false);
    const hasTriggeredReservationOnceRef = React.useRef(false);

    React.useEffect(() => {
        animationCompletedRef.current = false;
        hasRequestedReservationRef.current = false;
        animationStartNotifiedRef.current = false;
        hasTriggeredReservationOnceRef.current = false;
        hasAnnouncedAuxiliaryScrollRef.current = false;
    }, [message.info.id]);

    const handleAuxiliaryContentComplete = React.useCallback(() => {
        if (isUser) {
            return;
        }
        if (hasAnnouncedAuxiliaryScrollRef.current) {
            return;
        }
        hasAnnouncedAuxiliaryScrollRef.current = true;
        onContentChange?.('structural');
    }, [isUser, onContentChange]);

    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);

    const handleShowPopup = React.useCallback((content: ToolPopupContent) => {

        if (content.image || content.mermaid) {
            setPopupContent(content);
            setImagePreviewOpen(true);
        }
    }, [setImagePreviewOpen]);

    const handlePopupChange = React.useCallback((open: boolean) => {
        setPopupContent((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    const isAnimationSettled = Boolean(getMessageInfoProp(message.info, 'animationSettled'));
    const isStreamingPhase = streamPhase === 'streaming';

    const hasReasoningParts = React.useMemo(() => {
        if (isUser) {
            return false;
        }
        return visibleParts.some((part) => part.type === 'reasoning');
    }, [isUser, visibleParts]);

    const allowAnimation = shouldAnimateMessage && !isAnimationSettled && !isStreamingPhase;
    const shouldReserveAnimationSpace = !isUser && shouldAnimateMessage && assistantTextParts.length > 0 && !shouldCoordinateRendering;

    React.useEffect(() => {
        if (!resolvedAnimationHandlers?.onStreamingCandidate) {
            return;
        }

        if (!shouldReserveAnimationSpace) {
            if (hasRequestedReservationRef.current) {
                if (hasReasoningParts && resolvedAnimationHandlers?.onReasoningBlock) {
                    resolvedAnimationHandlers.onReasoningBlock();
                } else if (resolvedAnimationHandlers?.onReservationCancelled) {
                    resolvedAnimationHandlers.onReservationCancelled();
                }
                hasRequestedReservationRef.current = false;
            }
            return;
        }

        if (hasTriggeredReservationOnceRef.current) {
            return;
        }

        hasTriggeredReservationOnceRef.current = true;
        resolvedAnimationHandlers.onStreamingCandidate();
        hasRequestedReservationRef.current = true;
    }, [resolvedAnimationHandlers, shouldReserveAnimationSpace, hasReasoningParts]);

    React.useEffect(() => {
        if (!resolvedAnimationHandlers?.onAnimationStart) {
            return;
        }
        if (!allowAnimation) {
            return;
        }
        if (animationStartNotifiedRef.current) {
            return;
        }
        resolvedAnimationHandlers.onAnimationStart();
        animationStartNotifiedRef.current = true;
    }, [resolvedAnimationHandlers, allowAnimation]);

    React.useEffect(() => {
        if (isUser) {
            return;
        }

        const handler = resolvedAnimationHandlers?.onAnimatedHeightChange;
        if (!handler) {
            return;
        }

        const shouldTrackHeight = allowAnimation || shouldReserveAnimationSpace;
        if (!shouldTrackHeight) {
            return;
        }

        const element = messageContainerRef.current;
        if (!element) {
            return;
        }

        if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
            handler(element.getBoundingClientRect().height);
            return;
        }

        let rafId: number | null = null;
        const notifyHeight = (height: number) => {
            if (typeof window === 'undefined') {
                handler(height);
                return;
            }
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
                handler(height);
            });
        };

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) {
                return;
            }
            notifyHeight(entry.contentRect.height);
        });

        observer.observe(element);
        notifyHeight(element.getBoundingClientRect().height);

        return () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            observer.disconnect();
        };
    }, [allowAnimation, isUser, resolvedAnimationHandlers, shouldReserveAnimationSpace]);

    if (shouldHideUserMessage) {
        return null;
    }

    return (
        <>
            <div
                className={cn(
                    'group w-full',
                    isUser ? (isMobile ? 'pt-2' : 'pt-6') : (shouldShowHeader ? (isMobile ? 'pt-10' : 'pt-6') : 'pt-0'),
                    isUser ? 'pb-0' : isFollowedByAssistant ? 'pb-0' : 'pb-8'
                )}
                data-message-id={message.info.id}
                ref={messageContainerRef}
            >
                <div className="chat-message-column relative">
                    {isUser ? (
                        displayParts.length === 0 ? null : (
                        <FadeInOnReveal>
                            <div className="flex justify-end">
                                <div style={{ backgroundColor: 'var(--chat-user-message-bg)' }} className="max-w-[85%] rounded-2xl rounded-br-sm px-5 py-3 shadow-none border border-primary/5">
                                    <MessageBody
                                        messageId={message.info.id}
                                        parts={displayParts}
                                        isUser={isUser}
                                        isMessageCompleted={isMessageCompleted}
                                        messageFinish={messageFinish}
                                        syntaxTheme={syntaxTheme}
                                        isMobile={isMobile}
                                        hasTouchInput={hasTouchInput}
                                        copiedCode={copiedCode}
                                        onCopyCode={handleCopyCode}
                                        expandedTools={expandedTools}
                                        onToggleTool={handleToggleTool}
                                        onShowPopup={handleShowPopup}
                                        streamPhase={streamPhase}
                                        allowAnimation={allowAnimation}
                                        onContentChange={onContentChange}
                                        shouldShowHeader={false}
                                        hasTextContent={hasTextContent}
                                        onCopyMessage={handleCopyMessage}
                                        copiedMessage={copiedMessage}
                                        showReasoningTraces={showReasoningTraces}
                                        onAuxiliaryContentComplete={handleAuxiliaryContentComplete}
                                        agentMention={agentMention}
                                        onRevert={handleRevert}
                                        onFork={isUser ? handleFork : undefined}
                                        errorMessage={assistantErrorText}
                                    />
                                </div>
                            </div>
                        </FadeInOnReveal>
                        )
                    ) : (
                        <div className="relative">
                            {shouldShowHeader && (
                                <MessageHeader
                                    isUser={isUser}
                                    providerID={headerProviderID}
                                    agentName={headerAgentName}
                                    modelName={headerModelName}
                                    variant={headerVariant}
                                    isDarkTheme={isDarkTheme}
                                />
                            )}

                            <MessageBody
                                messageId={message.info.id}
                                parts={visibleParts}
                                isUser={isUser}
                                isMessageCompleted={isMessageCompleted}
                                messageFinish={messageFinish}
                                messageCompletedAt={messageCompletedAt ?? undefined}
                                messageCreatedAt={messageCreatedAt ?? undefined}
                                syntaxTheme={syntaxTheme}
                                isMobile={isMobile}
                                hasTouchInput={hasTouchInput}
                                copiedCode={copiedCode}
                                onCopyCode={handleCopyCode}
                                expandedTools={effectiveExpandedTools}
                                onToggleTool={handleToggleTool}
                                onShowPopup={handleShowPopup}
                                streamPhase={streamPhase}
                                allowAnimation={allowAnimation}
                                onContentChange={onContentChange}
                                shouldShowHeader={shouldShowHeader}
                                hasTextContent={hasTextContent}
                                onCopyMessage={handleCopyMessage}
                                copiedMessage={copiedMessage}
                                onAuxiliaryContentComplete={handleAuxiliaryContentComplete}
                                showReasoningTraces={showReasoningTraces}
                                agentMention={agentMention}
                                turnGroupingContext={turnGroupingContext}
                                errorMessage={assistantErrorText}
                            />

                        </div>
                    )}
                </div>
            </div>
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={popupContent}
                    onOpenChange={handlePopupChange}
                    syntaxTheme={syntaxTheme}
                    isMobile={isMobile}
                />
            </React.Suspense>
        </>
    );
};

export default React.memo(ChatMessage);
