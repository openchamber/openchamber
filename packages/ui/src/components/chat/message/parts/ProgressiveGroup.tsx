import React from 'react';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { Icon } from "@/components/icon/Icon";
import { FadeInOnReveal } from '../FadeInOnReveal';
import { getToolIcon } from './toolPresentation';
import { getToolMetadata } from '@/lib/toolHelpers';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import ReasoningPart from './ReasoningPart';
import JustificationBlock from './JustificationBlock';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { getExternalFaviconUrl } from '@/lib/url';
import { getDirectoryForFilePath, getRelativeFilePath, isFilePathWithinDirectory, normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';
import { ContextToolGroupRow } from './ContextToolGroupRow';
import { projectToolSegmentRows } from './toolSegmentProjection';
import type { ToolSegmentRow } from './toolSegmentProjection';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    isExpanded: boolean;
    collapsedPreviewCount?: number;
    onToggle: () => void;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    animateRows?: boolean;
    animatedToolIds?: Set<string>;
    renderJustificationActions?: (activity: TurnActivityPart) => React.ReactNode;
    showReasoningTraces?: boolean;
}

const ExternalLinkFavicon: React.FC<{ href: string }> = ({ href }) => {
    const [failed, setFailed] = React.useState(false);
    const faviconUrl = React.useMemo(() => getExternalFaviconUrl(href), [href]);

    if (!faviconUrl || failed) {
        return null;
    }

    return (
        <span className="inline-flex size-[18px] flex-shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)]">
            <img
                src={faviconUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="size-3.5 rounded-sm"
                onError={() => setFailed(true)}
            />
        </span>
    );
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

const getToolSkillDirectory = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { metadata?: Record<string, unknown> } | undefined;
    const dir = state?.metadata?.dir;

    return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
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
        return '0 tasks';
    }

    let pending = 0;
    let inProgress = 0;
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
    }

    const activeCount = pending + inProgress;
    if (activeCount === 0) {
        return '0 tasks';
    }

    return `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'}`;
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

const renderReadFilePath = (displayPath: string, animate = true) => {
    const lastSlash = displayPath.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                style={{ color: 'var(--tools-title)' }}
                title={displayPath}
            >
                {displayPath}
            </Text>
        );
    }

    const dir = displayPath.slice(0, lastSlash);
    const name = displayPath.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex max-w-full flex-1 items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS)} title={displayPath}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
            <span
                className="min-w-0 shrink truncate whitespace-nowrap"
                style={{
                    color: 'var(--tools-description)',
                    direction: 'rtl',
                    textAlign: 'left',
                    unicodeBidi: 'plaintext',
                }}
            >
                {displayDir}
            </span>
            <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className="flex-shrink-0"
                style={{ color: 'var(--tools-title)' }}
            >
                {name}
            </Text>
        </span>
    );
};

