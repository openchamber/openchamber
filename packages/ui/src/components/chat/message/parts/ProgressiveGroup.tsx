import React from 'react';
import { RiStackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { getToolIcon } from './toolPresentation';
import { getToolMetadata } from '@/lib/toolHelpers';
import { getStaticGroupToolName, isExpandableTool, isStandaloneTool, isStaticTool } from './toolRenderUtils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import ReasoningPart from './ReasoningPart';
import JustificationBlock from './JustificationBlock';

interface DiffStats {
    additions: number;
    deletions: number;
    files: number;
}

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    isExpanded: boolean;
    collapsedPreviewCount?: number;
    onToggle: () => void;
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    animateRows?: boolean;
    animatedToolIds?: Set<string>;
    diffStats?: DiffStats;
}

const EDIT_LIKE_TOOL_NAMES = new Set<string>([
    'edit',
    'multiedit',
    'apply_patch',
    'str_replace',
    'str_replace_based_edit_tool',
]);

const isEditLikeTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && EDIT_LIKE_TOOL_NAMES.has(toolName.toLowerCase());
};

const parseDiffCounts = (diffText: string): { added: number; removed: number } => {
    const lines = diffText.split('\n');
    let added = 0;
    let removed = 0;

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
        if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }

    return { added, removed };
};

type FileDiffAggregate = { filePath: string; added: number; removed: number };

const aggregateFileDiffs = (parts: TurnActivityPart[]): FileDiffAggregate[] => {
    const byPath = new Map<string, { added: number; removed: number }>();

    const addToPath = (filePath: string, added: number, removed: number) => {
        if (!filePath) return;
        const current = byPath.get(filePath) ?? { added: 0, removed: 0 };
        current.added += Math.max(0, added);
        current.removed += Math.max(0, removed);
        byPath.set(filePath, current);
    };

    for (const activity of parts) {
        if (activity.kind !== 'tool') continue;
        const toolPart = activity.part as ToolPartType;
        if (!isEditLikeTool(toolPart.tool)) continue;

        const state = toolPart.state as { metadata?: Record<string, unknown>; input?: Record<string, unknown> } | undefined;
        const metadata = state?.metadata;
        const input = state?.input;
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];

        if (files.length > 0) {
            for (const file of files) {
                if (!file || typeof file !== 'object') continue;
                const record = file as {
                    relativePath?: unknown;
                    filePath?: unknown;
                    path?: unknown;
                    additions?: unknown;
                    deletions?: unknown;
                    diff?: unknown;
                };

                const filePath =
                    (typeof record.relativePath === 'string' && record.relativePath) ||
                    (typeof record.filePath === 'string' && record.filePath) ||
                    (typeof record.path === 'string' && record.path) ||
                    '';

                const explicitAdditions = typeof record.additions === 'number' ? record.additions : null;
                const explicitDeletions = typeof record.deletions === 'number' ? record.deletions : null;

                if (explicitAdditions !== null || explicitDeletions !== null) {
                    addToPath(filePath, explicitAdditions ?? 0, explicitDeletions ?? 0);
                    continue;
                }

                if (typeof record.diff === 'string' && record.diff.trim().length > 0) {
                    const counts = parseDiffCounts(record.diff);
                    addToPath(filePath, counts.added, counts.removed);
                }
            }
            continue;
        }

        const fallbackPath =
            (typeof input?.filePath === 'string' && input.filePath) ||
            (typeof input?.file_path === 'string' && input.file_path) ||
            (typeof input?.path === 'string' && input.path) ||
            '';

        if (typeof metadata?.diff === 'string' && metadata.diff.trim().length > 0) {
            const counts = parseDiffCounts(metadata.diff);
            addToPath(fallbackPath || 'Diff', counts.added, counts.removed);
        }
    }

    return Array.from(byPath.entries())
        .map(([filePath, counts]) => ({ filePath, added: counts.added, removed: counts.removed }))
        .filter((entry) => entry.added > 0 || entry.removed > 0)
        .sort((a, b) => {
            const aChanges = a.added + a.removed;
            const bChanges = b.added + b.removed;
            if (aChanges !== bChanges) return bChanges - aChanges;
            return a.filePath.localeCompare(b.filePath);
        });
};

