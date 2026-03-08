import React from 'react';
import { RiStackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import AssistantTextPart from './AssistantTextPart';
import { MinDurationShineText } from './MinDurationShineText';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { getToolIcon } from './ToolPart';
import { getToolMetadata } from '@/lib/toolHelpers';

interface DiffStats {
    additions: number;
    deletions: number;
    files: number;
}

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    isExpanded: boolean;
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
    diffStats?: DiffStats;
}

// Tools that remain fully expandable (edit, bash, task-like)
const EXPANDABLE_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_based_edit_tool',
    'bash', 'shell', 'cmd', 'terminal',
    'write', 'create', 'file_write',
    'question',
]);

// Tools that are standalone and rendered separately (not in progressive group flow)
const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const isExpandableTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && EXPANDABLE_TOOL_NAMES.has(toolName.toLowerCase());
};

const isStandaloneTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && STANDALONE_TOOL_NAMES.has(toolName.toLowerCase());
};

const isStaticTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    return !isExpandableTool(toolName) && !isStandaloneTool(toolName);
};

const SEARCH_TOOL_NAMES = new Set<string>(['grep', 'search', 'find', 'ripgrep', 'glob']);

const getStaticGroupToolName = (toolName: string): string => {
    const normalized = toolName.toLowerCase();
    if (SEARCH_TOOL_NAMES.has(normalized)) {
        return 'grep';
    }
    return normalized;
};

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
    const rawStatus = (part.state as { status?: unknown } | undefined)?.status;
    const status =
        typeof rawStatus === 'string'
            ? rawStatus.toLowerCase().trim().replace(/[\s_-]+/g, '')
            : undefined;

    if (
        status === 'running' ||
        status === 'pending' ||
        status === 'started' ||
        status === 'inprogress' ||
        status === 'processing' ||
        status === 'executing'
    ) {
        return true;
    }

    if (
        status === 'completed' ||
        status === 'complete' ||
        status === 'error' ||
        status === 'failed' ||
        status === 'aborted' ||
        status === 'timeout' ||
        status === 'timedout' ||
        status === 'done' ||
        status === 'cancelled' ||
        status === 'canceled'
    ) {
        return false;
    }

    return typeof activity.endedAt !== 'number';
};

const sortPartsByTime = (parts: TurnActivityPart[]): TurnActivityPart[] => {
    return [...parts].sort((a, b) => {
        const aTime = typeof a.endedAt === 'number' ? a.endedAt : undefined;
        const bTime = typeof b.endedAt === 'number' ? b.endedAt : undefined;

        if (aTime === undefined && bTime === undefined) return 0;
        if (aTime === undefined) return 1;
        if (bTime === undefined) return -1;

        return aTime - bTime;
    });
};

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

    // For todowrite/todoread, no extra description needed
    if (toolName === 'todowrite' || toolName === 'todoread') {
        return null;
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
const StaticToolRow: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    isMobile: boolean;
    animateTailText: boolean;
}> = ({ toolName, activities, isMobile, animateTailText }) => {
    const displayName = getToolMetadata(toolName).displayName;
    const icon = getToolIcon(toolName);
    const isReadGroup = toolName.toLowerCase() === 'read';
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
        if (!isReadGroup) return [] as Array<{ path: string; name: string }>;

        const entries: Array<{ path: string; name: string }> = [];
        for (const activity of activities) {
            const filePath = getToolFilePath(activity);
            const fileName = getToolFileName(activity);
            if (!filePath || !fileName) continue;
            if (entries.some((entry) => entry.path === filePath)) continue;
            entries.push({ path: filePath, name: fileName });
        }
        return entries;
    }, [activities, isReadGroup]);

    const isSearchGroup = toolName.toLowerCase() === 'grep';
    const isFetchGroup = toolName.toLowerCase() === 'webfetch' || toolName.toLowerCase() === 'fetch' || toolName.toLowerCase() === 'curl' || toolName.toLowerCase() === 'wget';

    return (
        <div
            className={cn(
                'flex w-full flex-wrap items-center gap-x-2 gap-y-1 pr-2 pl-px py-1 rounded-xl'
            )}
        >
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className="typography-meta font-medium inline-flex h-5 items-center flex-shrink-0 opacity-85"
                style={{ color: 'var(--tools-title)' }}
                title={displayName}
            >
                {displayName}
            </MinDurationShineText>
            {isReadGroup && readFileEntries.length > 0
                ? readFileEntries.map((entry) => (
                    <span key={entry.path} className="inline-flex items-center gap-1 min-w-0 typography-meta" style={{ color: 'var(--tools-description)' }}>
                        <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" />
                        <Text
                            variant={animateTailText ? 'generate-effect' : undefined}
                            className={cn('min-w-0 typography-meta', isMobile ? 'break-words' : 'truncate')}
                            style={{ color: 'var(--tools-description)' }}
                            title={entry.path}
                        >
                            {entry.name}
                        </Text>
                    </span>
                ))
                : null}
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0">
                        <Text
                            variant={animateTailText ? 'generate-effect' : undefined}
                            className={cn('min-w-0 typography-meta', isMobile ? 'break-words' : 'truncate')}
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
                            'min-w-0 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            isMobile ? 'break-words' : 'truncate max-w-[20rem]'
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        <Text
                            variant={animateTailText ? 'generate-effect' : undefined}
                            className={cn('min-w-0 typography-meta', isMobile ? 'break-words' : 'truncate max-w-[20rem]')}
                            style={{ color: 'var(--status-info)' }}
                        >
                            {url}
                        </Text>
                    </a>
                ))
                : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : undefined}
                    className={cn('min-w-0 typography-meta', isMobile ? 'break-words' : 'truncate')}
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
    part: TurnActivityPart;
    streamPhase: StreamPhase;
    onContentChange?: (reason?: ContentChangeReason) => void;
}> = ({ part, streamPhase, onContentChange }) => {
    return (
        <AssistantTextPart
            part={part.part}
            messageId={part.messageId}
            streamPhase={streamPhase}
            onContentChange={onContentChange}
        />
    );
};