const resolveSkillFilePath = (skillPathOrDir: string): string => {
    const normalizedPath = normalizeFilePath(skillPathOrDir);
    if (!normalizedPath) {
        return '';
    }

    return normalizedPath.toLowerCase().endsWith('/skill.md') ? normalizedPath : `${normalizedPath}/SKILL.md`;
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
    | ToolSegmentRow
    | { type: 'reasoning'; activity: TurnActivityPart }
    | { type: 'justification'; activity: TurnActivityPart };

interface ExpandableToolRowProps {
    activity: TurnActivityPart;
    isExpanded: boolean;
    expandedTools: ReadonlySet<string>;
    isMobile: boolean;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    animateTailText: boolean;
    animateRows: boolean;
}

const ExpandableToolRow: React.FC<ExpandableToolRowProps> = ({
    activity,
    isExpanded,
    expandedTools,
    isMobile,
    onToggleTool,
    onShowPopup,
    onContentChange,
    animateTailText,
    animateRows,
}) => {
    const content = (
        <ToolPart
            part={activity.part as ToolPartType}
            isExpanded={isExpanded}
            expandedTools={expandedTools}
            onToggle={onToggleTool}
            isMobile={isMobile}
            onContentChange={onContentChange}
            onShowPopup={onShowPopup}
            animateTailText={animateTailText}
        />
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

const MemoExpandableToolRow = React.memo(ExpandableToolRow, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.expandedTools === next.expandedTools
        && prev.isMobile === next.isMobile
        && prev.onToggleTool === next.onToggleTool
        && prev.onShowPopup === next.onShowPopup
        && prev.onContentChange === next.onContentChange
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && prev.activity.id === next.activity.id
        && prev.activity.kind === next.activity.kind
        && prev.activity.endedAt === next.activity.endedAt
        && areRenderRelevantPartsEqual([prev.activity.part], [next.activity.part]);
});

interface StaticGroupedToolRowProps {
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
    animateRows: boolean;
}

const StaticGroupedToolRow: React.FC<StaticGroupedToolRowProps> = ({
    toolName,
    activities,
    animateTailText,
    animateRows,
}) => {
    const content = (
        <StaticToolRow
            toolName={toolName}
            activities={activities}
            animateTailText={animateTailText}
        />
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

const MemoStaticGroupedToolRow = React.memo(StaticGroupedToolRow, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && areActivityListsEqual(prev.activities, next.activities);
});

/**
 * Aggregate sorted activity parts into display rows.
 * Static tools are rendered as one row per call.
 * Reasoning/justification become inline text.
 * Expandable tools (edit, bash, write, question) stay as individual rows.
 * Unknown tools stay as individual expandable rows (fallback).
 */
const aggregateRows = (parts: TurnActivityPart[], showReasoningTraces: boolean): AggregatedRow[] => {
    const rows: AggregatedRow[] = [];
    const toolSegment: TurnActivityPart[] = [];

    const flushToolSegment = () => {
        if (toolSegment.length === 0) {
            return;
        }
        rows.push(...projectToolSegmentRows(toolSegment));
        toolSegment.length = 0;
    };

    for (const activity of parts) {
        if (activity.kind === 'reasoning') {
            flushToolSegment();
            if (showReasoningTraces) {
                rows.push({ type: 'reasoning', activity });
            }
            continue;
        }

        if (activity.kind === 'justification') {
            flushToolSegment();
            rows.push({ type: 'justification', activity });
            continue;
        }

        toolSegment.push(activity);
    }

    flushToolSegment();
    return rows;
};

/**
 * Render a static aggregated tool row.
 * Shows: [icon] DisplayName file1.tsx file2.tsx ...
 */
const areActivityListsEqual = (left: TurnActivityPart[], right: TurnActivityPart[]): boolean => {
    if (left === right) {
        return true;
    }

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        const leftActivity = left[index];
        const rightActivity = right[index];

        if (leftActivity.id !== rightActivity.id) {
            return false;
        }

        if (leftActivity.kind !== rightActivity.kind || leftActivity.endedAt !== rightActivity.endedAt) {
            return false;
        }

        if (!areRenderRelevantPartsEqual([leftActivity.part], [rightActivity.part])) {
            return false;
        }
    }

    return true;
};

const StaticToolRowInner: React.FC<{
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
    const skills = useSkillsStore((state) => state.skills);
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

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

    const skillEntries = React.useMemo(() => {
        if (toolName.toLowerCase() !== 'skill') return [] as Array<{ name: string; path: string }>;

        const entries: Array<{ name: string; path: string }> = [];
        for (const activity of activities) {
            const name = getToolShortDescription(activity);
            if (!name) continue;

            const skill = skillByName.get(name);
            const rawPath = skill?.path || getToolSkillDirectory(activity);
            const path = rawPath ? resolveSkillFilePath(rawPath) : '';
            if (!path || entries.some((entry) => entry.name === name && entry.path === path)) continue;
            entries.push({ name, path });
        }

        return entries;
    }, [activities, skillByName, toolName]);

    const readFileEntries = React.useMemo(() => {
        if (!isReadGroup) return [] as Array<{ path: string; displayPath: string; offset?: number }>;

        const entries: Array<{ path: string; displayPath: string; offset?: number }> = [];
        for (const activity of activities) {
            const filePath = getToolFilePath(activity);
            const offset = getToolReadOffset(activity);
            if (!filePath) continue;
            if (entries.some((entry) => entry.path === filePath)) continue;
            const displayPath = getRelativeFilePath(filePath, currentDirectory);
            if (!displayPath) continue;
            entries.push({ path: filePath, displayPath, offset });
        }
        return entries;
    }, [activities, currentDirectory, isReadGroup]);

    const handleReadFileClick = React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        if (!isFilePathWithinDirectory(absolutePath, currentDirectory)) {
            void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(() => {
                const uiStore = useUIStore.getState();
                const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
                if (offset && Number.isFinite(offset)) {
                    uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
                    return;
                }
                uiStore.openContextFile(contextDirectory, absolutePath);
            });
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    }, [currentDirectory, runtime]);

    const handleSkillClick = React.useCallback((skillPath: string) => {
        if (!skillPath) {
            return;
        }
        const uiStore = useUIStore.getState();
        uiStore.openContextFile(currentDirectory || getDirectoryForFilePath('', skillPath), skillPath);
    }, [currentDirectory]);

    const normalizedToolName = toolName.toLowerCase();
    const isSearchGroup = normalizedToolName === 'grep'
        || normalizedToolName === 'search'
        || normalizedToolName === 'find'
        || normalizedToolName === 'ripgrep'
        || normalizedToolName === 'glob';
    const isFetchGroup = normalizedToolName === 'webfetch' || normalizedToolName === 'fetch' || normalizedToolName === 'curl' || normalizedToolName === 'wget';
    const isSkillGroup = normalizedToolName === 'skill';

    return (
        <div
            className={cn(
                'flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0'
            )}
        >
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className={cn(TOOL_ROW_TITLE_CLASS, 'inline-flex items-center flex-shrink-0 opacity-85')}
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
                        className={cn('inline-flex !min-h-0 items-center justify-start gap-1 min-w-0 flex-1 text-left hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={entry.offset ? `${entry.displayPath}:${entry.offset}` : entry.displayPath}
                    >
                        {showToolFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                        {renderReadFilePath(entry.displayPath, animateTailText)}
                    </button>
                ))
                : null}
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0 flex-1">
                        <Text
                            variant={animateTailText ? 'generate-effect' : 'static'}
                            className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
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
                            'min-w-0 flex-1 inline-flex items-center gap-1.5 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            'truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        <ExternalLinkFavicon href={url} />
                        <span className="min-w-0 truncate">{url}</span>
                    </a>
                ))
                : null}
            {isSkillGroup && skillEntries.length > 0
                ? skillEntries.map((entry, index) => (
                    <button
                        key={`${entry.name}-${entry.path}-${index}`}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleSkillClick(entry.path);
                        }}
                        className={cn('!min-h-0 min-w-0 flex-1 truncate whitespace-nowrap text-left hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={entry.path}
                    >
                        {entry.name}
                    </button>
                ))
                : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && !isSkillGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                >
                    {descriptions.join(' ')}
                </Text>
            ) : null}
        </div>
    );
};

