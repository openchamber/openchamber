import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useShallow } from 'zustand/react/shallow';

import { defaultCodeDark, defaultCodeLight } from '@/lib/codeTheme';
import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useContextStore } from '@/stores/contextStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
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
import { normalizeUserDisplayParts } from './message/normalizeUserDisplayParts';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from '@/lib/messages/providerAuthError';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { TurnGroupingContext } from './lib/turns/types';
import { copyTextToClipboard } from '@/lib/clipboard';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { areOptionalRenderRelevantMessagesEqual, areRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual } from './message/renderCompare';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));

const EXPANDED_TOOLS_CACHE_MAX = 4000;
const expandedToolsStateCache = new Map<string, Set<string>>();
const collapsedToolsStateCache = new Map<string, Set<string>>();

const BASH_TOOL_NAMES = new Set(['bash', 'shell', 'cmd', 'terminal']);
const EDIT_TOOL_NAMES = new Set([
    'apply_patch',
    'edit',
    'write',
    'multiedit',
    'str_replace',
    'str_replace_based_edit_tool',
    'create',
    'file_write',
]);

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';
    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (!withoutIndex.includes('.')) {
        return withoutIndex;
    }
    const parts = withoutIndex.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? withoutIndex;
};

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

const readCollapsedToolsCache = (messageId: string): Set<string> => {
    const cached = collapsedToolsStateCache.get(messageId);
    return cached ? new Set(cached) : new Set();
};

