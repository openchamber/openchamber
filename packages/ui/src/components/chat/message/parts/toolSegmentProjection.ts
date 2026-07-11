import type { ToolPart } from '@opencode-ai/sdk/v2';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { getContextToolSummaryKind, isExpandableTool, isStandaloneTool, isStaticTool } from './toolRenderUtils';
import type { ContextToolSummaryKind } from './toolRenderUtils';

export type ContextToolGroupStatus = 'active' | 'error' | 'done';

export type ContextToolCounts = Record<ContextToolSummaryKind, number>;

export type ContextToolChildState = 'active' | 'error' | 'done';

export interface ContextToolChildRow {
    id: string;
    kind: ContextToolSummaryKind;
    state: ContextToolChildState;
    hint: string;
}

export type ToolSegmentRow =
    | {
        type: 'context-tool-group';
        key: string;
        activities: TurnActivityRecord[];
        status: ContextToolGroupStatus;
        counts: ContextToolCounts;
        children: ContextToolChildRow[];
        renderSignature: string;
    }
    | {
        type: 'tool-expandable';
        key: string;
        activity: TurnActivityRecord;
        renderSignature: string;
    }
    | {
        type: 'tool-static';
        key: string;
        activity: TurnActivityRecord;
        toolName: string;
        renderSignature: string;
    };

