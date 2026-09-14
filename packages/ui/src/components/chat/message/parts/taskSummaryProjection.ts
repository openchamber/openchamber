import type { Part, ToolPart } from '@opencode-ai/sdk/v2';
import type { MessageRecord } from '@/lib/messageCompletion';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { projectToolSegmentRows } from './toolSegmentProjection';
import type { ContextToolChildRow, ContextToolCounts, ContextToolGroupStatus } from './toolSegmentProjection';

export type TaskSummaryEntry = {
    id?: string;
    tool?: string;
    state?: {
        status?: string;
        title?: string;
        input?: Record<string, unknown>;
        error?: string;
    };
};

export type TaskSummaryEntryPresentation = {
    toolName: string;
    state: 'active' | 'error' | 'done';
    label: string;
};

export type TaskSummaryRow =
    | {
        type: 'task-entry';
        key: string;
        entry: TaskSummaryEntryPresentation;
        activityCount: 1;
        renderSignature: string;
    }
    | {
        type: 'context-tool-group';
        key: string;
        status: ContextToolGroupStatus;
        counts: ContextToolCounts;
        children: ContextToolChildRow[];
        activityCount: number;
        renderSignature: string;
    };

type ProjectTaskSummaryInput = {
    taskPartId: string;
    childSessionMessages: MessageRecord[];
    fallbackEntries: unknown[];
    expanded: boolean;
};

type TaskSummaryProjection = {
    rows: TaskSummaryRow[];
    hiddenActionCount: number;
    renderSignature: string;
};

const normalizeToolName = (toolName: string | undefined): string => toolName?.trim().toLowerCase() ?? '';
const ERROR_STATUSES = new Set(['error', 'failed', 'aborted', 'timeout', 'cancelled']);
const ACTIVE_STATUSES = new Set(['pending', 'running', 'started']);

const normalizeText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeFallbackEntries = (entries: unknown[]): TaskSummaryEntry[] => {
    const normalized: TaskSummaryEntry[] = [];
    for (const value of entries) {
        if (typeof value === 'string') {
            normalized.push({ tool: 'tool', state: { status: 'completed', title: value } });
            continue;
        }
        if (!isRecord(value)) continue;

        const state = isRecord(value.state) ? value.state : undefined;
        const input = isRecord(state?.input) ? state.input : undefined;
        const status = normalizeText(state?.status) || normalizeText(value.status) || undefined;
        const title = normalizeText(state?.title) || normalizeText(value.title) || undefined;
        const error = normalizeText(state?.error) || normalizeText(value.error) || undefined;
        normalized.push({
            id: normalizeText(value.id) || undefined,
            tool: normalizeText(value.tool) || 'tool',
            state: { status, title, error, input },
        });
    }
    return normalized;
};

const getEntryLabel = (entry: TaskSummaryEntry): string => {
    const error = normalizeText(entry.state?.error);
    if (error) {
        return error;
    }

    const title = normalizeText(entry.state?.title);
    if (title) {
        return title;
    }

    const input = entry.state?.input;
    const candidate = input?.filePath ?? input?.file_path ?? input?.path ?? input?.url;
    return normalizeText(candidate);
};

const getEntryState = (statusValue: string | undefined): TaskSummaryEntryPresentation['state'] => {
    const status = normalizeToolName(statusValue);
    if (ERROR_STATUSES.has(status)) return 'error';
    if (ACTIVE_STATUSES.has(status)) return 'active';
    return 'done';
};

const presentEntry = (entry: TaskSummaryEntry): TaskSummaryEntryPresentation => ({
    toolName: normalizeToolName(entry.tool) || 'tool',
    state: getEntryState(entry.state?.status),
    label: getEntryLabel(entry),
});

const getEntryPresentationSignature = (entry: TaskSummaryEntryPresentation): string => [
    entry.toolName,
    entry.state,
    entry.label,
].join('\u0001');

const getFallbackKey = (taskPartId: string, entry: TaskSummaryEntry, index: number): string => {
    const suppliedId = normalizeText(entry.id);
    return `task-summary:${taskPartId}:entry:fallback:${index}${suppliedId ? `:${suppliedId}` : ''}`;
};