const writeCollapsedToolsCache = (messageId: string, value: Set<string>): void => {
    if (collapsedToolsStateCache.size >= EXPANDED_TOOLS_CACHE_MAX && !collapsedToolsStateCache.has(messageId)) {
        const oldest = collapsedToolsStateCache.keys().next().value;
        if (typeof oldest === 'string') {
            collapsedToolsStateCache.delete(oldest);
        }
    }
    collapsedToolsStateCache.set(messageId, new Set(value));
};

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
    assistantHeaderMessageId?: string;
    isInActiveTurn?: boolean;
    activeStreamingPhase?: StreamPhase | null;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({
    message,
    previousMessage,
    nextMessage,
    onContentChange,
    animationHandlers,
    turnGroupingContext,
    assistantHeaderMessageId,
    isInActiveTurn = false,
    activeStreamingPhase = null,
    animateUserOnMount = false,
    onUserAnimationConsumed,
}) => {
    const { isMobile, hasTouchInput } = useDeviceInfo();
    const { currentTheme } = useThemeSystem();
    const messageContainerRef = React.useRef<HTMLDivElement | null>(null);

    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);

    const getAgentModelForSession = useSelectionStore((s) => s.getAgentModelForSession);
    const getSessionModelSelection = useSelectionStore((s) => s.getSessionModelSelection);
    const revertToMessage = sessionActions.revertToMessage;
    const forkFromMessage = sessionActions.forkFromMessage;

    streamPerfCount('ui.chat_message.render');
    if (isInActiveTurn) {
        streamPerfCount('ui.chat_message.render.streaming');
    }

    const providers = useConfigStore.getState().providers;
    const { showReasoningTraces, stickyUserHeader, chatRenderMode, showExpandedBashTools, showExpandedEditTools } = useUIStore(
        useShallow((state) => ({
            showReasoningTraces: state.showReasoningTraces,
            stickyUserHeader: state.stickyUserHeader,
            chatRenderMode: state.chatRenderMode,
            showExpandedBashTools: state.showExpandedBashTools,
            showExpandedEditTools: state.showExpandedEditTools,
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
    const [collapsedTools, setCollapsedTools] = React.useState<Set<string>>(() => readCollapsedToolsCache(message.info.id));
    const [popupContent, setPopupContent] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });

    React.useEffect(() => {
        setExpandedTools(readExpandedToolsCache(message.info.id));
        setCollapsedTools(readCollapsedToolsCache(message.info.id));
    }, [message.info.id]);



    const messageRole = React.useMemo(() => deriveMessageRole(message.info), [message.info]);
    const isUser = messageRole.isUser;
    const useExternalUserActionsRow = isUser && (isMobile || !stickyUserHeader);
    const showStickyInlineHoverRow = isUser && !isMobile && stickyUserHeader && !useExternalUserActionsRow;

    const sessionId = message.info.sessionID;
    const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);

    // Keep non-active-turn rows detached from context-store churn.
    const { currentContextAgent, savedSessionAgentSelection } = useContextStore(
        useShallow((state) => ({
            currentContextAgent: isInActiveTurn && sessionId ? state.currentAgentContext.get(sessionId) : undefined,
            savedSessionAgentSelection: isInActiveTurn && sessionId ? state.sessionAgentSelections.get(sessionId) : undefined,
        }))
    );

    const normalizedParts = React.useMemo(() => {
        if (!isUser) {
            return message.parts;
        }

        return normalizeUserDisplayParts(message.parts, { planModeEnabled });
    }, [isUser, message.parts, planModeEnabled]);

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
        if (!planModeEnabled) return false;
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
    }, [isUser, planModeEnabled, previousMessage]);

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

        if (!isMessageCompleted && chatRenderMode === 'sorted') {
            return [];
        }

        return visibleParts;
    }, [chatRenderMode, isMessageCompleted, isUser, visibleParts]);


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

    const turnActivityToolParts = React.useMemo(() => {
        if (isUser) {
            return [] as Part[];
        }
        const records = turnGroupingContext?.activityParts ?? [];
        return records
            .filter((record) => record.kind === 'tool')
            .map((record) => record.part)
            .filter((part): part is Part => part.type === 'tool');
    }, [isUser, turnGroupingContext?.activityParts]);

    const defaultOpenToolIds = React.useMemo(() => {
        if (!showExpandedBashTools && !showExpandedEditTools) {
            return new Set<string>();
        }

        const next = new Set<string>();
        for (const part of [...toolParts, ...turnActivityToolParts]) {
            const toolId = typeof part?.id === 'string' ? part.id : '';
            if (!toolId) continue;
            const toolName = normalizeToolName((part as { tool?: string }).tool);
            if (!toolName) continue;

            if (showExpandedBashTools && BASH_TOOL_NAMES.has(toolName)) {
                next.add(toolId);
                continue;
            }
            if (showExpandedEditTools && EDIT_TOOL_NAMES.has(toolName)) {
                next.add(toolId);
            }
        }

        return next;
    }, [showExpandedBashTools, showExpandedEditTools, toolParts, turnActivityToolParts]);

    const effectiveExpandedTools = React.useMemo(() => {
        if (defaultOpenToolIds.size === 0 && collapsedTools.size === 0) {
            return expandedTools;
        }

        const next = new Set(expandedTools);
        defaultOpenToolIds.forEach((toolId) => {
            if (!collapsedTools.has(toolId)) {
                next.add(toolId);
            }
        });
        collapsedTools.forEach((toolId) => {
            next.delete(toolId);
        });
        return next;
    }, [collapsedTools, defaultOpenToolIds, expandedTools]);

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

    const nextRole = React.useMemo(() => {
        if (!nextMessage) return null;
        return deriveMessageRole(nextMessage.info);
    }, [nextMessage]);

    const hasTurnGrouping = Boolean(turnGroupingContext);
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;

    const isFollowedByAssistant = React.useMemo(() => {
        if (isUser) return false;
        if (hasTurnGrouping) {
            return !isLastAssistantInTurn;
        }
        if (!nextRole) return false;
        return !nextRole.isUser && nextRole.role === 'assistant';
    }, [hasTurnGrouping, isLastAssistantInTurn, isUser, nextRole]);

    const streamPhase: StreamPhase = React.useMemo(() => {
        if (isMessageCompleted) {
            return 'completed';
        }
        if (isInActiveTurn) {
            return activeStreamingPhase ?? 'streaming';
        }
        return 'completed';
    }, [activeStreamingPhase, isInActiveTurn, isMessageCompleted]);

    React.useEffect(() => {
        if (!isUser || !animateUserOnMount) {
            return;
        }
        onUserAnimationConsumed?.(message.info.id);
    }, [animateUserOnMount, isUser, message.info.id, onUserAnimationConsumed]);

    React.useEffect(() => {
        setHasStartedStreamingHeader(false);
    }, [message.info.id]);

    React.useEffect(() => {
        const headerMessageId = assistantHeaderMessageId ?? turnGroupingContext?.headerMessageId;
        if (isUser || !headerMessageId || headerMessageId !== message.info.id) {
            return;
        }

        const isCurrentlyStreaming = streamPhase === 'streaming' || streamPhase === 'cooldown';
        if (isCurrentlyStreaming) {
            setHasStartedStreamingHeader(true);
        }
    }, [assistantHeaderMessageId, isUser, message.info.id, streamPhase, turnGroupingContext?.headerMessageId]);

    const shouldShowHeader = React.useMemo(() => {
        if (isUser) return true;

        // Use turn grouping context if available for more precise control
        const headerMessageId = assistantHeaderMessageId ?? turnGroupingContext?.headerMessageId;
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

        // Ungrouped fallback path: always show assistant header.
        return true;
    }, [assistantHeaderMessageId, hasStartedStreamingHeader, isUser, turnGroupingContext, streamPhase, message.info.id]);

    const handleCopyCode = React.useCallback((code: string) => {
        void copyTextToClipboard(code).then((result) => {
            if (!result.ok) {
                return;
            }
            setCopiedCode(code);
            setTimeout(() => setCopiedCode(null), 2000);
        });
    }, []);

    const headerVariantRaw = !isUser ? (turnGroupingContext?.userMessageVariant ?? previousUserMetadata?.variant) : undefined;

    const headerVariant = !isUser && modelHasVariants ? (headerVariantRaw ?? 'Default') : undefined;

    // Summary body removed — flat rendering means text is always inline.

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

        return flattenAssistantTextParts(displayParts);
    }, [assistantErrorText, displayParts, isUser]);

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
        const isDefaultOpen = defaultOpenToolIds.has(toolId);
        const isCurrentlyExpanded = effectiveExpandedTools.has(toolId);

        if (isDefaultOpen) {
            setCollapsedTools((prev) => {
                const next = new Set(prev);
                if (isCurrentlyExpanded) {
                    next.add(toolId);
                } else {
                    next.delete(toolId);
                }
                writeCollapsedToolsCache(message.info.id, next);
                return next;
            });

            if (!isCurrentlyExpanded) {
                setExpandedTools((prev) => {
                    const next = new Set(prev);
                    next.delete(toolId);
                    writeExpandedToolsCache(message.info.id, next);
                    return next;
                });
            }
            return;
        }

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

        setCollapsedTools((prev) => {
            if (!prev.has(toolId)) {
                return prev;
            }
            const next = new Set(prev);
            next.delete(toolId);
            writeCollapsedToolsCache(message.info.id, next);
            return next;
        });
    }, [defaultOpenToolIds, effectiveExpandedTools, message.info.id]);

    const resolvedAnimationHandlers = animationHandlers ?? null;
    const hasAnnouncedAuxiliaryScrollRef = React.useRef(false);

    const animationCompletedRef = React.useRef(false);
    const hasRequestedReservationRef = React.useRef(false);
    const animationStartNotifiedRef = React.useRef(false);
    const hasTriggeredReservationOnceRef = React.useRef(false);
    const hasEverStreamedRef = React.useRef(false);

    React.useEffect(() => {
        animationCompletedRef.current = false;
        hasRequestedReservationRef.current = false;
        animationStartNotifiedRef.current = false;
        hasTriggeredReservationOnceRef.current = false;
        hasAnnouncedAuxiliaryScrollRef.current = false;
        hasEverStreamedRef.current = false;
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
    const isStreamingPhase = streamPhase === 'streaming' || streamPhase === 'cooldown';

    if (isStreamingPhase) {
        hasEverStreamedRef.current = true;
    }

    const hasReasoningParts = React.useMemo(() => {
        if (isUser) {
            return false;
        }
        return visibleParts.some((part) => part.type === 'reasoning');
    }, [isUser, visibleParts]);

    const allowAnimation = shouldAnimateMessage && !isAnimationSettled && !isStreamingPhase && !hasEverStreamedRef.current;
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

    const assistantTopPaddingClass = !isUser && shouldShowHeader
        ? (stickyUserHeader ? (isMobile ? 'pt-4' : 'pt-6') : 'pt-0')
        : 'pt-0';
    const userMessageRadius = 'var(--radius-xl)';

    return (
        <>
            <div
                className={cn(
                    'group w-full',
                    isUser ? (isMobile ? 'pt-2' : 'pt-6') : assistantTopPaddingClass,
                    isUser ? 'pb-0' : isFollowedByAssistant ? 'pb-0' : 'pb-8'
                )}
                id={`message-${message.info.id}`}
                data-message-id={message.info.id}
                ref={messageContainerRef}
            >
                <div className="chat-message-column relative">
                    {isUser ? (
                        displayParts.length === 0 ? null : (
                            <FadeInOnReveal
                                forceAnimation
                                skipAnimation={!animateUserOnMount}
                                ignoreContextDisabled
                                respectReducedMotion
                            >
                                <div className={cn('relative flex justify-end', !isMobile ? 'group/user-shell' : undefined)}>
                                    <div className={cn('max-w-[85%]', showStickyInlineHoverRow ? 'pb-5' : undefined)}>
                                        <div
                                            style={{
                                                backgroundColor: 'var(--chat-user-message-bg)',
                                                borderRadius: userMessageRadius,
                                                borderBottomRightRadius: 'var(--radius-sm)',
                                            }}
                                            className="px-5 py-3 shadow-none border border-primary/5"
                                        >
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
                                                userActionsMode={useExternalUserActionsRow ? 'external-content' : 'inline'}
                                                stickyUserHeaderEnabled={stickyUserHeader}
                                            />
                                        </div>
                                        {useExternalUserActionsRow ? (
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
                                                userActionsMode="external-actions"
                                                stickyUserHeaderEnabled={stickyUserHeader}
                                            />
                                        ) : null}
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
                                sessionId={message.info.sessionID}
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

export default React.memo(ChatMessage, (prev, next) => {
    return areRenderRelevantMessagesEqual(
        { info: prev.message.info, parts: prev.message.parts },
        { info: next.message.info, parts: next.message.parts }
    )
        && areOptionalRenderRelevantMessagesEqual(
            prev.previousMessage ? { info: prev.previousMessage.info, parts: prev.previousMessage.parts } : undefined,
            next.previousMessage ? { info: next.previousMessage.info, parts: next.previousMessage.parts } : undefined
        )
        && areOptionalRenderRelevantMessagesEqual(
            prev.nextMessage ? { info: prev.nextMessage.info, parts: prev.nextMessage.parts } : undefined,
            next.nextMessage ? { info: next.nextMessage.info, parts: next.nextMessage.parts } : undefined
        )
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && areRelevantTurnGroupingContextsEqual(
            prev.turnGroupingContext,
            next.turnGroupingContext,
            prev.message.info.id,
            deriveMessageRole(prev.message.info).isUser
        );
});