const toDisplayFileName = (filePath: string): string => {
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return normalized;
    return segments[segments.length - 1];
};

const isActivityRunning = (activity: TurnActivityPart): boolean => {
    if (activity.kind !== 'tool') return false;
    const part = activity.part as ToolPartType;
    const status = (part.state?.status as string) || undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    if (isFinalized) {
        return false;
    }
    if (status === 'running' || status === 'pending' || status === 'started') {
        return true;
    }
    return typeof activity.endedAt !== 'number';
};

/**
 * Parts arrive in correct chronological order:
 * messages in sequence, parts within each message in their natural LLM
 * production order. No re-sorting needed — time-based sorting breaks this
 * because text parts get time.end = message completion time (later than
 * tools), pushing text after tools within the same message.
 */
const sortPartsByTime = (parts: TurnActivityPart[]): TurnActivityPart[] => parts;

/**
 * Extract a short filename from a tool part's input (for aggregation display).
 */
const getToolFileName = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    return null;
};

const getToolFilePath = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null;
};

const toTodoStatusKey = (value: unknown): 'pending' | 'in_progress' | 'completed' | 'cancelled' | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'in_progress' || normalized === 'in progress' || normalized === 'inprogress') return 'in_progress';
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return null;
};

const formatTodoSummary = (todos: unknown[]): string | null => {
    if (todos.length === 0) {
        return null;
    }

    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let cancelled = 0;

    for (const todo of todos) {
        if (!todo || typeof todo !== 'object') {
            continue;
        }
        const status = toTodoStatusKey((todo as { status?: unknown }).status);
        if (!status) {
            continue;
        }
        if (status === 'pending') pending += 1;
        if (status === 'in_progress') inProgress += 1;
        if (status === 'completed') completed += 1;
        if (status === 'cancelled') cancelled += 1;
    }

    const total = pending + inProgress + completed + cancelled;
    if (total === 0) {
        return null;
    }

    if (completed === total) {
        return `All ${total} tasks done`;
    }

    const parts: string[] = [];
    if (inProgress > 0) parts.push(`${inProgress} in progress`);
    if (pending > 0) parts.push(`${pending} pending`);
    if (completed > 0) parts.push(`${completed} done`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);

    return parts.length > 0 ? parts.join(', ') : null;
};

const getTodoSummaryFromActivity = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; output?: unknown } | undefined;
    const input = state?.input;
    const output = state?.output;

    if (Array.isArray(input?.todos)) {
        const summary = formatTodoSummary(input.todos);
        if (summary) return summary;
    }

    if (Array.isArray(output)) {
        const summary = formatTodoSummary(output);
        if (summary) return summary;
    }

    if (output && typeof output === 'object' && Array.isArray((output as { todos?: unknown }).todos)) {
        const summary = formatTodoSummary((output as { todos: unknown[] }).todos);
        if (summary) return summary;
    }

    if (typeof output === 'string' && output.trim().length > 0) {
        try {
            const parsed = JSON.parse(output) as unknown;
            if (Array.isArray(parsed)) {
                const summary = formatTodoSummary(parsed);
                if (summary) return summary;
            }
            if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { todos?: unknown }).todos)) {
                const summary = formatTodoSummary((parsed as { todos: unknown[] }).todos);
                if (summary) return summary;
            }
        } catch {
            // Ignore non-JSON output.
        }
    }

    return null;
};

const getToolReadOffset = (activity: TurnActivityPart): number | undefined => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const rawOffset =
        (typeof input?.offset === 'number' && Number.isFinite(input.offset) ? input.offset : undefined)
        ?? (typeof input?.line === 'number' && Number.isFinite(input.line) ? input.line : undefined)
        ?? (typeof metadata?.offset === 'number' && Number.isFinite(metadata.offset) ? metadata.offset : undefined)
        ?? (typeof metadata?.line === 'number' && Number.isFinite(metadata.line) ? metadata.line : undefined);

    if (typeof rawOffset !== 'number' || rawOffset <= 0) {
        return undefined;
    }

    return Math.floor(rawOffset);
};

