import type { MessageRecord } from '@/lib/messageCompletion';
import type { Part, Session, ToolInput } from '@/lib/opencode/model';

import { isSubagentTool, normalizeToolName } from '@/lib/opencode/tools';

import { capToolOutputText } from '../toolRenderers';
import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';

export type TaskToolSummaryEntry = {
    id?: string;
    tool?: string;
    state?: {
        status?: string;
        title?: string;
        input?: ToolInput;
    };
};

const normalizeSessionIdCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The child session a subagent call runs in. v2 puts it on the call's result
 * metadata as `sessionID`; `sessionId` stays accepted for the legacy
 * `<task_metadata>` block.
 */
export const readTaskSessionIdFromRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return normalizeSessionIdCandidate(record.sessionID) ?? normalizeSessionIdCandidate(record.sessionId);
};

/**
 * OpenCode 2.x publishes a running subagent's child session id only through
 * the ephemeral `session.tool.progress` event; the stored tool part carries
 * no metadata until the call settles. A parent message loaded over REST while
 * the subagent runs therefore has no join. This recovers it from the child
 * session record: a child of the parent session, created after the call
 * started, running the requested agent, and not already joined to another
 * Task call of the same message. Anything but exactly one candidate yields
 * `undefined`; the caller drops this fallback once the real id arrives.
 */
export const resolveRunningTaskChildSessionId = (options: {
    sessions: readonly Session[];
    parentSessionID: string;
    startedAt: number;
    /** The Task's `input.agent`; OpenCode stores this id on the child session. */
    agent: ToolInput[string] | undefined;
    siblingParts: readonly Part[] | undefined;
    partID: string;
}): string | undefined => {
    const { sessions, parentSessionID, startedAt, agent, siblingParts, partID } = options;
    let claimed: Set<string> | undefined;
    for (const sibling of siblingParts ?? []) {
        if (sibling.id === partID || sibling.type !== 'tool' || !isSubagentTool(normalizeToolName(sibling.tool))) continue;
        const siblingSessionID = sibling.state.status === 'pending'
            ? undefined
            : readTaskSessionIdFromRecord(sibling.state.metadata);
        if (!siblingSessionID) continue;
        claimed ??= new Set();
        claimed.add(siblingSessionID);
    }

    let match: string | undefined;
    for (const session of sessions) {
        if (session.parentID !== parentSessionID) continue;
        if (session.time.created < startedAt) continue;
        if (agent !== undefined && session.agent !== undefined && session.agent !== agent) continue;
        if (claimed?.has(session.id)) continue;
        if (match !== undefined) return undefined;
        match = session.id;
    }
    return match;
};

