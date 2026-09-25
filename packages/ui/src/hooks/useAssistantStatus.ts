import React from 'react';
import { useChatColumnSession } from '@/components/chat/chatColumnSession';
import type { Message, ModelRef, Part, ReasoningPart, TextPart, ToolPart } from '@/lib/opencode/model';
import { executeToolCalls, isExecuteTool } from '@/lib/opencode/tools';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSession, useSessionMessages, useSessionPermissions, useSessionForms, useSessionStatus } from '@/sync/sync-context';
import { useCurrentSessionActivity } from './useSessionActivity';

type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

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
    activeModel: ActiveAssistantModel | null;
    forming: FormingSummary;
    working: WorkingSummary;
}

interface ActiveAssistantModel {
    providerId: string;
    modelId: string;
}

interface ActiveAssistantContext {
    assistantId: string | null;
    model: ActiveAssistantModel | null;
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

const EMPTY_PARTS: Part[] = [];
const STATUS_SIGNATURE_SEPARATOR = '\u0000';
const EDITING_TOOLS = new Set(['edit', 'write', 'patch']);
// v2 tool names. `shell` replaced `bash`, `subagent` replaced `task`, and
// `todowrite`/`todoread`/`list`/`lsp` are gone.
const TOOL_STATUS_PHRASES = new Map(Object.entries({
    read: 'reading file',
    write: 'writing file',
    edit: 'editing file',
    patch: 'applying patch',
    'file-diff': 'reading changes',
    shell: 'running command',
    execute: 'running a script',
    grep: 'searching content',
    glob: 'finding files',
    subagent: 'delegating task',
    webfetch: 'fetching URL',
    websearch: 'searching web',
    codesearch: 'web code search',
    skill: 'learning skill',
    question: 'asking question',
}));
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

type ParsedStatusResult = {
    activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
    activeToolName: string | undefined;
    statusText: string;
    isGenericStatus: boolean;
};

const getToolStatusPhrase = (toolName: string): string => {
    return TOOL_STATUS_PHRASES.get(toolName) ?? `using ${toolName}`;
};

/**
 * A running `execute` (Code Mode) script names the tool it is calling as soon
 * as its metadata lists one, so the pill tracks the script's real work instead
 * of sitting on a generic phrase for its whole run.
 */
const getRunningToolPhrase = (part: ToolPart, toolName: string): string => {
    if (!isExecuteTool(toolName)) {
        return getToolStatusPhrase(toolName);
    }
    const state = part.state;
    const calls = executeToolCalls(state && 'metadata' in state ? state.metadata : undefined);
    const last = calls[calls.length - 1];
    return last ? `calling ${last.tool}` : getToolStatusPhrase(toolName);
};

const hashString = (value: string): number => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
};

const getStableWorkingPhrase = (key: string): string => {
    return WORKING_PHRASES[hashString(key) % WORKING_PHRASES.length] ?? 'working';
};

const createParsedStatus = (parts: Part[], genericKey: string): ParsedStatusResult => {
    let activePartType: ParsedStatusResult['activePartType'] = undefined;
    let activeToolName: string | undefined = undefined;
    let activeToolPhrase: string | undefined = undefined;

    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
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
                    if (EDITING_TOOLS.has(toolName)) {
                        activePartType = 'editing';
                        activeToolName = toolName;
                    } else {
                        activePartType = 'tool';
                        activeToolName = toolName;
                        activeToolPhrase = getRunningToolPhrase(part, toolName);
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
        if (activePartType === 'editing') return activeToolName === 'multiedit' ? getToolStatusPhrase(activeToolName) : 'editing file';
        if (activePartType === 'tool' && activeToolName) return activeToolPhrase ?? getToolStatusPhrase(activeToolName);
        if (activePartType === 'reasoning') return 'thinking';
        if (activePartType === 'text') return 'composing';
        return getStableWorkingPhrase(genericKey);
    })();

    return { activePartType, activeToolName, statusText, isGenericStatus };
};

const encodeParsedStatus = (status: ParsedStatusResult): string => {
    return [
        status.activePartType ?? '',
        status.activeToolName ?? '',
        status.statusText,
        status.isGenericStatus ? '1' : '0',
    ].join(STATUS_SIGNATURE_SEPARATOR);
};

