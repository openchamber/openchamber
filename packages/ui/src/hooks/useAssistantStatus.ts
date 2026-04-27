import React from 'react';
import type { AssistantMessage } from '@opencode-ai/sdk/v2';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionPermissions, useSessionQuestions, useSessionStatus } from '@/sync/sync-context';
import {
    getCompatibleMessageCreatedAt,
    getCompatibleMessageId,
    getCompatibleMessageRole,
    getCompatiblePartEndedAt,
    getCompatiblePartKind,
    getCompatiblePartText,
    getCompatibleToolName,
    getCompatibleToolStatus,
    getOpenCodeCompatibleMessages,
    getOpenCodeCompatibleParts,
    type SyncMessageRecord,
    type SyncPartRecord,
} from '@/sync/compat';
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
    parts: SyncPartRecord[];
}

type SessionMessageRecord = {
    info: SyncMessageRecord;
    parts: SyncPartRecord[];
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

import { EMPTY_MESSAGES, EMPTY_PARTS, emptyArray } from '@/constants/empty';
const EMPTY_SESSION_MESSAGES: SessionMessageRecord[] = emptyArray<SessionMessageRecord>() as SessionMessageRecord[];
const isAssistantMessage = (message: SyncMessageRecord): message is SyncMessageRecord & AssistantMessageWithState => getCompatibleMessageRole(message) === 'assistant';

export function useAssistantStatus(): AssistantStatusSnapshot {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

    const rawSessionMessages = useDirectorySync(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return EMPTY_MESSAGES;
            }
            return getOpenCodeCompatibleMessages(state, currentSessionId);
        }, [currentSessionId])
    );

    // Only subscribe to parts for the last assistant message — avoids re-render
    // on every part delta for earlier messages.
    const lastAssistantId = React.useMemo(() => {
        for (let i = rawSessionMessages.length - 1; i >= 0; i--) {
            if (getCompatibleMessageRole(rawSessionMessages[i]) === 'assistant') return getCompatibleMessageId(rawSessionMessages[i]);
        }
        return null;
    }, [rawSessionMessages]);

    const lastAssistantParts = useDirectorySync(
        React.useCallback((state) => {
            if (!lastAssistantId) return EMPTY_PARTS;
            return getOpenCodeCompatibleParts(state, lastAssistantId);
        }, [lastAssistantId])
    );

    const sessionMessages = React.useMemo<SessionMessageRecord[]>(
        () => {
            if (rawSessionMessages.length === 0) {
                return EMPTY_SESSION_MESSAGES;
            }
            return rawSessionMessages.map((msg) => ({
                info: msg,
                parts: getCompatibleMessageId(msg) === lastAssistantId ? lastAssistantParts : EMPTY_PARTS,
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
            const aCreated = getCompatibleMessageCreatedAt(a.info);
            const bCreated = getCompatibleMessageCreatedAt(b.info);

            if (aCreated !== null && bCreated !== null && aCreated !== bCreated) {
                return aCreated - bCreated;
            }

            return getCompatibleMessageId(a.info).localeCompare(getCompatibleMessageId(b.info));
        });

        const lastAssistant = sortedAssistantMessages[sortedAssistantMessages.length - 1];

        let activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined = undefined;
        let activeToolName: string | undefined = undefined;

        const editingTools = new Set(['edit', 'write', 'apply_patch']);

        for (let i = (lastAssistant.parts ?? []).length - 1; i >= 0; i -= 1) {
            const part = lastAssistant.parts?.[i];
            if (!part) continue;

            switch (getCompatiblePartKind(part)) {
                case 'reasoning': {
                    const stillRunning = typeof getCompatiblePartEndedAt(part) === 'undefined';
                    if (stillRunning && !activePartType) {
                        activePartType = 'reasoning';
                    }
                    break;
                }
                case 'tool': {
                    const toolStatus = getCompatibleToolStatus(part);
                    if ((toolStatus === 'running' || toolStatus === 'pending') && !activePartType) {
                        const toolName = getCompatibleToolName(part);
                        if (editingTools.has(toolName)) {
                            activePartType = 'editing';
                        } else {
                            activePartType = 'tool';
                            activeToolName = toolName;
                        }
                    }
                    break;
                }
                case 'text': {
                    const rawContent = getCompatiblePartText(part) ?? '';
                    if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                        const streamingPart = typeof getCompatiblePartEndedAt(part) === 'undefined';
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
            if (activePartType === 'editing') return 'editing file';
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
            if (getCompatiblePartKind(part) !== 'text') return;
            const rawContent = getCompatiblePartText(part) ?? '';
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
