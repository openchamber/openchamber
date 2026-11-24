import React from 'react';
import { z } from 'zod';
import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import type { JsonValue, Message, ModelRef, Part, ReasoningPart, StructuredError, TextPart, ToolPart } from '@/lib/opencode/model';
import {
    executeHasBackgroundableWork,
    isExecuteTool,
    isShellTool,
    isSubagentTool,
    lastExecuteToolCall,
    mcpToolServer,
    opencodeNamespaceTool,
    openChamberToolCall,
} from '@/lib/opencode/tools';
import type { OpenChamberToolCall } from '@/lib/opencode/tools';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { selectMcpServersForDirectory, useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formTurnHold, useRecoverableQuestionsStore } from '@/sync/recoverable-questions';
import { useDirectorySync, useSession, useSessionMessages, useSessionPermissions, useSessionStatus } from '@/sync/sync-context';
import { useSessionActivity } from './useSessionActivity';
import type { AgentStatus } from '@/lib/agentStatus';
import type { I18nKey } from '@/lib/i18n';

type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

interface WorkingSummary {
    activity: AssistantActivity;
    hasWorkingContext: boolean;
    hasActiveTools: boolean;
    isWorking: boolean;
    isStreaming: boolean;
    isCooldown: boolean;
    lifecyclePhase: MessageStreamPhase | null;
    status: AgentStatus | null;
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
    retryInfo: { attempt?: number; next?: number; resetsAt?: number } | null;
    canBackground: boolean;
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
    status: null,
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
    canBackground: false,
};

const EMPTY_PARTS: Part[] = [];
const STATUS_SIGNATURE_SEPARATOR = '\u0000';

type ToolBucket = 'read' | 'search' | 'edit' | 'command' | 'lookup' | 'delegate' | 'question' | 'skill';

const TOOL_BUCKETS = new Map<string, ToolBucket>(Object.entries({
    read: 'read',
    'file-diff': 'read',
    grep: 'search',
    glob: 'search',
    edit: 'edit',
    write: 'edit',
    patch: 'edit',
    shell: 'command',
    execute: 'command',
    webfetch: 'lookup',
    websearch: 'lookup',
    codesearch: 'lookup',
    subagent: 'delegate',
    question: 'question',
    skill: 'skill',
} satisfies Record<string, ToolBucket>));

const BUCKET_STATUS = {
    read: ['chat.agentStatus.read', 'chat.agentStatus.read.count'],
    search: ['chat.agentStatus.search', 'chat.agentStatus.search'],
    edit: ['chat.agentStatus.edit', 'chat.agentStatus.edit.count'],
    command: ['chat.agentStatus.command', 'chat.agentStatus.command.count'],
    lookup: ['chat.agentStatus.lookup', 'chat.agentStatus.lookup'],
    delegate: ['chat.agentStatus.delegate', 'chat.agentStatus.delegate.count'],
    question: ['chat.agentStatus.question', 'chat.agentStatus.question'],
    skill: ['chat.agentStatus.skill', 'chat.agentStatus.skill.count'],
} satisfies Record<ToolBucket, readonly [I18nKey, I18nKey]>;

const WORKING_STATUS: readonly I18nKey[] = [
    'chat.agentStatus.working',
    'chat.agentStatus.generic.processing',
    'chat.agentStatus.generic.preparing',
    'chat.agentStatus.generic.warmingUp',
    'chat.agentStatus.generic.gearsTurning',
    'chat.agentStatus.generic.computing',
    'chat.agentStatus.generic.calculating',
    'chat.agentStatus.generic.analyzing',
    'chat.agentStatus.generic.wheelsSpinning',
    'chat.agentStatus.generic.calibrating',
    'chat.agentStatus.generic.synthesizing',
    'chat.agentStatus.generic.connectingDots',
    'chat.agentStatus.generic.inspectingLogic',
    'chat.agentStatus.generic.weighingOptions',
];

const status = (key: I18nKey): AgentStatus => ({ key });

type ParsedStatusResult = {
    activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
    activeToolName: string | undefined;
    status: AgentStatus;
    isGenericStatus: boolean;
    canBackground: boolean;
};

type ToolActionStatus = { fallback: I18nKey; actions?: Record<string, I18nKey> };