const decodeParsedStatus = (signature: string): ParsedStatusResult => {
    const [activePartType, activeToolName, statusText = 'working', isGenericStatus] = signature.split(STATUS_SIGNATURE_SEPARATOR);
    return {
        activePartType: activePartType === 'text' || activePartType === 'tool' || activePartType === 'reasoning' || activePartType === 'editing'
            ? activePartType
            : undefined,
        activeToolName: activeToolName || undefined,
        statusText,
        isGenericStatus: isGenericStatus === '1',
    };
};

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

/** True when a user prompt follows `index`, i.e. a turn is queued or starting. */
const hasNewerPrompt = (messages: Message[], index: number): boolean => {
    for (let cursor = messages.length - 1; cursor > index; cursor -= 1) {
        if (messages[cursor]?.role === 'user') return true;
    }
    return false;
};

/**
 * `sessionModel` is the session record's own model: in OpenCode v2 a send
 * switches the session before the prompt goes out, so it names what the next
 * turn runs on before any assistant record exists.
 */
export const getActiveAssistantContext = (messages: Message[], sessionModel?: ModelRef | null): ActiveAssistantContext => {
    const sessionProviderId = sessionModel?.providerID.trim() ?? '';
    const sessionModelId = sessionModel?.id.trim() ?? '';
    const nextTurnModel = sessionProviderId && sessionModelId ? { providerId: sessionProviderId, modelId: sessionModelId } : null;
    // OpenCode v2 records the provider and model on the assistant message
    // itself, so the active model no longer has to be looked up on the user
    // message that triggered the turn (which no longer links back to it).
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;

        // A prompt newer than this answer starts a turn this answer's model
        // says nothing about: a v2 user message carries no model, and the
        // composer may have switched models since. The session record already
        // holds the switched model (the send switches before it prompts), so it
        // is the one shown; without it nothing is shown rather than the previous
        // turn's. A turn still running keeps its model: the newer prompt is only
        // queued behind it.
        if (message.time.completed !== undefined && hasNewerPrompt(messages, index)) {
            return { assistantId: message.id, model: nextTurnModel };
        }

        const providerId = message.providerID.trim();
        const modelId = message.modelID.trim();
        return {
            assistantId: message.id,
            model: providerId && modelId ? { providerId, modelId } : null,
        };
    }

    return { assistantId: null, model: null };
};

export function useAssistantStatus(): AssistantStatusSnapshot {
    // Inside the chat column, follow the session the timeline shows rather
    // than the live selection, so the status chip changes together with the
    // conversation instead of a commit ahead of it.
    const chatColumnSession = useChatColumnSession();
    const liveSessionId = useSessionUIStore((state) => state.currentSessionId);
    const liveSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    const currentSessionDirectory = chatColumnSession ? chatColumnSession.directory : liveSessionDirectory;

    const rawSessionMessages = useSessionMessages(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );

    const sessionModel = useSession(currentSessionId ?? undefined, currentSessionDirectory ?? undefined)?.model ?? null;
    const activeAssistant = React.useMemo(
        () => getActiveAssistantContext(rawSessionMessages, sessionModel),
        [rawSessionMessages, sessionModel],
    );
    const lastAssistantId = activeAssistant.assistantId;

    const lastAssistantStatusSignature = useDirectorySync(
        React.useCallback((state) => {
            const genericKey = `${currentSessionId ?? ''}:${lastAssistantId ?? ''}`;
            const parts = lastAssistantId ? (state.part[lastAssistantId] ?? EMPTY_PARTS) : EMPTY_PARTS;
            return encodeParsedStatus(createParsedStatus(parts, genericKey));
        }, [currentSessionId, lastAssistantId]),
        currentSessionDirectory ?? undefined,
    );

    const sessionPermissionRequests = useSessionPermissions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const sessionFormRequests = useSessionForms(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionAbortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId])
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useCurrentSessionActivity();

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        return decodeParsedStatus(lastAssistantStatusSignature);
    }, [lastAssistantStatusSignature]);

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
        return { isActive, characterCount: 0 };
    }, [isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingForm = sessionFormRequests.length > 0;

        if (!hasPendingPermission && !hasPendingForm) {
            return baseWorking;
        }

        if (hasPendingForm) {
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
    }, [baseWorking, sessionPermissionRequests, sessionFormRequests]);

    return {
        activeModel: activeAssistant.model,
        forming,
        working,
    };
}