const normalizePathValue = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    return trimmed.replace(/\\/g, '/');
};

const resolveAbsolutePath = (currentDirectory: string, filePath: string): string => {
    const normalizedPath = normalizePathValue(filePath);
    if (!normalizedPath) {
        return '';
    }
    if (normalizedPath.startsWith('/')) {
        return normalizedPath;
    }
    const normalizedDirectory = normalizePathValue(currentDirectory);
    if (!normalizedDirectory) {
        return normalizedPath;
    }
    return normalizedDirectory.endsWith('/') ? `${normalizedDirectory}${normalizedPath}` : `${normalizedDirectory}/${normalizedPath}`;
};

const getContextDirectoryForPath = (currentDirectory: string, absolutePath: string): string => {
    const normalizedDirectory = normalizePathValue(currentDirectory);
    if (normalizedDirectory) {
        return normalizedDirectory;
    }

    const normalizedPath = normalizePathValue(absolutePath);
    if (!normalizedPath) {
        return '';
    }
    const parent = normalizedPath.replace(/\/[^/]*$/, '');
    return parent || normalizedPath;
};

/**
 * Get a short description for a static tool (for aggregation display).
 */
const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const toolName = part.tool?.toLowerCase() ?? '';
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    // For search tools, show pattern
    if (toolName === 'grep' || toolName === 'search' || toolName === 'find' || toolName === 'ripgrep') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For glob, show pattern
    if (toolName === 'glob') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For web search tools, show query
    if (toolName === 'websearch' || toolName === 'web-search' || toolName === 'search_web' || toolName === 'codesearch' || toolName === 'perplexity') {
        const query = input?.query;
        if (typeof query === 'string' && query.trim().length > 0) {
            return query.length > 50 ? query.slice(0, 50) + '...' : query;
        }
    }

    // For skill, show name
    if (toolName === 'skill') {
        const name = input?.name;
        if (typeof name === 'string' && name.trim().length > 0) {
            return name;
        }
    }

    // For fetch-url tools, show URL
    if (toolName === 'webfetch' || toolName === 'fetch' || toolName === 'curl' || toolName === 'wget') {
        const url =
            (typeof input?.url === 'string' && input.url) ||
            (typeof input?.URL === 'string' && input.URL) ||
            (typeof metadata?.url === 'string' && metadata.url) ||
            (typeof metadata?.URL === 'string' && metadata.URL) ||
            '';

        if (typeof url === 'string' && url.trim().length > 0) {
            return url.trim();
        }
    }

    // For todo tools, show status summary without task names
    if (toolName === 'todowrite' || toolName === 'todoread') {
        return getTodoSummaryFromActivity(activity);
    }

    // Fallback: try filename
    return getToolFileName(activity);
};

type AggregatedRow =
    | { type: 'tool-expandable'; activity: TurnActivityPart }
    | { type: 'tool-static-group'; toolName: string; activities: TurnActivityPart[] }
    | { type: 'reasoning'; activity: TurnActivityPart }
    | { type: 'justification'; activity: TurnActivityPart }
    | { type: 'tool-fallback'; activity: TurnActivityPart };

/**
 * Aggregate sorted activity parts into display rows.
 * Consecutive static tools of the same type are merged into a single row.
 * Reasoning/justification become inline text.
 * Expandable tools (edit, bash, write, question) stay as individual rows.
 * Unknown tools stay as individual expandable rows (fallback).
 */