const OPENCHAMBER_STATUS = new Map(Object.entries<ToolActionStatus>({
    openchamber: {
        fallback: 'chat.agentStatus.sessions.manage',
        actions: {
            'projects.list': 'chat.agentStatus.sessions.projects',
            'models.list': 'chat.agentStatus.sessions.models',
            'models.search': 'chat.agentStatus.sessions.models',
            'session.list': 'chat.agentStatus.sessions.list',
            'session.status': 'chat.agentStatus.sessions.status',
            'session.messages': 'chat.agentStatus.sessions.messages',
            'session.create': 'chat.agentStatus.sessions.create',
            'session.send': 'chat.agentStatus.sessions.send',
            'session.fork': 'chat.agentStatus.sessions.fork',
            'session.moveToWorktree': 'chat.agentStatus.sessions.moveToWorktree',
            'session.link': 'chat.agentStatus.sessions.link',
            'session.unlink': 'chat.agentStatus.sessions.unlink',
            'session.markDone': 'chat.agentStatus.sessions.markDone',
            'session.track': 'chat.agentStatus.sessions.track',
            'file.open': 'chat.agentStatus.sessions.openFile',
        },
    },
    openchamber_schedule: {
        fallback: 'chat.agentStatus.schedule.update',
        actions: {
            'schedule.list': 'chat.agentStatus.schedule.list',
            'schedule.run': 'chat.agentStatus.schedule.run',
        },
    },
    openchamber_web: {
        fallback: 'chat.agentStatus.browser.use',
        actions: {
            'browser.open': 'chat.agentStatus.browser.open',
            'browser.snapshot': 'chat.agentStatus.browser.read',
            'browser.inspect': 'chat.agentStatus.browser.inspect',
            'browser.capture': 'chat.agentStatus.browser.capture',
            'browser.close': 'chat.agentStatus.browser.close',
        },
    },
    openchamber_memory: {
        fallback: 'chat.agentStatus.memory.check',
        actions: {
            'memory.save': 'chat.agentStatus.memory.save',
            'memory.delete': 'chat.agentStatus.memory.delete',
        },
    },
    openchamber_knowledge: {
        fallback: 'chat.agentStatus.knowledge.check',
        actions: {
            'knowledge.save': 'chat.agentStatus.knowledge.update',
            'knowledge.delete': 'chat.agentStatus.knowledge.update',
            'knowledge.show': 'chat.agentStatus.knowledge.showPlan',
        },
    },
    openchamber_notify: { fallback: 'chat.agentStatus.notify' },
    openchamber_usage: { fallback: 'chat.agentStatus.usage' },
    openchamber_actions: {
        fallback: 'chat.agentStatus.actions',
        actions: {
            'actions.run': 'chat.agentStatus.actions.run',
            'actions.stop': 'chat.agentStatus.actions.stop',
        },
    },
    openchamber_render: { fallback: 'chat.agentStatus.render' },
    openchamber_image: { fallback: 'chat.agentStatus.image' },
    openchamber_secret: { fallback: 'chat.agentStatus.secret', actions: { 'secret.run': 'chat.agentStatus.secretRun' } },
}));

const getOpenChamberStatus = (call: OpenChamberToolCall, running: boolean): AgentStatus => {
    if (call.awaitsAnswer && running) return status('chat.agentStatus.waitingAnswer');
    const known = OPENCHAMBER_STATUS.get(call.tool);
    return status((call.action ? known?.actions?.[call.action] : undefined) ?? known?.fallback ?? 'chat.agentStatus.working');
};

const OPENCODE_NAMESPACE_STATUS = new Map(Object.entries<I18nKey>({
    session_rename: 'chat.agentStatus.sessions.rename',
    session_move: 'chat.agentStatus.sessions.move',
    worktree_create: 'chat.agentStatus.worktree.create',
    worktree_list: 'chat.agentStatus.worktree.list',
    worktree_remove: 'chat.agentStatus.worktree.remove',
    models: 'chat.agentStatus.sessions.models',
    list_mcp_resources: 'chat.agentStatus.mcp.listResources',
    read_mcp_resource: 'chat.agentStatus.mcp.readResource',
    schedule_create: 'chat.agentStatus.opencode.schedules',
    schedule_list: 'chat.agentStatus.opencode.schedules',
    schedule_pause: 'chat.agentStatus.opencode.schedules',
    schedule_resume: 'chat.agentStatus.opencode.schedules',
    schedule_delete: 'chat.agentStatus.opencode.schedules',
    automation_create: 'chat.agentStatus.opencode.automations',
    automation_list: 'chat.agentStatus.opencode.automations',
    automation_pause: 'chat.agentStatus.opencode.automations',
    automation_resume: 'chat.agentStatus.opencode.automations',
    automation_delete: 'chat.agentStatus.opencode.automations',
    artifact_create: 'chat.agentStatus.opencode.artifacts',
    artifact_read: 'chat.agentStatus.opencode.artifacts',
    artifact_update: 'chat.agentStatus.opencode.artifacts',
    artifact_delete: 'chat.agentStatus.opencode.artifacts',
}));