const isHiddenTaskSeparator = (part: Part): boolean => {
    if (part.type === 'reasoning') return false;
    if (part.type === 'text') return part.text.trim().length > 0;

    if (part.type !== 'tool') {
        return true;
    }

    const toolName = normalizeToolName(part.tool);
    return toolName === 'task' || toolName === 'todowrite' || toolName === 'todoread';
};

const entryFromToolPart = (part: ToolPart): TaskSummaryEntry => {
    const state = part.state as { status?: unknown; title?: unknown; input?: unknown; error?: unknown } | undefined;
    return {
        id: part.id,
        tool: part.tool,
        state: {
            status: typeof state?.status === 'string' ? state.status : undefined,
            title: typeof state?.title === 'string' ? state.title : undefined,
            error: typeof state?.error === 'string' ? state.error : undefined,
            input: isRecord(state?.input) ? state.input : undefined,
        },
    };
};

const stableActivityId = (messageId: string, part: Part, partIndex: number): string => {
    const suppliedId = normalizeText(part.id);
    return `${messageId}:${partIndex}${suppliedId ? `:${suppliedId}` : ''}`;
};

const projectLiveRows = (taskPartId: string, messages: MessageRecord[]): TaskSummaryRow[] => {
    const rows: TaskSummaryRow[] = [];
    const segment: TurnActivityRecord[] = [];

    const flush = () => {
        if (segment.length === 0) return;
        for (const row of projectToolSegmentRows(segment)) {
            if (row.type === 'context-tool-group') {
                rows.push({
                    type: 'context-tool-group',
                    key: `task-summary:${taskPartId}:${row.key}`,
                    status: row.status,
                    counts: row.counts,
                    children: row.children,
                    activityCount: row.activities.length,
                    renderSignature: row.renderSignature,
                });
                continue;
            }

            const part = row.activity.part as ToolPart;
            const entry = presentEntry(entryFromToolPart(part));
            rows.push({
                type: 'task-entry',
                key: `task-summary:${taskPartId}:entry:${row.activity.id}`,
                entry,
                activityCount: 1,
                renderSignature: getEntryPresentationSignature(entry),
            });
        }
        segment.length = 0;
    };

    for (const message of messages) {
        if (message.info.role !== 'assistant') {
            flush();
            continue;
        }
        for (const [partIndex, part] of (message.parts ?? []).entries()) {
            if (isHiddenTaskSeparator(part)) {
                flush();
                continue;
            }

            if (part.type !== 'tool') continue;
            const id = stableActivityId(message.info.id, part, partIndex);
            segment.push({
                id,
                turnId: taskPartId,
                messageId: message.info.id,
                partIndex,
                kind: 'tool',
                part,
            });
        }
    }
    flush();
    return rows;
};

const projectFallbackRows = (taskPartId: string, entries: TaskSummaryEntry[]): TaskSummaryRow[] => entries.map((rawEntry, index) => {
    const entry = presentEntry(rawEntry);
    return {
        type: 'task-entry',
        key: getFallbackKey(taskPartId, rawEntry, index),
        entry,
        activityCount: 1,
        renderSignature: getEntryPresentationSignature(entry),
    };
});

export function projectTaskSummary({
    taskPartId,
    childSessionMessages,
    fallbackEntries,
    expanded,
}: ProjectTaskSummaryInput): TaskSummaryProjection {
    const liveRows = projectLiveRows(taskPartId, childSessionMessages);
    const allRows = liveRows.length > 0 ? liveRows : projectFallbackRows(taskPartId, normalizeFallbackEntries(fallbackEntries));
    const rows = expanded ? allRows : allRows.slice(-6);
    const hiddenRows = expanded ? [] : allRows.slice(0, allRows.length - rows.length);
    const hiddenActionCount = hiddenRows.reduce((count, row) => count + row.activityCount, 0);

    return {
        rows,
        hiddenActionCount,
        renderSignature: allRows.map((row) => `${row.key}\u0002${row.renderSignature}`).join('\u0000'),
    };
}