export const normalizeTaskSummaryEntries = (value: unknown): TaskToolSummaryEntry[] => {
    if (!Array.isArray(value)) return [];

    const normalized: TaskToolSummaryEntry[] = [];
    for (const entry of value) {
        if (typeof entry === 'string') {
            normalized.push({ tool: 'tool', state: { status: 'completed', title: entry } });
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;

        const record = entry as {
            id?: unknown;
            tool?: unknown;
            title?: unknown;
            status?: unknown;
            state?: { status?: unknown; title?: unknown; input?: unknown };
        };
        normalized.push({
            id: typeof record.id === 'string' ? record.id : undefined,
            tool: typeof record.tool === 'string' ? record.tool : 'tool',
            state: {
                status: typeof record.state?.status === 'string'
                    ? record.state.status
                    : typeof record.status === 'string' ? record.status : undefined,
                title: typeof record.state?.title === 'string'
                    ? record.state.title
                    : typeof record.title === 'string' ? record.title : undefined,
                // SAFETY: the legacy <task_metadata> block is JSON, so an
                // object value here is already a JSON record.
                input: record.state?.input && typeof record.state.input === 'object'
                    ? record.state.input as ToolInput
                    : undefined,
            },
        });
    }
    return normalized;
};

export const parseTaskMetadataBlock = (output: string | undefined): {
    sessionId?: string;
    summaryEntries: TaskToolSummaryEntry[];
} => {
    if (typeof output !== 'string' || output.trim().length === 0) return { summaryEntries: [] };
    const blockMatch = output.match(/<task_metadata>\s*([\s\S]*?)\s*<\/task_metadata>/i);
    if (!blockMatch?.[1]) return { summaryEntries: [] };

    try {
        const parsed = JSON.parse(blockMatch[1].trim()) as Record<string, unknown>;
        return {
            sessionId: normalizeSessionIdCandidate(parsed.sessionId) ?? normalizeSessionIdCandidate(parsed.sessionID),
            summaryEntries: normalizeTaskSummaryEntries(parsed.summary ?? parsed.entries ?? parsed.tools ?? parsed.calls),
        };
    } catch {
        return { summaryEntries: [] };
    }
};

export const readTaskSessionIdFromOutput = (output: string | undefined): string | undefined => {
    if (typeof output !== 'string' || output.trim().length === 0) return undefined;
    const parsedMetadata = parseTaskMetadataBlock(output);
    if (parsedMetadata.sessionId) return parsedMetadata.sessionId;

    const taskMatch = output.match(/task_id\s*:\s*([^\s<"']+)/i);
    const sessionMatch = output.match(/session[_\s-]?id\s*:\s*([^\s<"']+)/i);
    const candidate = taskMatch?.[1] ?? sessionMatch?.[1];
    if (candidate) return normalizeSessionIdCandidate(candidate);
    return normalizeSessionIdCandidate(readTaskTagSessionIdFromOutput(output));
};

const messageSummaryCache = new WeakMap<MessageRecord, TaskToolSummaryEntry[]>();

const projectMessageSummaryEntries = (message: MessageRecord): TaskToolSummaryEntry[] => {
    const cached = messageSummaryCache.get(message);
    if (cached) return cached;

    const entries: TaskToolSummaryEntry[] = [];
    if (message.info.role === 'assistant') {
        for (const part of message.parts) {
            if (part.type !== 'tool') continue;
            const toolName = normalizeToolName(part.tool);
            if (!toolName || isSubagentTool(toolName)) continue;
            const state = part.state as { status?: string; input?: ToolInput } | undefined;
            entries.push({
                id: part.id,
                tool: part.tool,
                state: {
                    status: state?.status,
                    input: state?.input,
                },
            });
        }
    }
    messageSummaryCache.set(message, entries);
    return entries;
};

export const buildTaskSummaryEntriesFromSession = (messages: MessageRecord[]): TaskToolSummaryEntry[] => {
    const entries: TaskToolSummaryEntry[] = [];
    for (const message of messages) entries.push(...projectMessageSummaryEntries(message));
    return entries;
};

export const stripTaskMetadataFromOutput = (output: string): string => {
    return output.replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/i, '').trimEnd();
};

const TASK_ENVELOPE_OPEN_TAG_PATTERN = /^\s*<task(?:\s[^>]*)?>/i;
const TASK_RESULT_BLOCK_PATTERN = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i;

// OpenCode wraps a completed task result in an envelope:
//   <task id="ses_…" state="completed">
//   <task_result>…result Markdown…</task_result>
//   </task>
// `marked` treats the leading tag line as a raw HTML block, so the Markdown
// below it stays literal (issue #3238). Only unwrap when the output actually
// starts with the envelope tag and carries a complete result block; other
// outputs pass through untouched.
const unwrapTaskResultEnvelope = (output: string): string => {
    if (!TASK_ENVELOPE_OPEN_TAG_PATTERN.test(output)) return output;
    const resultBlock = output.match(TASK_RESULT_BLOCK_PATTERN);
    if (!resultBlock) return output;
    return resultBlock[1];
};

// The task tool renders its output through the markdown parser instead of the
// shared tool-output path, so it needs the same size guard as
// `getToolOutputText` (issue #2265): an unbounded single string reaching the
// parser can exhaust V8's Zone allocator and crash the renderer.
export const prepareTaskToolOutput = (output: string | undefined): string => {
    if (!output) return '';
    return capToolOutputText(stripTaskMetadataFromOutput(unwrapTaskResultEnvelope(output)));
};