const asWords = (name: string): string => name.replace(/[_-]+/g, ' ').trim();

const usingTool = (name: string): AgentStatus => ({ key: 'chat.agentStatus.usingTool', name: asWords(name) });

const getToolStatus = (toolName: string, count = 1): AgentStatus => {
    const bucket = TOOL_BUCKETS.get(toolName);
    if (!bucket) return usingTool(toolName);
    const [one, many] = BUCKET_STATUS[bucket];
    return count > 1 && many !== one ? { key: many, count } : status(one);
};

const getNamedToolStatus = (
    toolName: string,
    input: JsonValue | undefined,
    running: boolean,
    mcpServers: readonly string[],
): AgentStatus | undefined => {
    const ownCall = openChamberToolCall(toolName, input);
    if (ownCall) return getOpenChamberStatus(ownCall, running);
    const opencodeTool = opencodeNamespaceTool(toolName);
    if (opencodeTool) {
        const key = OPENCODE_NAMESPACE_STATUS.get(opencodeTool);
        return key ? status(key) : undefined;
    }
    const server = mcpToolServer(toolName, mcpServers);
    return server ? usingTool(server) : undefined;
};

const getRunningToolStatus = (part: ToolPart, toolName: string, count: number, mcpServers: readonly string[], waitingCalls?: ReadonlySet<string>): AgentStatus => {
    const state = part.state;
    const running = state?.status === 'running'
        && (!waitingCalls || part.tool !== 'openchamber_secret' || waitingCalls.has(part.callID));
    const named = getNamedToolStatus(toolName, state?.input, running, mcpServers);
    if (named) {
        return named;
    }
    if (!isExecuteTool(toolName) || count > 1) {
        return getToolStatus(toolName, count);
    }
    const last = lastExecuteToolCall(state && 'metadata' in state ? state.metadata : undefined);
    if (!last) {
        return getToolStatus(toolName);
    }
    return getNamedToolStatus(last.tool, last.input, false, mcpServers) ?? getToolStatus(last.tool);
};

const hashString = (value: string): number => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
};

const getStableWorkingStatus = (key: string): AgentStatus => {
    return status(WORKING_STATUS[hashString(key) % WORKING_STATUS.length] ?? 'chat.agentStatus.working');
};

export const hasBackgroundableWork = (parts: readonly Part[]): boolean => parts.some((part) => {
    if (part.type !== 'tool' || part.state?.status !== 'running') return false;
    if (isShellTool(part.tool) || isSubagentTool(part.tool)) return true;
    if (!isExecuteTool(part.tool)) return false;
    return executeHasBackgroundableWork(part.state.metadata);
});

