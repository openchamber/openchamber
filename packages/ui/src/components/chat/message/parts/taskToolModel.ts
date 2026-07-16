import type { MessageRecord } from '@/lib/messageCompletion';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';

export type TaskToolSummaryEntry = {
    id?: string;
    tool?: string;
    state?: {
        status?: string;
        title?: string;
        input?: Record<string, unknown>;
    };
};

const normalizeSessionIdCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const readTaskSessionIdFromRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return normalizeSessionIdCandidate(record.sessionID) ?? normalizeSessionIdCandidate(record.sessionId);
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
                input: record.state?.input && typeof record.state.input === 'object'
                    ? record.state.input as Record<string, unknown>
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
            const toolName = part.tool?.trim().toLowerCase();
            if (!toolName || toolName === 'task' || toolName === 'todowrite' || toolName === 'todoread') continue;
            const state = part.state as { status?: string; title?: string; input?: unknown } | undefined;
            entries.push({
                id: part.id,
                tool: part.tool,
                state: {
                    status: state?.status,
                    title: state?.title,
                    input: state?.input && typeof state.input === 'object'
                        ? state.input as Record<string, unknown>
                        : undefined,
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