const aggregateRows = (parts: TurnActivityPart[]): AggregatedRow[] => {
    const rows: AggregatedRow[] = [];

    let i = 0;
    while (i < parts.length) {
        const activity = parts[i];

        if (activity.kind === 'reasoning') {
            rows.push({ type: 'reasoning', activity });
            i++;
            continue;
        }

        if (activity.kind === 'justification') {
            rows.push({ type: 'justification', activity });
            i++;
            continue;
        }

        // Tool part
        const toolPart = activity.part as ToolPartType;
        const toolName = toolPart.tool?.toLowerCase() ?? '';

        if (isStandaloneTool(toolName)) {
            // Standalone tools are rendered separately, skip
            i++;
            continue;
        }

        if (isExpandableTool(toolName)) {
            rows.push({ type: 'tool-expandable', activity });
            i++;
            continue;
        }

        if (isStaticTool(toolName)) {
            // Aggregate consecutive static tools of the same name
            const groupedToolName = getStaticGroupToolName(toolName);
            const group: TurnActivityPart[] = [activity];
            let j = i + 1;
            while (j < parts.length) {
                const next = parts[j];
                if (next.kind !== 'tool') break;
                const nextTool = (next.part as ToolPartType).tool?.toLowerCase() ?? '';
                if (getStaticGroupToolName(nextTool) !== groupedToolName) break;
                group.push(next);
                j++;
            }
            rows.push({ type: 'tool-static-group', toolName: groupedToolName, activities: group });
            i = j;
            continue;
        }

        // Unknown/fallback tool — keep as expandable
        rows.push({ type: 'tool-fallback', activity });
        i++;
    }

    return rows;
};

/**
 * Render a static aggregated tool row.
 * Shows: [icon] DisplayName file1.tsx file2.tsx ...
 */
export const StaticToolRow: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
}> = ({ toolName, activities, animateTailText }) => {
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const displayName = getToolMetadata(toolName).displayName;
    const icon = getToolIcon(toolName);
    const isReadGroup = toolName.toLowerCase() === 'read';
    const runtime = React.useContext(RuntimeAPIContext);
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);

    const descriptions = React.useMemo(() => {
        const descs: string[] = [];
        for (const activity of activities) {
            const desc = getToolShortDescription(activity);
            if (desc && !descs.includes(desc)) {
                descs.push(desc);
            }
        }
        return descs;
    }, [activities]);

    const readFileEntries = React.useMemo(() => {
        if (!isReadGroup) return [] as Array<{ path: string; name: string; offset?: number }>;

        const entries: Array<{ path: string; name: string; offset?: number }> = [];
        for (const activity of activities) {
            const filePath = getToolFilePath(activity);
            const fileName = getToolFileName(activity);
            const offset = getToolReadOffset(activity);
            if (!filePath || !fileName) continue;
            if (entries.some((entry) => entry.path === filePath)) continue;
            entries.push({ path: filePath, name: fileName, offset });
        }
        return entries;
    }, [activities, isReadGroup]);

    const handleReadFileClick = React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = resolveAbsolutePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getContextDirectoryForPath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    }, [currentDirectory, runtime]);

    const isSearchGroup = toolName.toLowerCase() === 'grep';
    const isFetchGroup = toolName.toLowerCase() === 'webfetch' || toolName.toLowerCase() === 'fetch' || toolName.toLowerCase() === 'curl' || toolName.toLowerCase() === 'wget';

    return (
        <div
            className={cn(
                'flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-px py-1.5 rounded-xl'
            )}
        >
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className="typography-meta leading-5 font-medium inline-flex h-5 items-center flex-shrink-0 opacity-85"
                style={{ color: 'var(--tools-title)' }}
                title={displayName}
            >
                {displayName}
            </MinDurationShineText>
            {isReadGroup && readFileEntries.length > 0
                ? readFileEntries.map((entry) => (
                    <button
                        key={entry.path}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleReadFileClick(entry.path, entry.offset);
                        }}
                        className="inline-flex items-center gap-1 min-w-0 max-w-full typography-meta leading-5 hover:opacity-90"
                        style={{ color: 'var(--tools-title)' }}
                        title={entry.offset ? `${entry.path}:${entry.offset}` : entry.path}
                    >
                        {showToolFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                        <Text
                            variant={animateTailText ? 'generate-effect' : undefined}
                            className="min-w-0 max-w-full truncate typography-meta leading-5"
                            style={{ color: 'var(--tools-title)' }}
                            title={entry.path}
                        >
                            {entry.name}
                        </Text>
                    </button>
                ))
                : null}
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0 max-w-full">
                        <Text
                            variant={animateTailText ? 'generate-effect' : undefined}
                            className="min-w-0 max-w-full truncate typography-meta leading-5"
                            style={{ color: 'var(--tools-description)' }}
                            title={desc}
                        >
                            "{desc}"
                        </Text>
                    </span>
                ))
                : null}
            {isFetchGroup && descriptions.length > 0
                ? descriptions.map((url, index) => (
                    <a
                        key={`${url}-${index}`}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            'min-w-0 max-w-full underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            'truncate max-w-[20rem] typography-meta'
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        {url}
                    </a>
                ))
                : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : undefined}
                    className="min-w-0 max-w-full truncate typography-meta leading-5"
                    style={{ color: 'var(--tools-description)' }}
                >
                    {descriptions.join(' ')}
                </Text>
            ) : null}
        </div>
    );
};

