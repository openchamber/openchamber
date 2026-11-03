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
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSession, useSessionMessages, useSessionPermissions, useSessionForms, useSessionStatus } from '@/sync/sync-context';
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
    /** What the agent is doing, as a dictionary key; `formatAgentStatus` makes the text. */
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
    /**
     * The turn waits on work OpenCode can move to the background: a running
     * shell command or a subagent it delegated to (`session.background`),
     * including one running inside a Code Mode `execute` call.
     */
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

// Several tools share one phrase, so parallel calls of the same kind can be
// counted together ("reading 3 files"). The timeline names the exact tool.
// v2 tool names: `shell` replaced `bash`, `subagent` replaced `task`, and
// `todowrite`/`todoread`/`list`/`lsp` are gone.
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

// [one call, several calls]. The counted phrase takes the number of parallel
// calls in the bucket. A search spans many files in one call, so it is not counted.
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

// Shown while no part says what the turn does; one per turn, picked by its key.
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

// OpenChamber's own tools each do several kinds of work behind one name, so
// the status follows the call's `action`. The fallback covers the remaining
// actions and any added later; the tool name never reaches the pill.
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
    openchamber_render: { fallback: 'chat.agentStatus.render' },
    openchamber_image: { fallback: 'chat.agentStatus.image' },
    openchamber_secret: { fallback: 'chat.agentStatus.secret' },
}));

/**
 * `running` tells a page that waits for the user's answer apart from one the
 * model is still writing: the call runs until the user picks.
 */
const getOpenChamberStatus = (call: OpenChamberToolCall, running: boolean): AgentStatus => {
    if (call.awaitsAnswer && running) return status('chat.agentStatus.waitingAnswer');
    const known = OPENCHAMBER_STATUS.get(call.tool);
    return status((call.action ? known?.actions?.[call.action] : undefined) ?? known?.fallback ?? 'chat.agentStatus.working');
};

// The `opencode` namespace: OpenCode managing itself.
const OPENCODE_NAMESPACE_STATUS = new Map(Object.entries<I18nKey>({
    session_rename: 'chat.agentStatus.sessions.rename',
    session_move: 'chat.agentStatus.sessions.move',
    worktree_create: 'chat.agentStatus.worktree.create',
    worktree_list: 'chat.agentStatus.worktree.list',
    worktree_remove: 'chat.agentStatus.worktree.remove',
    models: 'chat.agentStatus.sessions.models',
    list_mcp_resources: 'chat.agentStatus.mcp.listResources',
    read_mcp_resource: 'chat.agentStatus.mcp.readResource',
}));

const asWords = (name: string): string => name.replace(/[_-]+/g, ' ').trim();

const usingTool = (name: string): AgentStatus => ({ key: 'chat.agentStatus.usingTool', name: asWords(name) });

const getToolStatus = (toolName: string, count = 1): AgentStatus => {
    const bucket = TOOL_BUCKETS.get(toolName);
    // A plugin tool nobody described: its name, read as words.
    if (!bucket) return usingTool(toolName);
    const [one, many] = BUCKET_STATUS[bucket];
    return count > 1 && many !== one ? { key: many, count } : status(one);
};

/**
 * Tools that say what they do whether the model calls them directly or from a
 * Code Mode script: OpenChamber's own, the `opencode` namespace, and MCP
 * tools, which name the integration they come from.
 */
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

/**
 * A running `execute` (Code Mode) script names the tool it is calling as soon
 * as its metadata lists one, so the pill tracks the script's real work instead
 * of sitting on a generic status for its whole run. Parallel commands are the
 * exception: one call's name cannot speak for several, so they count instead.
 */
const getRunningToolStatus = (part: ToolPart, toolName: string, count: number, mcpServers: readonly string[]): AgentStatus => {
    const state = part.state;
    const named = getNamedToolStatus(toolName, state?.input, state?.status === 'running', mcpServers);
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

/**
 * The turn waits on a job OpenCode can move to the background: a shell command
 * or a subagent call that already runs. A pending call has not started yet (or
 * waits for a permission), and a background call settles at once, so neither
 * counts. A running Code Mode `execute` counts when a shell or subagent runs
 * inside it.
 */
export const hasBackgroundableWork = (parts: readonly Part[]): boolean => parts.some((part) => {
    if (part.type !== 'tool' || part.state?.status !== 'running') return false;
    if (isShellTool(part.tool) || isSubagentTool(part.tool)) return true;
    if (!isExecuteTool(part.tool)) return false;
    return executeHasBackgroundableWork(part.state.metadata);
});

/** `mcpServers`: the configured MCP server names, which name the integration an MCP tool comes from. */
export const createParsedStatus = (parts: Part[], genericKey: string, mcpServers: readonly string[] = []): ParsedStatusResult => {
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
                    activeToolStatus = getRunningToolStatus(part, toolName, runningToolCounts.get(bucket ?? toolName) ?? 1, mcpServers);
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
        // The signature decides re-renders: equal statuses encode the same.
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

/**
 * Parallel calls are common (three reads, two shell commands), and the last
 * part alone hides the rest. Count every call that is still running or pending
 * by bucket so the phrase can say "reading 3 files" instead.
 */
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

const ResetsAt = z.union([z.iso.datetime({ offset: true }).transform((value) => Date.parse(value)), z.number().positive()]);
const RateLimitBody = z.object({
    resets_at: ResetsAt.optional(),
    error: z.object({ resets_at: ResetsAt.optional() }).optional(),
});

/**
 * When a provider's rate limit lifts, from a `resets_at` field in the 429
 * body (top level or under `error`; an ISO date or epoch seconds/ms). OpenCode
 * caps a retry delay at 15 minutes, so a limit that lifts hours later shows
 * a retry that is bound to fail again; this time is the one that matters.
 * Only the body reaches the client: reset headers stay in OpenCode.
 */
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
    // Epoch seconds or milliseconds.
    return at < 1_000_000_000_000 ? at * 1000 : at;
}

export function useAssistantStatus(): AssistantStatusSnapshot {
    // Inside the chat column, follow the session the timeline shows rather
    // than the live selection, so the status chip changes together with the
    // conversation instead of a commit ahead of it.
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

    // An MCP tool's name starts with its server's name, and only the configured
    // names can split it. Reading the config touches no running server.
    const mcpServerConfigs = useMcpConfigStore((state) => selectMcpServersForDirectory(state, currentSessionDirectory));
    const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
    React.useEffect(() => {
        void loadMcpConfigs({ directory: currentSessionDirectory });
    }, [currentSessionDirectory, loadMcpConfigs]);
    const mcpServers = React.useMemo(() => mcpServerConfigs.map((server) => server.name), [mcpServerConfigs]);

    const lastAssistantStatusSignature = useDirectorySync(
        React.useCallback((state) => {
            const genericKey = `${currentSessionId ?? ''}:${lastAssistantId ?? ''}`;
            const parts = lastAssistantId ? (state.part[lastAssistantId] ?? EMPTY_PARTS) : EMPTY_PARTS;
            return encodeParsedStatus(createParsedStatus(parts, genericKey, mcpServers));
        }, [currentSessionId, lastAssistantId, mcpServers]),
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

    const { phase: activityPhase, isWorking: isPhaseWorking } = useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    // OpenCode 2.x reports a scheduled retry on the assistant message it will
    // retry, not as a session status; the next attempt's step start clears it.
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
        const hasPendingForm = sessionFormRequests.length > 0;

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
    }, [baseWorking, sessionPermissionRequests, sessionFormRequests]);

    return {
        activeModel: activeAssistant.model,
        forming,
        working,
    };
}
