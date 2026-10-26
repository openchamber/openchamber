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

// [one call, several calls]; `{count}` becomes the number of parallel calls in
// the bucket. A search spans many files in one call, so it is not counted.
const BUCKET_PHRASES = {
    read: ['reading a file', 'reading {count} files'],
    search: ['searching files', 'searching files'],
    edit: ['editing a file', 'editing {count} files'],
    command: ['running a command', 'running {count} commands'],
    lookup: ['looking things up', 'looking things up'],
    delegate: ['handing off a task', 'handing off {count} tasks'],
    question: ['asking a question', 'asking a question'],
    skill: ['picking up a skill', 'picking up {count} skills'],
} satisfies Record<ToolBucket, readonly [string, string]>;
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
    canBackground: boolean;
};

// OpenChamber's own tools each do several kinds of work behind one name, so
// the phrase follows the call's `action`. The fallback covers the remaining
// actions and any added later; the tool name never reaches the pill.
type ToolActionPhrases = { fallback: string; actions?: Record<string, string> };

const OPENCHAMBER_PHRASES = new Map(Object.entries<ToolActionPhrases>({
    openchamber: {
        fallback: 'managing sessions',
        actions: {
            'projects.list': 'looking at projects',
            'models.list': 'looking up models',
            'models.search': 'looking up models',
            'session.list': 'checking sessions',
            'session.status': 'checking a session',
            'session.messages': 'reading a session',
            'session.create': 'starting a session',
            'session.send': 'messaging a session',
            'session.fork': 'forking a session',
            'session.moveToWorktree': 'moving to a worktree',
            'session.link': 'linking the work',
            'file.open': 'opening a file',
        },
    },
    openchamber_schedule: {
        fallback: 'updating scheduled tasks',
        actions: {
            'schedule.list': 'checking scheduled tasks',
            'schedule.run': 'running a scheduled task',
        },
    },
    openchamber_web: {
        fallback: 'using the browser',
        actions: {
            'browser.open': 'opening a page',
            'browser.snapshot': 'reading a page',
            'browser.inspect': 'inspecting a page',
            'browser.capture': 'taking a screenshot',
            'browser.close': 'closing a tab',
        },
    },
    openchamber_memory: {
        fallback: 'checking memory',
        actions: {
            'memory.save': 'saving to memory',
            'memory.delete': 'removing a memory',
        },
    },
    openchamber_knowledge: {
        fallback: 'checking project knowledge',
        actions: {
            'knowledge.save': 'updating project knowledge',
            'knowledge.delete': 'updating project knowledge',
            'knowledge.show': 'showing a plan',
        },
    },
    openchamber_notify: { fallback: 'sending a notification' },
    openchamber_render: { fallback: 'drawing a page' },
}));

/**
 * `running` tells a page that waits for the user's answer apart from one the
 * model is still writing: the call runs until the user picks.
 */
const getOpenChamberPhrase = (call: OpenChamberToolCall, running: boolean): string => {
    if (call.awaitsAnswer && running) return 'waiting for your answer';
    const phrases = OPENCHAMBER_PHRASES.get(call.tool);
    return (call.action ? phrases?.actions?.[call.action] : undefined) ?? phrases?.fallback ?? 'working';
};

// The `opencode` namespace: OpenCode managing itself.
const OPENCODE_NAMESPACE_PHRASES = new Map(Object.entries({
    session_rename: 'renaming the session',
    session_move: 'moving the session',
    worktree_create: 'creating a worktree',
    worktree_list: 'checking worktrees',
    worktree_remove: 'removing a worktree',
    models: 'looking up models',
    list_mcp_resources: 'checking MCP resources',
    read_mcp_resource: 'reading an MCP resource',
}));

const asWords = (name: string): string => name.replace(/[_-]+/g, ' ').trim();

const getToolStatusPhrase = (toolName: string, count = 1): string => {
    const bucket = TOOL_BUCKETS.get(toolName);
    if (!bucket) {
        // A plugin tool nobody described: its name, read as words.
        return `using ${asWords(toolName)}`;
    }
    const [one, many] = BUCKET_PHRASES[bucket];
    return (count > 1 ? many : one).replace('{count}', String(count));
};

/**
 * Tools that say what they do whether the model calls them directly or from a
 * Code Mode script: OpenChamber's own, the `opencode` namespace, and MCP
 * tools, which name the integration they come from.
 */
const getNamedToolPhrase = (
    toolName: string,
    input: JsonValue | undefined,
    running: boolean,
    mcpServers: readonly string[],
): string | undefined => {
    const ownCall = openChamberToolCall(toolName, input);
    if (ownCall) return getOpenChamberPhrase(ownCall, running);
    const opencodeTool = opencodeNamespaceTool(toolName);
    if (opencodeTool) return OPENCODE_NAMESPACE_PHRASES.get(opencodeTool);
    const server = mcpToolServer(toolName, mcpServers);
    return server ? `using ${asWords(server)}` : undefined;
};

/**
 * A running `execute` (Code Mode) script names the tool it is calling as soon
 * as its metadata lists one, so the pill tracks the script's real work instead
 * of sitting on a generic phrase for its whole run. Parallel commands are the
 * exception: one call's name cannot speak for several, so they count instead.
 */
const getRunningToolPhrase = (part: ToolPart, toolName: string, count: number, mcpServers: readonly string[]): string => {
    const state = part.state;
    const named = getNamedToolPhrase(toolName, state?.input, state?.status === 'running', mcpServers);
    if (named) {
        return named;
    }
    if (!isExecuteTool(toolName) || count > 1) {
        return getToolStatusPhrase(toolName, count);
    }
    const last = lastExecuteToolCall(state && 'metadata' in state ? state.metadata : undefined);
    if (!last) {
        return getToolStatusPhrase(toolName);
    }
    return getNamedToolPhrase(last.tool, last.input, false, mcpServers) ?? getToolStatusPhrase(last.tool);
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
                    const bucket = TOOL_BUCKETS.get(toolName);
                    activePartType = bucket === 'edit' ? 'editing' : 'tool';
                    activeToolName = toolName;
                    activeToolPhrase = getRunningToolPhrase(part, toolName, runningToolCounts.get(bucket ?? toolName) ?? 1, mcpServers);
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
        if (activePartType === 'editing') return activeToolPhrase ?? 'editing a file';
        if (activePartType === 'tool' && activeToolName) return activeToolPhrase ?? getToolStatusPhrase(activeToolName);
        if (activePartType === 'reasoning') return 'thinking';
        if (activePartType === 'text') return 'composing';
        return getStableWorkingPhrase(genericKey);
    })();

    return { activePartType, activeToolName, statusText, isGenericStatus, canBackground: hasBackgroundableWork(parts) };
};

const encodeParsedStatus = (status: ParsedStatusResult): string => {
    return [
        status.activePartType ?? '',
        status.activeToolName ?? '',
        status.statusText,
        status.isGenericStatus ? '1' : '0',
        status.canBackground ? '1' : '0',
    ].join(STATUS_SIGNATURE_SEPARATOR);
};

const decodeParsedStatus = (signature: string): ParsedStatusResult => {
    const [activePartType, activeToolName, statusText = 'working', isGenericStatus, canBackground] = signature.split(STATUS_SIGNATURE_SEPARATOR);
    return {
        activePartType: activePartType === 'text' || activePartType === 'tool' || activePartType === 'reasoning' || activePartType === 'editing'
            ? activePartType
            : undefined,
        activeToolName: activeToolName || undefined,
        statusText,
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
                statusText: null,
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
                statusText: null,
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
            statusText: 'waiting for permission',
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
