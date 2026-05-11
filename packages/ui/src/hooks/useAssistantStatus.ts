import React from 'react';
import type { AssistantMessage, Message, Part, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk/v2';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionPermissions, useSessionQuestions, useSessionStatus } from '@/sync/sync-context';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { useCurrentSessionActivity } from './useSessionActivity';

export type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

interface WorkingSummary {
    activity: AssistantActivity;
    hasWorkingContext: boolean;
    hasActiveTools: boolean;
    isWorking: boolean;
    isStreaming: boolean;
    isCooldown: boolean;
    lifecyclePhase: MessageStreamPhase | null;
    statusText: string | null;
    isGenericStatus: boolean;
    isWaitingForPermission: boolean;
    canAbort: boolean;
    compactionDeadline: number | null;
    activePartType?: 'text' | 'tool' | 'reasoning' | 'editing';
    activeToolName?: string;
    wasAborted: boolean;
    abortActive: boolean;
    lastCompletionId: string | null;
    isComplete: boolean;
    retryInfo: { attempt?: number; next?: number } | null;
}

interface FormingSummary {
    isActive: boolean;
    characterCount: number;
}

export interface AssistantStatusSnapshot {
    forming: FormingSummary;
    working: WorkingSummary;
}

type AssistantMessageWithState = AssistantMessage & {
    status?: string;
    streaming?: boolean;
    abortedAt?: number;
};

interface AssistantSessionMessageRecord {
    info: AssistantMessageWithState;
    parts: Part[];
}

type SessionMessageRecord = {
    info: Message;
    parts: Part[];
};

const DEFAULT_WORKING: WorkingSummary = {
    activity: 'idle',
    hasWorkingContext: false,
    hasActiveTools: false,
    isWorking: false,
    isStreaming: false,
    isCooldown: false,
    lifecyclePhase: null,
    statusText: null,
    isGenericStatus: true,
    isWaitingForPermission: false,
    canAbort: false,
    compactionDeadline: null,
    activePartType: undefined,
    activeToolName: undefined,
    wasAborted: false,
    abortActive: false,
    lastCompletionId: null,
    isComplete: false,
    retryInfo: null,
};

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PARTS: Part[] = [];
const EMPTY_SESSION_MESSAGES: SessionMessageRecord[] = [];
const isAssistantMessage = (message: Message): message is AssistantMessageWithState => message.role === 'assistant';

const isReasoningPart = (part: Part): part is ReasoningPart => part.type === 'reasoning';

const isTextPart = (part: Part): part is TextPart => part.type === 'text';

const getLegacyTextContent = (part: Part): string | undefined => {
    if (isTextPart(part)) {
        return part.text;
    }
    const candidate = part as Partial<{ text?: unknown; content?: unknown; value?: unknown }>;
    if (typeof candidate.text === 'string') {
        return candidate.text;
    }
    if (typeof candidate.content === 'string') {
        return candidate.content;
    }
    if (typeof candidate.value === 'string') {
        return candidate.value;
    }
    return undefined;
};

const getPartTimeInfo = (part: Part): { end?: number } | undefined => {
    if (isTextPart(part) || isReasoningPart(part)) {
        return part.time;
    }
    const candidate = part as Partial<{ time?: { end?: number } }>;
    return candidate.time;
};

const getToolDisplayName = (part: ToolPart): string => {
    if (part.tool) {
        return part.tool;
    }
    const candidate = part as ToolPart & Partial<{ name?: unknown }>;
    return typeof candidate.name === 'string' ? candidate.name : 'tool';
};

export function useAssistantStatus(): AssistantStatusSnapshot {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

    const rawSessionMessages = useDirectorySync(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return EMPTY_MESSAGES;
            }
            return state.message[currentSessionId] ?? EMPTY_MESSAGES;
        }, [currentSessionId])
    );

    // Only subscribe to parts for the last assistant message — avoids re-render
    // on every part delta for earlier messages.
    const lastAssistantId = React.useMemo(() => {
        for (let i = rawSessionMessages.length - 1; i >= 0; i--) {
            if (rawSessionMessages[i].role === 'assistant') return rawSessionMessages[i].id;
        }
        return null;
    }, [rawSessionMessages]);

    const lastAssistantParts = useDirectorySync(
        React.useCallback((state) => {
            if (!lastAssistantId) return EMPTY_PARTS;
            return state.part[lastAssistantId] ?? EMPTY_PARTS;
        }, [lastAssistantId])
    );

    const sessionMessages = React.useMemo<SessionMessageRecord[]>(
        () => {
            if (rawSessionMessages.length === 0) {
                return EMPTY_SESSION_MESSAGES;
            }
            return rawSessionMessages.map((msg) => ({
                info: msg,
                parts: msg.id === lastAssistantId ? lastAssistantParts : EMPTY_PARTS,
            }));
        },
        [lastAssistantParts, rawSessionMessages, lastAssistantId]
    );

    const sessionPermissionRequests = useSessionPermissions(currentSessionId ?? '');
    const sessionQuestionRequests = useSessionQuestions(currentSessionId ?? '');

    const sessionAbortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId])
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useCurrentSessionActivity();

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '');

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    type ParsedStatusResult = {
        activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
        activeToolName: string | undefined;
        statusText: string;
        isGenericStatus: boolean;
    };

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        if (sessionMessages.length === 0) {
            return { activePartType: undefined, activeToolName: undefined, statusText: 'working', isGenericStatus: true };
        }

        const assistantMessages = sessionMessages
            .filter(
                (msg): msg is AssistantSessionMessageRecord =>
                    isAssistantMessage(msg.info) && !isFullySyntheticMessage(msg.parts)
            );

        if (assistantMessages.length === 0) {
            return { activePartType: undefined, activeToolName: undefined, statusText: 'working', isGenericStatus: true };
        }

        const sortedAssistantMessages = [...assistantMessages].sort((a, b) => {
            const aCreated = typeof a.info.time?.created === 'number' ? a.info.time.created : null;
            const bCreated = typeof b.info.time?.created === 'number' ? b.info.time.created : null;

            if (aCreated !== null && bCreated !== null && aCreated !== bCreated) {
                return aCreated - bCreated;
            }

            return a.info.id.localeCompare(b.info.id);
        });

        const lastAssistant = sortedAssistantMessages[sortedAssistantMessages.length - 1];

        let activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined = undefined;
        let activeToolName: string | undefined = undefined;

        const editingTools = new Set(['edit', 'write', 'multiedit', 'apply_patch']);

        for (let i = (lastAssistant.parts ?? []).length - 1; i >= 0; i -= 1) {
            const part = lastAssistant.parts?.[i];
            if (!part) continue;

            switch (part.type) {
                case 'reasoning': {
                    const time = part.time ?? getPartTimeInfo(part);
                    const stillRunning = !time || typeof time.end === 'undefined';
                    if (stillRunning && !activePartType) {
                        activePartType = 'reasoning';
                    }
                    break;
                }
                case 'tool': {
                    const toolStatus = part.state?.status;
                    if ((toolStatus === 'running' || toolStatus === 'pending') && !activePartType) {
                        const toolName = getToolDisplayName(part);
                        if (editingTools.has(toolName)) {
                            activePartType = 'editing';
                            activeToolName = toolName;
                        } else {
                            activePartType = 'tool';
                            activeToolName = toolName;
                        }
                    }
                    break;
                }
                case 'text': {
                    const rawContent = getLegacyTextContent(part) ?? '';
                    if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                        const time = getPartTimeInfo(part);
                        const streamingPart = !time || typeof time.end === 'undefined';
                        if (streamingPart && !activePartType) {
                            activePartType = 'text';
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        }

        const TOOL_STATUS_PHRASES: Record<string, string> = {
            read: 'reading file',
            write: 'writing file',
            edit: 'editing file',
            multiedit: 'editing files',
            apply_patch: 'applying patch',
            bash: 'running command',
            grep: 'searching content',
            glob: 'finding files',
            list: 'listing directory',
            task: 'delegating task',
            webfetch: 'fetching URL',
            websearch: 'searching web',
            codesearch: 'web code search',
            todowrite: 'updating todos',
            todoread: 'reading todos',
            skill: 'learning skill',
            question: 'asking question',
            plan_enter: 'switching to planning',
            plan_exit: 'switching to building',
        };

        const WORKING_PHRASES = [
            'working',
            'processing',
            'preparing',
            'warming up',
            'gears turning',
            'computing',
            'calculating',
            'analyzing',
            'wheels spinning',
            'calibrating',
            'synthesizing',
            'connecting dots',
            'inspecting logic',
            'weighing options',
        ];

        const getToolStatusPhrase = (toolName: string): string => {
            return TOOL_STATUS_PHRASES[toolName] ?? `using ${toolName}`;
        };

        const getRandomWorkingPhrase = (): string => {
            return WORKING_PHRASES[Math.floor(Math.random() * WORKING_PHRASES.length)];
        };

        const isGenericStatus = activePartType === undefined;
        const statusText = (() => {
            if (activePartType === 'editing') return activeToolName === 'multiedit' ? getToolStatusPhrase(activeToolName) : 'editing file';
            if (activePartType === 'tool' && activeToolName) return getToolStatusPhrase(activeToolName);
            if (activePartType === 'reasoning') return 'thinking';
            if (activePartType === 'text') return 'composing';
            return getRandomWorkingPhrase();
        })();

        return { activePartType, activeToolName, statusText, isGenericStatus };
    }, [sessionMessages]);

    const abortState = React.useMemo(() => {
        const hasActiveAbort = Boolean(sessionAbortRecord && !sessionAbortRecord.acknowledged);
        return { wasAborted: hasActiveAbort, abortActive: hasActiveAbort };
    }, [sessionAbortRecord]);

    const baseWorking = React.useMemo<WorkingSummary>(() => {

        if (abortState.wasAborted) {
            return {
                ...DEFAULT_WORKING,
                wasAborted: true,
                abortActive: abortState.abortActive,
                activity: 'idle',
                hasWorkingContext: false,
                isWorking: false,
                isStreaming: false,
                isCooldown: false,
                statusText: null,
                canAbort: false,
                retryInfo: null,
            };
        }

        const isWorking = isPhaseWorking;
        const isStreaming = activityPhase === 'busy';
        const isCooldown = false;
        const isRetry = activityPhase === 'retry';

        let activity: AssistantActivity = 'idle';
        if (isWorking) {
            if (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing') {
                activity = 'tooling';
            } else {
                activity = isCooldown ? 'cooldown' : 'streaming';
            }
        }

        const retryInfo = isRetry
            ? { attempt: sessionRetryAttempt, next: sessionRetryNext }
            : null;

        return {
            activity,
            hasWorkingContext: isWorking,
            hasActiveTools: parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing',
            isWorking,
            isStreaming,
            isCooldown,
            lifecyclePhase: isStreaming ? 'streaming' : isCooldown ? 'cooldown' : null,
            statusText: isWorking ? parsedStatus.statusText : null,
            isGenericStatus: isWorking ? parsedStatus.isGenericStatus : true,
            isWaitingForPermission: false,
            canAbort: isWorking,
            compactionDeadline: null,
            activePartType: isWorking ? parsedStatus.activePartType : undefined,
            activeToolName: isWorking ? parsedStatus.activeToolName : undefined,
            wasAborted: false,
            abortActive: false,
            lastCompletionId: null,
            isComplete: false,
            retryInfo,
        };
    }, [activityPhase, isPhaseWorking, parsedStatus, abortState, sessionRetryAttempt, sessionRetryNext]);

    const forming = React.useMemo<FormingSummary>(() => {

        const isActive = isPhaseWorking && parsedStatus.activePartType === 'text';

        if (!isActive || sessionMessages.length === 0) {
            return { isActive, characterCount: 0 };
        }

        const assistantMessages = sessionMessages.filter(
            (msg): msg is AssistantSessionMessageRecord =>
                isAssistantMessage(msg.info) && !isFullySyntheticMessage(msg.parts)
        );

        if (assistantMessages.length === 0) {
            return { isActive, characterCount: 0 };
        }

        const lastAssistant = assistantMessages[assistantMessages.length - 1];
        let characterCount = 0;

        (lastAssistant.parts ?? []).forEach((part) => {
            if (part.type !== 'text') return;
            const rawContent = getLegacyTextContent(part) ?? '';
            if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                characterCount += rawContent.length;
            }
        });

        return { isActive, characterCount };
    }, [sessionMessages, isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingQuestion = sessionQuestionRequests.length > 0;

        if (!hasPendingPermission && !hasPendingQuestion) {
            return baseWorking;
        }

        if (hasPendingQuestion) {
            return {
                ...baseWorking,
                statusText: null,
                isWorking: false,
                hasWorkingContext: false,
                hasActiveTools: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                retryInfo: null,
            };
        }

        return {
            ...baseWorking,
            statusText: 'waiting for permission',
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
        };
    }, [baseWorking, sessionPermissionRequests, sessionQuestionRequests]);

    return {
        forming,
        working,
    };
}