export const createParsedStatus = (parts: Part[], genericKey: string, mcpServers: readonly string[] = [], waitingCalls?: ReadonlySet<string>): ParsedStatusResult => {
    const runningToolCounts = countRunningToolCalls(parts);
    let activePartType: ParsedStatusResult['activePartType'] = undefined;
    let activeToolName: string | undefined = undefined;
    let activeToolStatus: AgentStatus | undefined = undefined;
    let activeReasoningId: string | undefined = undefined;

    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (!part) continue;

        switch (part.type) {
            case 'reasoning': {
                const time = part.time ?? getPartTimeInfo(part);
                const stillRunning = !time || typeof time.end === 'undefined';
                if (stillRunning && !activePartType) {
                    activePartType = 'reasoning';
                    activeReasoningId = part.id;
                }
                break;
            }
            case 'tool': {
                const toolStatus = part.state?.status;
                if ((toolStatus === 'running' || toolStatus === 'pending') && !activePartType) {
                    const toolName = getToolDisplayName(part);
                    const bucket = TOOL_BUCKETS.get(toolName);
                    activePartType = bucket === 'edit' ? 'editing' : 'tool';
                    activeToolName = toolName;
                    activeToolStatus = getRunningToolStatus(part, toolName, runningToolCounts.get(bucket ?? toolName) ?? 1, mcpServers, waitingCalls);
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
    const resolved = ((): AgentStatus => {
        if (activePartType === 'editing') return activeToolStatus ?? status('chat.agentStatus.edit');
        if (activePartType === 'tool' && activeToolName) return activeToolStatus ?? getToolStatus(activeToolName);
        if (activePartType === 'reasoning') {
            const thinking: AgentStatus = { key: 'chat.agentStatus.thinking' };
            if (activeReasoningId) thinking.seed = activeReasoningId;
            return thinking;
        }
        if (activePartType === 'text') return status('chat.agentStatus.composing');
        return getStableWorkingStatus(genericKey);
    })();

    return { activePartType, activeToolName, status: resolved, isGenericStatus, canBackground: hasBackgroundableWork(parts) };
};

const encodeParsedStatus = (status: ParsedStatusResult): string => {
    return [
        status.activePartType ?? '',
        status.activeToolName ?? '',
        JSON.stringify([status.status.key, status.status.count ?? null, status.status.name ?? null, status.status.seed ?? null]),
        status.isGenericStatus ? '1' : '0',
        status.canBackground ? '1' : '0',
    ].join(STATUS_SIGNATURE_SEPARATOR);
};

const decodeStatus = (encoded: string | undefined): AgentStatus => {
    if (!encoded) return { key: 'chat.agentStatus.working' };
    // SAFETY: `encodeParsedStatus` wrote this tuple from an AgentStatus, and the
    // signature only travels from that encoder to this decoder.
    const [key, count, name, seed] = JSON.parse(encoded) as [I18nKey, number | null, string | null, string | null];
    const decoded: AgentStatus = { key };
    if (count !== null) decoded.count = count;
    if (name !== null) decoded.name = name;
    if (seed !== null) decoded.seed = seed;
    return decoded;
};

const decodeParsedStatus = (signature: string): ParsedStatusResult => {
    const [activePartType, activeToolName, encodedStatus, isGenericStatus, canBackground] = signature.split(STATUS_SIGNATURE_SEPARATOR);
    return {
        activePartType: activePartType === 'text' || activePartType === 'tool' || activePartType === 'reasoning' || activePartType === 'editing'
            ? activePartType
            : undefined,
        activeToolName: activeToolName || undefined,
        status: decodeStatus(encodedStatus),
        isGenericStatus: isGenericStatus === '1',
        canBackground: canBackground === '1',
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

const countRunningToolCalls = (parts: readonly Part[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const part of parts) {
        if (part.type !== 'tool') continue;
        const status = part.state?.status;
        if (status !== 'running' && status !== 'pending') continue;
        const toolName = getToolDisplayName(part);
        const bucket = TOOL_BUCKETS.get(toolName) ?? toolName;
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return counts;
};

const hasNewerPrompt = (messages: Message[], index: number): boolean => {
    for (let cursor = messages.length - 1; cursor > index; cursor -= 1) {
        if (messages[cursor]?.role === 'user') return true;
    }
    return false;
};

export const getActiveAssistantContext = (messages: Message[], sessionModel?: ModelRef | null): ActiveAssistantContext => {
    const sessionProviderId = sessionModel?.providerID.trim() ?? '';
    const sessionModelId = sessionModel?.id.trim() ?? '';
    const nextTurnModel = sessionProviderId && sessionModelId ? { providerId: sessionProviderId, modelId: sessionModelId } : null;
    // external: https://github.com/anomalyco/opencode/issues/65550 session.compaction.started carries no model, and the compactor can differ from the thread's.
    let newestCompaction: 'running' | 'settled' | null = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'compaction' && newestCompaction === null) {
            newestCompaction = message.status === 'running' ? 'running' : 'settled';
        }
        if (message?.role !== 'assistant') continue;

        if (newestCompaction === 'running') return { assistantId: message.id, model: null };

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

const ResetsAt = z.union([z.iso.datetime({ offset: true }).transform((value) => Date.parse(value)), z.number().positive()]);
const RateLimitBody = z.object({
    resets_at: ResetsAt.optional(),
    error: z.object({ resets_at: ResetsAt.optional() }).optional(),
});

export function limitResetsAt(error: StructuredError | undefined): number | undefined {
    const raw = error?.response?.body;
    if (!raw?.includes('resets_at')) return undefined;
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return undefined;
    }
    const body = RateLimitBody.safeParse(json);
    if (!body.success) return undefined;
    const at = body.data.error?.resets_at ?? body.data.resets_at;
    if (at === undefined) return undefined;
    return at < 1_000_000_000_000 ? at * 1000 : at;
}

export function useAssistantStatus(): AssistantStatusSnapshot {
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();

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

    const mcpServerConfigs = useMcpConfigStore((state) => selectMcpServersForDirectory(state, currentSessionDirectory));
    const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
    React.useEffect(() => {
        void loadMcpConfigs({ directory: currentSessionDirectory });
    }, [currentSessionDirectory, loadMcpConfigs]);
    const mcpServers = React.useMemo(() => mcpServerConfigs.map((server) => server.name), [mcpServerConfigs]);

    const waitingCallIds = useGlobalBlockingRequestsStore(React.useCallback(
        (state) => (currentSessionId ? state.bySession.get(currentSessionId)?.pages.map((page) => page.id).join('\n') ?? '' : ''),
        [currentSessionId],
    ));
    const waitingCalls = React.useMemo(() => new Set(waitingCallIds ? waitingCallIds.split('\n') : []), [waitingCallIds]);
    const lastAssistantStatusSignature = useDirectorySync(
        React.useCallback((state) => {
            const genericKey = `${currentSessionId ?? ''}:${lastAssistantId ?? ''}`;
            const parts = lastAssistantId ? (state.part[lastAssistantId] ?? EMPTY_PARTS) : EMPTY_PARTS;
            return encodeParsedStatus(createParsedStatus(parts, genericKey, mcpServers, waitingCalls));
        }, [currentSessionId, lastAssistantId, mcpServers, waitingCalls]),
        currentSessionDirectory ?? undefined,
    );

    const sessionPermissionRequests = useSessionPermissions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    // external: #5391 a form whose tool call has ended leaves the turn running.
    const releasedForms = useRecoverableQuestionsStore((state) => state.releasedForms);
    const formHoldsTurn = useDirectorySync(
        React.useCallback((state) => (
            state.form[currentSessionId ?? '']?.some((form) => formTurnHold(form, state.part, releasedForms) !== 'released') ?? false
        ), [currentSessionId, releasedForms]),
        currentSessionDirectory ?? undefined,
    );

    const sessionAbortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId])
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    const assistantRetry = React.useMemo(() => {
        if (!lastAssistantId) return null;
        const message = rawSessionMessages.find((candidate) => candidate.id === lastAssistantId);
        return message?.role === 'assistant' ? message.retry ?? null : null;
    }, [rawSessionMessages, lastAssistantId]);

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
                status: null,
                canAbort: false,
                retryInfo: null,
            };
        }

        const isWorking = isPhaseWorking;
        const isStreaming = activityPhase === 'busy';
        const isCooldown = false;
        const isRetry = activityPhase === 'retry' || (isWorking && assistantRetry !== null);

        let activity: AssistantActivity = 'idle';
        if (isWorking) {
            if (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing') {
                activity = 'tooling';
            } else {
                activity = isCooldown ? 'cooldown' : 'streaming';
            }
        }

        const retryInfo = isRetry
            ? {
                attempt: sessionRetryAttempt ?? assistantRetry?.attempt,
                next: sessionRetryNext ?? assistantRetry?.at,
                resetsAt: limitResetsAt(assistantRetry?.error),
            }
            : null;

        return {
            activity,
            hasWorkingContext: isWorking,
            hasActiveTools: parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing',
            isWorking,
            isStreaming,
            isCooldown,
            lifecyclePhase: isStreaming ? 'streaming' : isCooldown ? 'cooldown' : null,
            status: isWorking ? parsedStatus.status : null,
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
            canBackground: isWorking && parsedStatus.canBackground,
        };
    }, [activityPhase, isPhaseWorking, parsedStatus, abortState, sessionRetryAttempt, sessionRetryNext, assistantRetry]);

    const forming = React.useMemo<FormingSummary>(() => {
        const isActive = isPhaseWorking && parsedStatus.activePartType === 'text';
        return { isActive, characterCount: 0 };
    }, [isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingForm = formHoldsTurn;

        if (!hasPendingPermission && !hasPendingForm) {
            return baseWorking;
        }

        if (hasPendingForm) {
            return {
                ...baseWorking,
                status: null,
                isWorking: false,
                hasWorkingContext: false,
                hasActiveTools: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                retryInfo: null,
                canBackground: false,
            };
        }

        return {
            ...baseWorking,
            status: status('chat.agentStatus.waitingPermission'),
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
            canBackground: false,
        };
    }, [baseWorking, sessionPermissionRequests, formHoldsTurn]);

    return {
        activeModel: activeAssistant.model,
        forming,
        working,
    };
}
