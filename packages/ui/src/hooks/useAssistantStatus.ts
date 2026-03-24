import React from 'react';
import type { AssistantMessage, Message, Part, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk/v2';
import { useShallow } from 'zustand/react/shallow';

import i18n from '@/i18n';
import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionStore } from '@/stores/useSessionStore';
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

// 使用稳定的 i18n key 生成工具运行状态，避免界面中出现硬编码英文。
const getToolStatusPhrase = (toolName: string): string => {
    const TOOL_STATUS_KEYS: Record<string, string> = {
        read: 'assistantStatus.toolStatus.read',
        write: 'assistantStatus.toolStatus.write',
        edit: 'assistantStatus.toolStatus.edit',
        multiedit: 'assistantStatus.toolStatus.multiedit',
        apply_patch: 'assistantStatus.toolStatus.applyPatch',
        bash: 'assistantStatus.toolStatus.bash',
        grep: 'assistantStatus.toolStatus.grep',
        glob: 'assistantStatus.toolStatus.glob',
        list: 'assistantStatus.toolStatus.list',
        task: 'assistantStatus.toolStatus.task',
        webfetch: 'assistantStatus.toolStatus.webfetch',
        websearch: 'assistantStatus.toolStatus.websearch',
        codesearch: 'assistantStatus.toolStatus.codesearch',
        todowrite: 'assistantStatus.toolStatus.todowrite',
        todoread: 'assistantStatus.toolStatus.todoread',
        skill: 'assistantStatus.toolStatus.skill',
        question: 'assistantStatus.toolStatus.question',
        plan_enter: 'assistantStatus.toolStatus.planEnter',
        plan_exit: 'assistantStatus.toolStatus.planExit',
    };

    const key = TOOL_STATUS_KEYS[toolName];
    return key ? i18n.t(key) : i18n.t('assistantStatus.toolStatus.usingTool', { toolName });
};

// 兜底工作状态文案同样走 i18n，保持随机占位文本可随语言切换。
const getRandomWorkingPhrase = (): string => {
    const workingPhrases = [
        'assistantStatus.workingPhrases.working',
        'assistantStatus.workingPhrases.processing',
        'assistantStatus.workingPhrases.preparing',
        'assistantStatus.workingPhrases.warmingUp',
        'assistantStatus.workingPhrases.gearsTurning',
        'assistantStatus.workingPhrases.computing',
        'assistantStatus.workingPhrases.calculating',
        'assistantStatus.workingPhrases.analyzing',
        'assistantStatus.workingPhrases.wheelsSpinning',
        'assistantStatus.workingPhrases.calibrating',
        'assistantStatus.workingPhrases.synthesizing',
        'assistantStatus.workingPhrases.connectingDots',
        'assistantStatus.workingPhrases.inspectingLogic',
        'assistantStatus.workingPhrases.weighingOptions',
    ];

    return i18n.t(workingPhrases[Math.floor(Math.random() * workingPhrases.length)]);
};

export function useAssistantStatus(): AssistantStatusSnapshot {
    const { currentSessionId, messages, permissions, sessionAbortFlags } = useSessionStore(
        useShallow((state) => ({
            currentSessionId: state.currentSessionId,
            messages: state.messages,
            permissions: state.permissions,
            sessionAbortFlags: state.sessionAbortFlags,
        }))
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useCurrentSessionActivity();

    const sessionRetryAttempt = useSessionStore((state) => {
        if (!currentSessionId || !state.sessionStatus) return undefined;
        const s = state.sessionStatus.get(currentSessionId);
        return s?.type === 'retry' ? s.attempt : undefined;
    });

    const sessionRetryNext = useSessionStore((state) => {
        if (!currentSessionId || !state.sessionStatus) return undefined;
        const s = state.sessionStatus.get(currentSessionId);
        return s?.type === 'retry' ? s.next : undefined;
    });

    const sessionMessages = React.useMemo<Array<{ info: Message; parts: Part[] }>>(() => {
        if (!currentSessionId) {
            return [];
        }
        const records = messages.get(currentSessionId) ?? [];
        return records as Array<{ info: Message; parts: Part[] }>;
    }, [currentSessionId, messages]);

    type ParsedStatusResult = {
        activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
        activeToolName: string | undefined;
        statusText: string;
        isGenericStatus: boolean;
    };

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        if (sessionMessages.length === 0) {
            return { activePartType: undefined, activeToolName: undefined, statusText: i18n.t('assistantStatus.status.working'), isGenericStatus: true };
        }

        const assistantMessages = sessionMessages
            .filter(
                (msg): msg is AssistantSessionMessageRecord =>
                    isAssistantMessage(msg.info) && !isFullySyntheticMessage(msg.parts)
            );

        if (assistantMessages.length === 0) {
            return { activePartType: undefined, activeToolName: undefined, statusText: i18n.t('assistantStatus.status.working'), isGenericStatus: true };
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

        const editingTools = new Set(['edit', 'write', 'apply_patch']);

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

        const isGenericStatus = activePartType === undefined;
        const statusText = (() => {
            if (activePartType === 'editing') return i18n.t('assistantStatus.status.editingFile');
            if (activePartType === 'tool' && activeToolName) return getToolStatusPhrase(activeToolName);
            if (activePartType === 'reasoning') return i18n.t('assistantStatus.status.thinking');
            if (activePartType === 'text') return i18n.t('assistantStatus.status.composing');
            return getRandomWorkingPhrase();
        })();

        return { activePartType, activeToolName, statusText, isGenericStatus };
    }, [sessionMessages]);

    const abortState = React.useMemo(() => {
        const sessionId = currentSessionId;
        const abortRecord = sessionId ? sessionAbortFlags?.get(sessionId) ?? null : null;
        const hasActiveAbort = Boolean(abortRecord && !abortRecord.acknowledged);
        return { wasAborted: hasActiveAbort, abortActive: hasActiveAbort };
    }, [currentSessionId, sessionAbortFlags]);

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

        const sessionId = currentSessionId;
        const permissionList = sessionId ? permissions?.get(sessionId) ?? [] : [];
        const hasPendingPermission = permissionList.length > 0;

        if (!hasPendingPermission) {
            return baseWorking;
        }

        return {
            ...baseWorking,
            statusText: i18n.t('assistantStatus.status.waitingForPermission'),
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
        };
    }, [currentSessionId, permissions, baseWorking]);

    return {
        forming,
        working,
    };
}