/**
 * Inline justification text block — rendered as normal assistant text between tools.
 */
const InlineJustificationBlock: React.FC<{
    part: TurnActivityPart;
    streamPhase: StreamPhase;
    onContentChange?: (reason?: ContentChangeReason) => void;
}> = ({ part, streamPhase, onContentChange }) => {
    return (
        <AssistantTextPart
            part={part.part}
            messageId={part.messageId}
            streamPhase={streamPhase}
            onContentChange={onContentChange}
        />
    );
};

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    isExpanded,
    onToggle,
    syntaxTheme,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    streamPhase,
    showHeader,
    animateRows = true,
}) => {
    const shouldRenderRows = !showHeader || isExpanded;

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

    const toolCount = React.useMemo(
        () => parts.filter((activity) => activity.kind === 'tool').length,
        [parts]
    );

    const aggregatedFileDiffs = React.useMemo(() => aggregateFileDiffs(parts), [parts]);

    const hasToolMetric = toolCount > 0;

    if (shouldRenderRows && rows.length === 0) {
        return null;
    }

    const wrapRow = (key: string, content: React.ReactNode) => {
        if (!animateRows) {
            return <React.Fragment key={key}>{content}</React.Fragment>;
        }
        return <FadeInOnReveal key={key}>{content}</FadeInOnReveal>;
    };

    const renderedRows = shouldRenderRows
        ? rows.map((row, index) => {
        switch (row.type) {
            case 'reasoning':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineReasoningBlock
                            part={row.activity}
                            streamPhase={streamPhase}
                            onContentChange={onContentChange}
                        />
                    </>
                );

            case 'justification':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineJustificationBlock
                            part={row.activity}
                            streamPhase={streamPhase}
                            onContentChange={onContentChange}
                        />
                    </>
                );

            case 'tool-expandable':
                return wrapRow(
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
                            animateTailText={animateRows}
                        />
                    </>
                );

            case 'tool-static-group':
                return wrapRow(
                    `static-${row.toolName}-${index}`,
                    <>
                        <StaticToolRow
                            toolName={row.toolName}
                            activities={row.activities}
                            isMobile={isMobile}
                            animateTailText={animateRows}
                        />
                    </>
                );

            case 'tool-fallback':
                return wrapRow(
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
                            animateTailText={animateRows}
                        />
                    </>
                );

            default:
                return null;
        }
    })
        : null;

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
                    className="group/tool flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-px pt-0 pb-1.5 rounded-xl text-left"
                    onClick={onToggle}
                >
                    <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <RiStackLine className="h-3.5 w-3.5" />
                    </span>
                    <span className="typography-meta font-medium inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-title)' }}>
                        Activity
                    </span>
                    {hasToolMetric ? (
                        <span className="typography-meta text-muted-foreground/70 flex-shrink-0">
                            {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
                        </span>
                    ) : null}
                    {aggregatedFileDiffs.map((entry, index) => (
                        <span
                            key={`${entry.filePath}-${index}`}
                            className="inline-flex min-w-0 items-center gap-1 typography-meta text-muted-foreground/70"
                        >
                            <FileTypeIcon filePath={entry.filePath} className="h-3.5 w-3.5" />
                            <span className="truncate max-w-[12rem]" style={{ color: 'var(--tools-title)' }} title={entry.filePath}>
                                {toDisplayFileName(entry.filePath)}
                            </span>
                            <span className="flex-shrink-0 inline-flex items-center gap-0">
                                <span style={{ color: 'var(--status-success)' }}>+{entry.added}</span>
                                <span style={{ color: 'var(--tools-description)' }}>/</span>
                                <span style={{ color: 'var(--status-error)' }}>-{entry.removed}</span>
                            </span>
                        </span>
                    ))}
                </button>
                {isExpanded ? renderedRows : null}
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