/**
 * Inline reasoning text block — rendered as dimmed italic markdown.
 */
const InlineReasoningBlock: React.FC<{
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
}> = ({ activity, onContentChange }) => {
    return (
        <ReasoningPart
            part={activity.part}
            messageId={activity.messageId}
            onContentChange={onContentChange}
        />
    );
};

/**
 * Inline justification text block — rendered as normal assistant text between tools.
 */
const InlineJustificationBlock: React.FC<{
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
}> = ({ activity, onContentChange }) => {
    return (
        <JustificationBlock
            part={activity.part}
            messageId={activity.messageId}
            onContentChange={onContentChange}
        />
    );
};

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    isExpanded,
    collapsedPreviewCount = 0,
    onToggle,
    syntaxTheme,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    streamPhase: _streamPhase,
    showHeader,
    animateRows = true,
    animatedToolIds,
}) => {
    void _streamPhase;
    const previewCount = showHeader && !isExpanded
        ? Math.max(0, Math.floor(collapsedPreviewCount))
        : 0;
    const shouldRenderRows = !showHeader || isExpanded || previewCount > 0;

    const sortedParts = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as TurnActivityPart[];
        }
        return sortPartsByTime(parts);
    }, [parts, shouldRenderRows]);

    const rows = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as AggregatedRow[];
        }
        return aggregateRows(sortedParts);
    }, [shouldRenderRows, sortedParts]);

    const previewHiddenCount = React.useMemo(() => {
        if (isExpanded || previewCount === 0) {
            return 0;
        }
        return Math.max(0, rows.length - previewCount);
    }, [isExpanded, previewCount, rows.length]);

    const visibleRows = React.useMemo(() => {
        if (isExpanded || previewCount === 0) {
            return rows;
        }
        return rows.slice(-previewCount);
    }, [isExpanded, previewCount, rows]);

    const toolCount = React.useMemo(
        () => parts.filter((activity) => activity.kind === 'tool').length,
        [parts]
    );

    const aggregatedFileDiffs = React.useMemo(() => aggregateFileDiffs(parts), [parts]);

    const hasToolMetric = toolCount > 0;
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);

    if (shouldRenderRows && rows.length === 0) {
        return null;
    }

    const wrapRow = (key: string, content: React.ReactNode) => {
        if (!animateRows) {
            return <React.Fragment key={key}>{content}</React.Fragment>;
        }
        return <FadeInOnReveal key={key}>{content}</FadeInOnReveal>;
    };

    const renderToolRow = (key: string, content: React.ReactNode, animate: boolean) => {
        if (!animate) {
            return wrapRow(key, content);
        }
        return wrapRow(
            key,
            <ToolRevealOnMount animate={true} wipe>
                {content}
            </ToolRevealOnMount>
        );
    };

    const renderedRows = shouldRenderRows
        ? visibleRows.map((row, index) => {
        switch (row.type) {
            case 'reasoning':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineReasoningBlock
                            activity={row.activity}
                            onContentChange={onContentChange}
                        />
                    </>
                );

            case 'justification':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineJustificationBlock
                            activity={row.activity}
                            onContentChange={onContentChange}
                        />
                    </>
                );

            case 'tool-expandable':
                return renderToolRow(
                    row.activity.id,
                    <>
                        <ToolPart
                            part={row.activity.part as ToolPartType}
                            isExpanded={expandedTools.has(row.activity.id)}
                            onToggle={() => onToggleTool(row.activity.id)}
                            syntaxTheme={syntaxTheme}
                            isMobile={isMobile}
                            onContentChange={onContentChange}
                            onShowPopup={onShowPopup}
                            animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        />
                    </>,
                    Boolean(animatedToolIds?.has(row.activity.id))
                );

            case 'tool-static-group':
                return renderToolRow(
                    `static-${row.toolName}-${row.activities[0]?.id ?? index}`,
                    <>
                        <StaticToolRow
                            toolName={row.toolName}
                            activities={row.activities}
                            animateTailText={row.activities.some((activity) => animatedToolIds?.has(activity.id))}
                        />
                    </>,
                    row.activities.some((activity) => animatedToolIds?.has(activity.id))
                );

            case 'tool-fallback':
                return renderToolRow(
                    row.activity.id,
                    <>
                        <ToolPart
                            part={row.activity.part as ToolPartType}
                            isExpanded={expandedTools.has(row.activity.id)}
                            onToggle={() => onToggleTool(row.activity.id)}
                            syntaxTheme={syntaxTheme}
                            isMobile={isMobile}
                            onContentChange={onContentChange}
                            onShowPopup={onShowPopup}
                            animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        />
                    </>,
                    Boolean(animatedToolIds?.has(row.activity.id))
                );

            default:
                return null;
        }
    })
        : null;

    const shouldShowRowsContainer = isExpanded || visibleRows.length > 0;

    if (!showHeader) {
        return (
            <FadeInOnReveal>
                <div className="my-1">{renderedRows}</div>
            </FadeInOnReveal>
        );
    }

    return (
        <FadeInOnReveal>
            <div className="my-1">
                <button
                    type="button"
                    className="group/tool flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-px py-1.5 rounded-xl text-left"
                    onClick={onToggle}
                >
                    <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <RiStackLine className="h-3.5 w-3.5" />
                    </span>
                    <span className="typography-meta leading-5 font-medium inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-title)' }}>
                        Activity
                    </span>
                    {hasToolMetric ? (
                        <span className="typography-meta leading-5 text-muted-foreground/80 flex-shrink-0">
                            {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
                        </span>
                    ) : null}
                    {aggregatedFileDiffs.map((entry, index) => (
                        <span
                            key={`${entry.filePath}-${index}`}
                            className="inline-flex min-w-0 max-w-full items-center gap-1 typography-meta leading-5 text-muted-foreground/80"
                        >
                            {showToolFileIcons ? <FileTypeIcon filePath={entry.filePath} className="h-3.5 w-3.5" /> : null}
                            <span className={cn('truncate', isMobile ? 'max-w-[9rem]' : 'max-w-[12rem]')} style={{ color: 'var(--tools-description)' }} title={entry.filePath}>
                                {toDisplayFileName(entry.filePath)}
                            </span>
                            <span className="flex-shrink-0 inline-flex items-center gap-0 tabular-nums">
                                <span style={{ color: 'var(--status-success)' }}>+{entry.added}</span>
                                <span style={{ color: 'var(--tools-description)' }}>/</span>
                                <span style={{ color: 'var(--status-error)' }}>-{entry.removed}</span>
                            </span>
                        </span>
                    ))}
                </button>
                {shouldShowRowsContainer ? (
                    <div className="relative ml-2 pl-3">
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                            style={{ backgroundColor: 'var(--tools-border)' }}
                        />
                        {previewHiddenCount > 0 ? (
                            <button
                                type="button"
                                onClick={onToggle}
                                className="typography-meta leading-5 px-2 py-1 text-muted-foreground/45 hover:text-muted-foreground/65 text-left"
                            >
                                +{previewHiddenCount} more...
                            </button>
                        ) : null}
                        <div>{renderedRows}</div>
                    </div>
                ) : null}
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