export const StaticToolRow = React.memo(StaticToolRowInner, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && areActivityListsEqual(prev.activities, next.activities);
});

/**
 * Inline reasoning text block — rendered as dimmed italic markdown.
 */
const InlineReasoningBlock = React.memo(({ activity, onContentChange, streamPhase }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
}) => {
    return (
        <ReasoningPart
            part={activity.part}
            messageId={activity.messageId}
            streamPhase={streamPhase}
            onContentChange={onContentChange}
        />
    );
});

/**
 * Inline justification text block — rendered as normal assistant text between tools.
 */
const InlineJustificationBlock = React.memo(({ activity, onContentChange, actions }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    actions?: React.ReactNode;
}) => {
    return (
        <JustificationBlock
            part={activity.part}
            messageId={activity.messageId}
            onContentChange={onContentChange}
            actions={actions}
        />
    );
});

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    isExpanded,
    collapsedPreviewCount = 0,
    onToggle,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    streamPhase,
    showHeader,
    animateRows = true,
    animatedToolIds,
    renderJustificationActions,
    showReasoningTraces = true,
}) => {
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
        return aggregateRows(sortedParts, showReasoningTraces);
    }, [shouldRenderRows, showReasoningTraces, sortedParts]);

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
        ? visibleRows.map((row) => {
        switch (row.type) {
            case 'reasoning':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineReasoningBlock
                            activity={row.activity}
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
                            activity={row.activity}
                            onContentChange={onContentChange}
                            actions={renderJustificationActions?.(row.activity)}
                        />
                    </>
                );

            case 'tool-expandable':
                return (
                    <MemoExpandableToolRow
                        key={row.key}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        expandedTools={expandedTools}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'tool-static':
                return (
                    <MemoStaticGroupedToolRow
                        key={row.key}
                        toolName={row.toolName}
                        activities={[row.activity]}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'context-tool-group': {
                const animateContextRow = row.activities.some((activity) => animatedToolIds?.has(activity.id));
                return wrapRow(
                    row.key,
                    <ToolRevealOnMount animate={animateContextRow} wipe>
                        <ContextToolGroupRow
                            rowKey={row.key}
                            status={row.status}
                            counts={row.counts}
                            children={row.children}
                            renderSignature={row.renderSignature}
                            animateTailText={animateContextRow}
                            isExpanded={expandedTools.has(row.key)}
                            onToggleTool={onToggleTool}
                        />
                    </ToolRevealOnMount>
                );
            }

            default:
                return null;
        }
    })
        : null;

    const shouldShowRowsContainer = isExpanded || visibleRows.length > 0;

    if (!showHeader) {
        return (
            <FadeInOnReveal>
                <div className="mt-1 mb-2 space-y-1.5">{renderedRows}</div>
            </FadeInOnReveal>
        );
    }

    return (
        <FadeInOnReveal>
            <div className="mt-1 mb-2">
                <button
                    type="button"
                    className="group/tool flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-px py-1.5 rounded-xl text-left"
                    onClick={onToggle}
                >
                    <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <Icon name="stack" className="h-3.5 w-3.5" />
                    </span>
                    <span
                        className="leading-5 font-semibold inline-flex h-5 items-center flex-shrink-0"
                        style={{
                            color: 'var(--tools-title)',
                            fontSize: '0.9rem',
                            letterSpacing: '0.005em',
                        }}
                    >
                        Activity
                    </span>
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
                                className="typography-meta leading-4 px-2 py-1 text-muted-foreground/45 hover:text-muted-foreground/65 text-left"
                            >
                                +{previewHiddenCount} more...
                            </button>
                        ) : null}
                        <div className="space-y-1.5">{renderedRows}</div>
                    </div>
                ) : null}
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