const ERROR_STATUSES = new Set(['error', 'failed', 'aborted', 'timeout', 'cancelled']);
const ACTIVE_STATUSES = new Set(['pending', 'running', 'started']);
const CONTEXT_HINT_KEYS = ['filePath', 'file_path', 'path', 'offset', 'line', 'pattern', 'query', 'include', 'dir', 'directory'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const getToolPart = (activity: TurnActivityRecord): ToolPart | null => {
    if (activity.kind !== 'tool' || activity.part.type !== 'tool') {
        return null;
    }
    return activity.part;
};

const getToolName = (activity: TurnActivityRecord): string => {
    return getToolPart(activity)?.tool?.trim().toLowerCase() ?? '';
};

const getToolStatus = (activity: TurnActivityRecord): string => {
    const status = getToolPart(activity)?.state?.status;
    return typeof status === 'string' ? status.trim().toLowerCase() : '';
};

const getToolStateRecords = (activity: TurnActivityRecord): { input?: Record<string, unknown>; metadata?: Record<string, unknown> } => {
    const state = getToolPart(activity)?.state as { input?: unknown; metadata?: unknown } | undefined;
    return {
        input: isRecord(state?.input) ? state.input : undefined,
        metadata: isRecord(state?.metadata) ? state.metadata : undefined,
    };
};

const formatSignatureValue = (value: unknown): string => {
    if (value === null || typeof value === 'undefined') {
        return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
};

const firstString = (...values: unknown[]): string | null => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
};

const getDisplayTail = (value: string): string => {
    const normalized = value.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.at(-1) ?? normalized;
};

const getContextHint = (activity: TurnActivityRecord): string => {
    const toolName = getToolName(activity);
    const { input, metadata } = getToolStateRecords(activity);

    if (toolName === 'read') {
        const path = firstString(input?.filePath, input?.file_path, input?.path, metadata?.filePath, metadata?.file_path, metadata?.path);
        return path ? getDisplayTail(path) : 'read';
    }

    if (toolName === 'grep' || toolName === 'search') {
        const pattern = firstString(input?.pattern, metadata?.pattern, input?.query, metadata?.query);
        const include = firstString(input?.include, metadata?.include);
        const path = firstString(input?.path, input?.directory, metadata?.path, metadata?.directory);
        return [pattern, include, path].filter(Boolean).join(' · ') || toolName;
    }

    if (toolName === 'glob') {
        return firstString(input?.pattern, metadata?.pattern) ?? 'glob';
    }

    if (toolName === 'list') {
        const path = firstString(input?.path, input?.dir, input?.directory, metadata?.path, metadata?.dir, metadata?.directory);
        return path ? getDisplayTail(path) : 'list';
    }

    return toolName || 'tool';
};

const getToolHintSignature = (activity: TurnActivityRecord): string => {
    const { input, metadata } = getToolStateRecords(activity);
    const values: string[] = [];
    for (const key of CONTEXT_HINT_KEYS) {
        values.push(`${key}=${formatSignatureValue(input?.[key])}`);
        values.push(`metadata.${key}=${formatSignatureValue(metadata?.[key])}`);
    }
    return values.join(';');
};

const isActivityActive = (activity: TurnActivityRecord): boolean => {
    const status = getToolStatus(activity);
    if (ERROR_STATUSES.has(status) || status === 'completed') {
        return false;
    }
    if (ACTIVE_STATUSES.has(status)) {
        return true;
    }
    return typeof activity.endedAt !== 'number';
};

const getGroupStatus = (activities: TurnActivityRecord[]): ContextToolGroupStatus => {
    let hasActive = false;
    for (const activity of activities) {
        const status = getToolStatus(activity);
        if (ERROR_STATUSES.has(status)) {
            return 'error';
        }
        if (isActivityActive(activity)) {
            hasActive = true;
        }
    }
    return hasActive ? 'active' : 'done';
};

const getChildState = (activity: TurnActivityRecord): ContextToolChildState => {
    const status = getToolStatus(activity);
    if (ERROR_STATUSES.has(status)) {
        return 'error';
    }
    if (isActivityActive(activity)) {
        return 'active';
    }
    return 'done';
};

const getContextChildRow = (activity: TurnActivityRecord): ContextToolChildRow | null => {
    const kind = getContextToolSummaryKind(getToolName(activity));
    if (!kind) {
        return null;
    }
    return {
        id: activity.id,
        kind,
        state: getChildState(activity),
        hint: getContextHint(activity),
    };
};

const getContextChildren = (activities: TurnActivityRecord[]): ContextToolChildRow[] => {
    return activities.flatMap((activity) => {
        const child = getContextChildRow(activity);
        return child ? [child] : [];
    });
};

const getCounts = (activities: TurnActivityRecord[]): ContextToolCounts => {
    const counts: ContextToolCounts = { read: 0, search: 0, list: 0 };
    for (const activity of activities) {
        const kind = getContextToolSummaryKind(getToolName(activity));
        if (kind) {
            counts[kind] += 1;
        }
    }
    return counts;
};

const getActivityRenderSignature = (activity: TurnActivityRecord): string => {
    const toolName = getToolName(activity);
    const status = getToolStatus(activity);
    return `${activity.id}:${toolName}:${status}:${activity.endedAt ?? 'open'}:${getToolHintSignature(activity)}`;
};

const getSingleToolRenderSignature = (type: 'tool-expandable' | 'tool-static', activity: TurnActivityRecord): string => {
    return `${type}:${getActivityRenderSignature(activity)}`;
};

const flushContextRun = (rows: ToolSegmentRow[], contextRun: TurnActivityRecord[]): void => {
    if (contextRun.length === 0) {
        return;
    }

    if (contextRun.length === 1) {
        const activity = contextRun[0];
        const toolName = getToolName(activity);
        if (isStaticTool(toolName)) {
            rows.push({
                type: 'tool-static',
                key: `static-${toolName}:${activity.id}`,
                activity,
                toolName,
                renderSignature: getSingleToolRenderSignature('tool-static', activity),
            });
        } else {
            rows.push({
                type: 'tool-expandable',
                key: `tool:${activity.id}`,
                activity,
                renderSignature: getSingleToolRenderSignature('tool-expandable', activity),
            });
        }
        contextRun.length = 0;
        return;
    }

    const firstId = contextRun[0].id;
    const status = getGroupStatus(contextRun);
    const counts = getCounts(contextRun);
    const children = getContextChildren(contextRun);
    const childSignature = contextRun.map(getActivityRenderSignature).join('|');
    rows.push({
        type: 'context-tool-group',
        key: `context-tool-group:${firstId}`,
        activities: [...contextRun],
        status,
        counts,
        children,
        renderSignature: `context-tool-group:${firstId}:${status}:read=${counts.read}:search=${counts.search}:list=${counts.list}:${childSignature}`,
    });
    contextRun.length = 0;
};

export function projectToolSegmentRows(activities: TurnActivityRecord[]): ToolSegmentRow[] {
    const rows: ToolSegmentRow[] = [];
    const contextRun: TurnActivityRecord[] = [];

    for (const activity of activities) {
        const toolName = getToolName(activity);
        const contextKind = getContextToolSummaryKind(toolName);
        if (contextKind) {
            contextRun.push(activity);
            continue;
        }

        flushContextRun(rows, contextRun);

        if (!getToolPart(activity)) {
            continue;
        }

        if (isStandaloneTool(toolName)) {
            continue;
        }

        if (isExpandableTool(toolName)) {
            rows.push({
                type: 'tool-expandable',
                key: `tool:${activity.id}`,
                activity,
                renderSignature: getSingleToolRenderSignature('tool-expandable', activity),
            });
            continue;
        }

        if (isStaticTool(toolName)) {
            rows.push({
                type: 'tool-static',
                key: `static-${toolName}:${activity.id}`,
                activity,
                toolName,
                renderSignature: getSingleToolRenderSignature('tool-static', activity),
            });
            continue;
        }
    }

    flushContextRun(rows, contextRun);
    return rows;
}
