
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { RiAiAgentLine, RiArrowDownSLine, RiArrowRightSLine, RiBookLine, RiExternalLinkLine, RiFileEditLine, RiFileList2Line, RiFileSearchLine, RiFileTextLine, RiFolder6Line, RiGitBranchLine, RiGlobalLine, RiListCheck2, RiListCheck3, RiMenuSearchLine, RiPencilLine, RiSurveyLine, RiTaskLine, RiTerminalBoxLine, RiToolsLine } from '@remixicon/react';
import { File as PierreFile, PatchDiff } from '@pierre/diffs/react';
import { cn } from '@/lib/utils';
import { formatTimestampForDisplay } from '../timeFormat';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { getToolMetadata, getLanguageFromExtension, isImageFile, getImageMimeType } from '@/lib/toolHelpers';
import type { ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@opencode-ai/sdk/v2';
import { toolDisplayStyles } from '@/lib/typography';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { opencodeClient } from '@/lib/opencode/client';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';

import {
    renderListOutput,
    renderGrepOutput,
    renderGlobOutput,
    renderTodoOutput,
    renderWebSearchOutput,
    formatEditOutput,
    detectLanguageFromOutput,
    formatInputForDisplay,
    parseReadToolOutput,
} from '../toolRenderers';
import { DiffViewToggle, type DiffViewMode } from '../DiffViewToggle';
import { VirtualizedCodeBlock, type CodeLine } from './VirtualizedCodeBlock';

type ToolStateWithMetadata = ToolStateUnion & { metadata?: Record<string, unknown>; input?: Record<string, unknown>; output?: string; error?: string; time?: { start: number; end?: number } };

interface ToolPartProps {
    part: ToolPartType;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    syntaxTheme: { [key: string]: React.CSSProperties };
    isMobile: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    hasPrevTool?: boolean;
    hasNextTool?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export const getToolIcon = (toolName: string) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const tool = toolName.toLowerCase();

    if (tool === 'edit' || tool === 'multiedit' || tool === 'apply_patch' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
        return <RiPencilLine className={iconClass} />;
    }
    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
        return <RiFileEditLine className={iconClass} />;
    }
    if (tool === 'read' || tool === 'view' || tool === 'file_read' || tool === 'cat') {
        return <RiFileTextLine className={iconClass} />;
    }
    if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal') {
        return <RiTerminalBoxLine className={iconClass} />;
    }
    if (tool === 'list' || tool === 'ls' || tool === 'dir' || tool === 'list_files') {
        return <RiFolder6Line className={iconClass} />;
    }
    if (tool === 'search' || tool === 'grep' || tool === 'find' || tool === 'ripgrep') {
        return <RiMenuSearchLine className={iconClass} />;
    }
    if (tool === 'glob') {
        return <RiFileSearchLine className={iconClass} />;
    }
    if (tool === 'fetch' || tool === 'curl' || tool === 'wget' || tool === 'webfetch') {
        return <RiGlobalLine className={iconClass} />;
    }
    if (
        tool === 'web-search' ||
        tool === 'websearch' ||
        tool === 'search_web' ||
        tool === 'codesearch' ||
        tool === 'google' ||
        tool === 'bing' ||
        tool === 'duckduckgo' ||
        tool === 'perplexity'
    ) {
        return <RiGlobalLine className={iconClass} />;
    }
    if (tool === 'todowrite' || tool === 'todoread') {
        return <RiListCheck3 className={iconClass} />;
    }
    if (tool === 'structuredoutput' || tool === 'structured_output') {
        return <RiListCheck2 className={iconClass} />;
    }
    if (tool === 'skill') {
        return <RiBookLine className={iconClass} />;
    }
    if (tool === 'task') {
        return <RiAiAgentLine className={iconClass} />;
    }
    if (tool === 'question') {
        return <RiSurveyLine className={iconClass} />;
    }
    if (tool === 'plan_enter') {
        return <RiFileList2Line className={iconClass} />;
    }
    if (tool === 'plan_exit') {
        return <RiTaskLine className={iconClass} />;
    }
    if (tool.startsWith('git')) {
        return <RiGitBranchLine className={iconClass} />;
    }
    return <RiToolsLine className={iconClass} />;
};

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    const duration = end ? end - start : now - start;
    const seconds = duration / 1000;

    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!active) {
            return;
        }
        const timer = window.setInterval(() => {
            setNow(Date.now());
        }, 100);
        return () => window.clearInterval(timer);
    }, [active]);

    return <>{formatDuration(start, end, now)}</>;
};

const parseDiffStats = (metadata?: Record<string, unknown>): { added: number; removed: number } | null => {
    if (!metadata?.diff || typeof metadata.diff !== 'string') return null;

    const lines = metadata.diff.split('\n');
    let added = 0;
    let removed = 0;

    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }

    if (added === 0 && removed === 0) return null;
    return { added, removed };
};

const getRelativePath = (absolutePath: string, currentDirectory: string, isMobile: boolean): string => {

    if (isMobile) {
        return absolutePath.split('/').pop() || absolutePath;
    }

    if (absolutePath.startsWith(currentDirectory)) {
        const relativePath = absolutePath.substring(currentDirectory.length);

        return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
    }

    return absolutePath;
};

const usePierreThemeConfig = () => {
    const themeSystem = useOptionalThemeSystem();
    const fallbackLightTheme = React.useMemo(() => getDefaultTheme(false), []);
    const fallbackDarkTheme = React.useMemo(() => getDefaultTheme(true), []);

    const availableThemes = React.useMemo(
        () => themeSystem?.availableThemes ?? [fallbackLightTheme, fallbackDarkTheme],
        [fallbackDarkTheme, fallbackLightTheme, themeSystem?.availableThemes],
    );
    const lightThemeId = themeSystem?.lightThemeId ?? fallbackLightTheme.metadata.id;
    const darkThemeId = themeSystem?.darkThemeId ?? fallbackDarkTheme.metadata.id;

    const lightTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLightTheme,
        [availableThemes, fallbackLightTheme, lightThemeId],
    );
    const darkTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDarkTheme,
        [availableThemes, darkThemeId, fallbackDarkTheme],
    );

    React.useEffect(() => {
        ensurePierreThemeRegistered(lightTheme);
        ensurePierreThemeRegistered(darkTheme);
    }, [darkTheme, lightTheme]);

    const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

    return {
        pierreTheme: { light: lightTheme.metadata.id, dark: darkTheme.metadata.id },
        pierreThemeType: currentVariant === 'dark' ? ('dark' as const) : ('light' as const),
    };
};

// Parse question tool output: "User has answered your questions: "Q1"="A1", "Q2"="A2". You can now..."
const parseQuestionOutput = (output: string): Array<{ question: string; answer: string }> | null => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
    if (!match) return null;

    const pairs: Array<{ question: string; answer: string }> = [];
    const content = match[1];

    // Match "question"="answer" pairs, handling multiline answers
    const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g;
    let pairMatch;
    while ((pairMatch = pairRegex.exec(content)) !== null) {
        pairs.push({
            question: pairMatch[1],
            answer: pairMatch[2],
        });
    }

    return pairs.length > 0 ? pairs : null;
};

const formatStructuredOutputDescription = (input: Record<string, unknown> | undefined, output: unknown, isMobile: boolean): string => {
    if (typeof output === 'string' && output.trim().length > 0) {
        const maxLength = isMobile ? 50 : 100;
        const text = output.trim();
        return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
    }

    if (!input || typeof input !== 'object') {
        return 'Result';
    }

    const rawValue = Object.prototype.hasOwnProperty.call(input, 'result') ? input.result : input;

    const toPreview = (value: unknown): string => {
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        if (Array.isArray(value)) {
            const joined = value
                .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
                .join(', ');
            return joined;
        }
        if (value && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            if (typeof record.subject === 'string' && record.subject.trim().length > 0) {
                return record.subject;
            }
            if (typeof record.title === 'string' && record.title.trim().length > 0) {
                return record.title;
            }
            return JSON.stringify(value);
        }
        return '';
    };

    const preview = toPreview(rawValue).trim();
    if (!preview) {
        return 'Result';
    }

    const maxLength = isMobile ? 50 : 100;
    const truncated = preview.length > maxLength ? `${preview.substring(0, maxLength)}...` : preview;
    return truncated;
};

const getToolDescription = (part: ToolPartType, state: ToolStateUnion, isMobile: boolean, currentDirectory: string): string => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const tool = part.tool.toLowerCase();

    if (tool === 'structuredoutput' || tool === 'structured_output') {
        return formatStructuredOutputDescription(input, stateWithData.output, isMobile);
    }

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        const firstFile = files[0] as { relativePath?: string; filePath?: string } | undefined;
        const filePath = firstFile?.relativePath || firstFile?.filePath;
        if (files.length > 1) {
            return `${files.length} files`;
        }
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory, isMobile);
        }
        return 'Patch';
    }

    // Question tool: show "Asked N question(s)"
    if (part.tool === 'question' && input?.questions && Array.isArray(input.questions)) {
        const count = input.questions.length;
        return `Asked ${count} question${count !== 1 ? 's' : ''}`;
    }

    if ((part.tool === 'edit' || part.tool === 'multiedit') && input) {
        const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory, isMobile);
        }
    }

    if ((part.tool === 'read' || part.tool === 'write') && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory, isMobile);
        }
    }

    if (part.tool === 'bash' && input?.command && typeof input.command === 'string') {
        const firstLine = input.command.split('\n')[0];
        return isMobile ? firstLine.substring(0, 50) : firstLine.substring(0, 100);
    }

    if (part.tool === 'task' && input?.description && typeof input.description === 'string') {
        return isMobile ? input.description.substring(0, 40) : input.description.substring(0, 80);
    }

    if (part.tool === 'skill' && input?.name && typeof input.name === 'string') {
        return input.name;
    }

    if (part.tool === 'plan_enter') {
        return 'Switching to planning';
    }

    if (part.tool === 'plan_exit') {
        return 'Switching to building';
    }

    const desc = input?.description || metadata?.description || ('title' in state && state.title) || '';
    return typeof desc === 'string' ? desc : '';
};

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
}

const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
}) => (
    <ScrollableOverlay
        outerClassName={cn('w-full min-w-0 flex-none overflow-hidden', maxHeightClass, outerClassName)}
        className={cn('tool-output-surface p-2 rounded-xl w-full min-w-0 bg-transparent', className)}
        style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}
        disableHorizontal={disableHorizontal}
    >
        <div className="w-full min-w-0">
            {children}
        </div>
    </ScrollableOverlay>
);

type TaskToolSummaryEntry = {
    id?: string;
    tool?: string;
    state?: {
        status?: string;
        title?: string;
    };
};

type SessionMessageWithParts = {
    info?: {
        role?: string;
    };
    parts?: Array<{
        id?: string;
        type?: string;
        tool?: string;
        state?: {
            status?: string;
            title?: string;
        };
    }>;
};

const EMPTY_SESSION_MESSAGES: SessionMessageWithParts[] = [];

const readTaskSessionIdFromOutput = (output: string | undefined): string | undefined => {
    if (typeof output !== 'string' || output.trim().length === 0) {
        return undefined;
    }
    const parsedMetadata = parseTaskMetadataBlock(output);
    if (parsedMetadata.sessionId) {
        return parsedMetadata.sessionId;
    }
    const match = output.match(/task_id:\s*([a-zA-Z0-9_]+)/);
    const candidate = match?.[1];
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
};

const buildTaskSummaryEntriesFromSession = (messages: SessionMessageWithParts[]): TaskToolSummaryEntry[] => {
    const entries: TaskToolSummaryEntry[] = [];

    for (const message of messages) {
        if (message?.info?.role !== 'assistant') {
            continue;
        }
        const parts = Array.isArray(message.parts) ? message.parts : [];
        for (const part of parts) {
            if (part?.type !== 'tool') {
                continue;
            }
            const toolName = typeof part.tool === 'string' ? part.tool.toLowerCase() : '';
            if (!toolName || toolName === 'task' || toolName === 'todowrite' || toolName === 'todoread') {
                continue;
            }
            entries.push({
                id: part.id,
                tool: part.tool,
                state: {
                    status: part.state?.status,
                    title: part.state?.title,
                },
            });
        }
    }

    return entries;
};

const getTaskSummaryLabel = (entry: TaskToolSummaryEntry): string => {
    const title = entry.state?.title;
    if (typeof title === 'string' && title.trim().length > 0) {
        return title;
    }
    if (typeof entry.tool === 'string' && entry.tool.trim().length > 0) {
        return entry.tool;
    }
    return 'tool';
};

const stripTaskMetadataFromOutput = (output: string): string => {
    // Strip only a trailing <task_metadata>...</task_metadata> block.
    return output.replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/i, '').trimEnd();
};

const normalizeTaskSummaryEntries = (value: unknown): TaskToolSummaryEntry[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const normalized: TaskToolSummaryEntry[] = [];
    for (const entry of value) {
        if (typeof entry === 'string') {
            normalized.push({
                tool: 'tool',
                state: { status: 'completed', title: entry },
            });
            continue;
        }

        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const record = entry as {
            id?: unknown;
            tool?: unknown;
            title?: unknown;
            status?: unknown;
            state?: { status?: unknown; title?: unknown };
        };

        const stateStatus = typeof record.state?.status === 'string' ? record.state.status : undefined;
        const stateTitle = typeof record.state?.title === 'string' ? record.state.title : undefined;
        const status = stateStatus ?? (typeof record.status === 'string' ? record.status : undefined);
        const title = stateTitle ?? (typeof record.title === 'string' ? record.title : undefined);

        normalized.push({
            id: typeof record.id === 'string' ? record.id : undefined,
            tool: typeof record.tool === 'string' ? record.tool : 'tool',
            state: {
                status,
                title,
            },
        });
    }

    return normalized;
};

const parseTaskMetadataBlock = (output: string | undefined): {
    sessionId?: string;
    summaryEntries: TaskToolSummaryEntry[];
} => {
    if (typeof output !== 'string' || output.trim().length === 0) {
        return { summaryEntries: [] };
    }

    const blockMatch = output.match(/<task_metadata>\s*([\s\S]*?)\s*<\/task_metadata>/i);
    if (!blockMatch?.[1]) {
        return { summaryEntries: [] };
    }

    const raw = blockMatch[1].trim();
    if (!raw) {
        return { summaryEntries: [] };
    }

    try {
        const parsed = JSON.parse(raw) as {
            sessionId?: unknown;
            sessionID?: unknown;
            summary?: unknown;
            entries?: unknown;
            tools?: unknown;
            calls?: unknown;
        };

        const summaryEntries = normalizeTaskSummaryEntries(
            parsed.summary ?? parsed.entries ?? parsed.tools ?? parsed.calls
        );

        const sessionId =
            (typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length > 0
                ? parsed.sessionId.trim()
                : undefined) ??
            (typeof parsed.sessionID === 'string' && parsed.sessionID.trim().length > 0
                ? parsed.sessionID.trim()
                : undefined);

        return { sessionId, summaryEntries };
    } catch {
        return { summaryEntries: [] };
    }
};

const TaskToolSummary: React.FC<{
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    hasPrevTool: boolean;
    hasNextTool: boolean;
    output?: string;
    sessionId?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
}> = ({ entries, isExpanded, hasPrevTool, hasNextTool, output, sessionId, onShowPopup, input }) => {
    const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
    const displayEntries = React.useMemo(() => {
        const nonPending = entries.filter((entry) => entry.state?.status !== 'pending');
        return nonPending.length > 0 ? nonPending : entries;
    }, [entries]);

    const trimmedOutput = typeof output === 'string'
        ? stripTaskMetadataFromOutput(output)
        : '';
    const hasOutput = trimmedOutput.length > 0;
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId) {
            setCurrentSession(sessionId);
        }
    };

    const agentType = typeof input?.subagent_type === 'string'
        ? input.subagent_type
        : 'subagent';

    if (displayEntries.length === 0 && !hasOutput && !sessionId) {
        return null;
    }

    const visibleEntries = isExpanded ? displayEntries : displayEntries.slice(-6);
    const hiddenCount = Math.max(0, displayEntries.length - visibleEntries.length);

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]',
                'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                hasPrevTool ? 'before:top-[-0.45rem]' : 'before:top-[-0.25rem]',
                hasNextTool ? 'before:bottom-[-0.6rem]' : 'before:bottom-0'
            )}
        >
            {displayEntries.length > 0 ? (
                <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
                    <div className="w-full min-w-0 space-y-1">
                        {hiddenCount > 0 ? (
                            <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
                        ) : null}

                        {visibleEntries.map((entry, idx) => {
                            const toolName = typeof entry.tool === 'string' && entry.tool.trim().length > 0 ? entry.tool : 'tool';
                            const label = getTaskSummaryLabel(entry);
                            const status = entry.state?.status;

                            const displayName = getToolMetadata(toolName).displayName;

                            return (
                                <div key={entry.id ?? `${toolName}-${idx}`} className="flex items-center gap-2 min-w-0">
                                    <span className="flex-shrink-0 text-foreground/80">{getToolIcon(toolName)}</span>
                                    <span className="typography-meta text-foreground/80 flex-shrink-0">{displayName}</span>
                                    <span className={cn(
                                        'typography-meta truncate',
                                        status === 'error' ? 'text-[var(--status-error)]' : 'text-muted-foreground/70'
                                    )}>{label}</span>
                                </div>
                            );
                        })}
                    </div>
                </ToolScrollableSection>
            ) : null}

            {sessionId && (
                <button
                    type="button"
                    className="flex items-center gap-2 typography-meta text-primary hover:text-primary/80 w-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleOpenSession}
                >
                    <RiExternalLinkLine className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="typography-meta text-primary font-medium">Open {agentType.charAt(0).toUpperCase() + agentType.slice(1)} subtask</span>
                </button>
            )}

            {hasOutput ? (
                <div className={cn('space-y-1', (displayEntries.length > 0 || sessionId) && 'pt-1')}
                >
                    <button
                        type="button"
                        className="flex items-center gap-2 typography-meta text-foreground/80 hover:text-foreground w-full"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsOutputExpanded((prev) => !prev);
                        }}
                    >
                        {isOutputExpanded ? (
                            <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <RiArrowRightSLine className="h-3.5 w-3.5 flex-shrink-0" />
                        )}
                        <span className="typography-meta text-foreground/80 font-medium">Output</span>
                    </button>
                    {isOutputExpanded ? (
                        <ToolScrollableSection maxHeightClass="max-h-[50vh]">
                            <div className="w-full min-w-0">
                                <SimpleMarkdownRenderer content={trimmedOutput} variant="tool" onShowPopup={onShowPopup} />
                            </div>
                        </ToolScrollableSection>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

interface DiffPreviewProps {
    diff: string;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
    diffViewMode: DiffViewMode;
}

const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    fileGap: 0,
};

type DiffPatchEntry = {
    id: string;
    title: string;
    patch: string;
};

const renderPathLikeGitChanges = (path: string) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return <span className="truncate text-foreground">{path}</span>;
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);

    return (
        <span className="flex min-w-0 items-baseline overflow-hidden" title={path}>
            <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', textAlign: 'left' }}>
                {dir}
            </span>
            <span className="flex-shrink-0">
                <span className="text-muted-foreground">/</span>
                <span className="text-foreground">{name}</span>
            </span>
        </span>
    );
};

const getDiffPatchEntries = (
    metadata: Record<string, unknown> | undefined,
    fallbackDiff: string,
    currentDirectory: string,
    isMobile: boolean,
): DiffPatchEntry[] => {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];

    const entries = files
        .map((file, index) => {
            if (!file || typeof file !== 'object') {
                return null;
            }

            const record = file as { relativePath?: unknown; filePath?: unknown; diff?: unknown };
            const patch = typeof record.diff === 'string' ? record.diff.trim() : '';
            if (!patch) {
                return null;
            }

            const rawPath = typeof record.relativePath === 'string'
                ? record.relativePath
                : typeof record.filePath === 'string'
                    ? record.filePath
                    : `File ${index + 1}`;

            const title = typeof rawPath === 'string'
                ? getRelativePath(rawPath, currentDirectory, isMobile)
                : `File ${index + 1}`;

            return {
                id: `${title}-${index}`,
                title,
                patch,
            } satisfies DiffPatchEntry;
        })
        .filter((entry): entry is DiffPatchEntry => entry !== null);

    if (entries.length > 0) {
        return entries;
    }

    return [
        {
            id: 'diff-0',
            title: 'Diff',
            patch: fallbackDiff,
        },
    ];
};

const DiffPreview: React.FC<DiffPreviewProps> = React.memo(({ diff, pierreTheme, pierreThemeType, diffViewMode }) => {
    return (
        <div className="typography-code px-1 pb-1 pt-0">
            <PatchDiff
                patch={diff}
                metrics={TOOL_DIFF_METRICS}
                options={{
                    diffStyle: diffViewMode === 'side-by-side' ? 'split' : 'unified',
                    diffIndicators: 'none',
                    hunkSeparators: 'line-info-basic',
                    lineDiffType: 'none',
                    disableFileHeader: true,
                    maxLineDiffLength: 1000,
                    expansionLineCount: 20,
                    overflow: 'wrap',
                    theme: pierreTheme,
                    themeType: pierreThemeType,
                    unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
                }}
                className="block w-full"
            />
        </div>
    );
});

DiffPreview.displayName = 'DiffPreview';

interface WriteInputPreviewProps {
    content: string;
    filePath?: string;
    displayPath: string;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
}

const WriteInputPreview: React.FC<WriteInputPreviewProps> = React.memo(({
    content,
    filePath,
    displayPath,
    pierreTheme,
    pierreThemeType,
}) => {
    const language = React.useMemo(
        () => getLanguageFromExtension(filePath ?? '') || detectLanguageFromOutput(content, 'write', filePath ? { filePath } : undefined),
        [content, filePath]
    );

    const lineCount = Math.max(content.split('\n').length, 1);
    const headerLineLabel = lineCount === 1 ? 'line 1' : `lines 1-${lineCount}`;

    return (
        <div className="w-full min-w-0">
            <div className="bg-muted/20 px-2 py-1 typography-meta font-medium text-muted-foreground rounded-lg mb-1" style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}>
                {`${displayPath} (${headerLineLabel})`}
            </div>
            <PierreFile
                file={{
                    name: displayPath,
                    contents: content,
                    lang: language || undefined,
                }}
                options={{
                    disableFileHeader: true,
                    overflow: 'wrap',
                    theme: pierreTheme,
                    themeType: pierreThemeType,
                }}
                className="block w-full"
            />
        </div>
    );
});

WriteInputPreview.displayName = 'WriteInputPreview';

// ── PERF-007: Read tool output with virtualised highlighting ─────────
interface ReadToolVirtualizedProps {
    outputString: string;
    input?: Record<string, unknown>;
    syntaxTheme: { [key: string]: React.CSSProperties };
    toolName: string;
    pierreTheme: { light: string; dark: string };
    pierreThemeType: 'light' | 'dark';
    renderScrollableBlock: (
        content: React.ReactNode,
        options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string }
    ) => React.ReactNode;
}

const ReadToolVirtualized: React.FC<ReadToolVirtualizedProps> = React.memo(({
    outputString,
    input,
    syntaxTheme,
    toolName,
    pierreTheme,
    pierreThemeType,
    renderScrollableBlock,
}) => {
    const parsedReadOutput = React.useMemo(() => parseReadToolOutput(outputString), [outputString]);

    const language = React.useMemo(() => {
        const contentForLanguage = parsedReadOutput.lines.map((l) => l.text).join('\n');
        return detectLanguageFromOutput(contentForLanguage, toolName, input as Record<string, unknown>);
    }, [parsedReadOutput, toolName, input]);

    const filePath =
        typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : 'read-output';

    const codeLines: CodeLine[] = React.useMemo(() => parsedReadOutput.lines.map((line) => ({
        text: line.text,
        lineNumber: line.lineNumber,
        isInfo: line.isInfo,
    })), [parsedReadOutput]);

    if (parsedReadOutput.type === 'file') {
        const fileContent = parsedReadOutput.lines.map((line) => line.text).join('\n');
        return renderScrollableBlock(
            <PierreFile
                file={{
                    name: filePath,
                    contents: fileContent,
                    lang: language || undefined,
                }}
                options={{
                    disableFileHeader: true,
                    overflow: 'wrap',
                    theme: pierreTheme,
                    themeType: pierreThemeType,
                }}
                className="block w-full"
            />,
            { className: 'p-1' }
        ) as React.ReactElement;
    }

    return renderScrollableBlock(
        <VirtualizedCodeBlock
            lines={codeLines}
            language={language}
            syntaxTheme={syntaxTheme}
            maxHeight="55vh"
        />,
        { className: 'p-1' }
    ) as React.ReactElement;
});

ReadToolVirtualized.displayName = 'ReadToolVirtualized';

interface ImagePreviewProps {
    content: string;
    filePath: string;
    displayPath: string;
}

const ImagePreview: React.FC<ImagePreviewProps> = React.memo(({ content, filePath, displayPath }) => {
    const mimeType = getImageMimeType(filePath);
    const isSvg = filePath.toLowerCase().endsWith('.svg');

    // For SVG, content might be raw XML, otherwise assume base64
    const imageSrc = React.useMemo(() => {
        if (isSvg && !content.startsWith('data:')) {
            // Raw SVG content
            return `data:image/svg+xml;base64,${btoa(content)}`;
        }
        if (content.startsWith('data:')) {
            return content;
        }
        // Assume base64 encoded
        return `data:${mimeType};base64,${content}`;
    }, [content, mimeType, isSvg]);

    return (
        <div className="w-full min-w-0">
            <div className="bg-muted/20 px-2 py-1 typography-meta font-medium text-muted-foreground rounded-lg mb-2" style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}>
                {displayPath}
            </div>
            <div className="flex justify-center p-4 bg-muted/10 rounded-lg" style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}>
                <img
                    src={imageSrc}
                    alt={displayPath}
                    className="max-w-full max-h-96 object-contain rounded"
                    style={{ imageRendering: 'auto' }}
                />
            </div>
        </div>
    );
});

ImagePreview.displayName = 'ImagePreview';

interface ToolExpandedContentProps {
    part: ToolPartType;
    state: ToolStateUnion;
    syntaxTheme: { [key: string]: React.CSSProperties };
    isMobile: boolean;
    currentDirectory: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    hasPrevTool: boolean;
    hasNextTool: boolean;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    syntaxTheme,
    isMobile,
    currentDirectory,
    onShowPopup,
    hasPrevTool,
    hasNextTool,
}) => {
    const { pierreTheme, pierreThemeType } = usePierreThemeConfig();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const rawOutput = stateWithData.output;
    const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
    const outputString = typeof rawOutput === 'string' ? rawOutput : '';

    const diffContent = typeof metadata?.diff === 'string' ? (metadata.diff as string) : null;
    const diffEntries = React.useMemo(
        () => (diffContent ? getDiffPatchEntries(metadata, diffContent, currentDirectory, isMobile) : []),
        [currentDirectory, diffContent, isMobile, metadata]
    );
    const writeFilePath = part.tool === 'write'
        ? typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : undefined
        : undefined;
    const writeInputContent = part.tool === 'write'
        ? typeof (input as { content?: unknown })?.content === 'string'
            ? (input as { content?: string }).content
            : typeof (input as { text?: unknown })?.text === 'string'
                ? (input as { text?: string }).text
                : null
        : null;
    const shouldShowWriteInputPreview = part.tool === 'write' && !!writeInputContent;
    const isWriteImageFile = writeFilePath ? isImageFile(writeFilePath) : false;
    const writeDisplayPath = shouldShowWriteInputPreview
        ? (writeFilePath ? getRelativePath(writeFilePath, currentDirectory, isMobile) : 'New file')
        : null;

    const inputTextContent = React.useMemo(() => {
        if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
            return '';
        }

        if ('command' in input && typeof input.command === 'string' && part.tool === 'bash') {
            return formatInputForDisplay(input, part.tool);
        }

        if (typeof (input as { content?: unknown }).content === 'string') {
            return (input as { content?: string }).content ?? '';
        }

        return formatInputForDisplay(input, part.tool);
    }, [input, part.tool]);
    const hasInputText = part.tool !== 'apply_patch' && inputTextContent.trim().length > 0;

    React.useEffect(() => {
        setDiffViewMode('unified');
    }, [part.id]);

    const renderScrollableBlock = (
        content: React.ReactNode,
        options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string }
    ) => (
        <ToolScrollableSection
            maxHeightClass={options?.maxHeightClass}
            className={options?.className}
            disableHorizontal={options?.disableHorizontal}
            outerClassName={options?.outerClassName}
        >
            {content}
        </ToolScrollableSection>
    );

    const renderResultContent = () => {
        // Question tool: show parsed Q&A summary
        if (part.tool === 'question') {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="space-y-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="space-y-0.5">
                                    <div className="typography-micro text-muted-foreground">{qa.question}</div>
                                    <div className="typography-meta text-foreground whitespace-pre-wrap">{qa.answer}</div>
                                </div>
                            ))}
                        </div>,
                        { maxHeightClass: 'max-h-[40vh]' }
                    );
                }
            }

            if (state.status === 'error' && 'error' in state) {
                return (
                    <div>
                        <div className="typography-meta font-medium text-muted-foreground mb-1">Error:</div>
                        <div className="typography-meta p-2 rounded-xl border" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                            borderColor: 'var(--status-error-border)',
                        }}>
                            {state.error}
                        </div>
                    </div>
                );
            }

            return <div className="typography-meta text-muted-foreground">Awaiting response...</div>;
        }

        if (part.tool === 'todowrite' || part.tool === 'todoread') {
            if (state.status === 'completed' && hasStringOutput) {
                const todoContent = renderTodoOutput(outputString, { unstyled: true });
                return renderScrollableBlock(
                    todoContent ?? (
                        <div className="typography-meta text-muted-foreground">Unable to parse todo list</div>
                    )
                );
            }

            if (state.status === 'error' && 'error' in state) {
                return (
                    <div>
                        <div className="typography-meta font-medium text-muted-foreground mb-1">Error:</div>
                        <div className="typography-meta p-2 rounded-xl border" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                            borderColor: 'var(--status-error-border)',
                        }}>
                            {state.error}
                        </div>
                    </div>
                );
            }

            return <div className="typography-meta text-muted-foreground">Processing todo list...</div>;
        }

        if (part.tool === 'list' && hasStringOutput) {
            const listOutput = renderListOutput(outputString, { unstyled: true });
            return renderScrollableBlock(
                listOutput ?? (
                    <pre className="typography-code font-mono whitespace-pre-wrap break-words w-full min-w-0">
                        {outputString}
                    </pre>
                )
            );
        }

        if (part.tool === 'grep' && hasStringOutput) {
            const grepOutput = renderGrepOutput(outputString, isMobile, { unstyled: true });
            return renderScrollableBlock(
                grepOutput ?? (
                    <pre className="typography-code font-mono whitespace-pre-wrap break-words w-full min-w-0">
                        {outputString}
                    </pre>
                )
            );
        }

        if (part.tool === 'glob' && hasStringOutput) {
            const globOutput = renderGlobOutput(outputString, isMobile, { unstyled: true });
            return renderScrollableBlock(
                globOutput ?? (
                    <pre className="typography-code font-mono whitespace-pre-wrap break-words w-full min-w-0">
                        {outputString}
                    </pre>
                )
            );
        }

        if (part.tool === 'task' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={outputString} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if ((part.tool === 'web-search' || part.tool === 'websearch' || part.tool === 'search_web') && hasStringOutput) {
            const webSearchContent = renderWebSearchOutput(outputString, syntaxTheme, { unstyled: true });
            return renderScrollableBlock(
                webSearchContent ?? (
                    <pre className="typography-code font-mono whitespace-pre-wrap break-words w-full min-w-0">
                        {outputString}
                    </pre>
                )
            );
        }

        if (part.tool === 'codesearch' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={outputString} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if (part.tool === 'skill' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={outputString} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if ((part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch') && diffEntries.length > 0) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {diffEntries.map((entry) => (
                        <div key={entry.id} className="w-full min-w-0">
                            {diffEntries.length > 1 ? (
                                <div className="bg-muted/20 px-2 py-1 typography-meta font-medium text-muted-foreground rounded-lg mb-1" style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}>
                                    {renderPathLikeGitChanges(entry.title)}
                                </div>
                            ) : null}
                            <DiffPreview
                                diff={entry.patch}
                                pierreTheme={pierreTheme}
                                pierreThemeType={pierreThemeType}
                                diffViewMode={diffViewMode}
                            />
                        </div>
                    ))}
                </div>,
                { className: 'p-1' }
            );
        }

        if (hasStringOutput && outputString.trim()) {
            if (part.tool === 'read') {
                return <ReadToolVirtualized
                    outputString={outputString}
                    input={input}
                    syntaxTheme={syntaxTheme}
                    toolName={part.tool}
                    pierreTheme={pierreTheme}
                    pierreThemeType={pierreThemeType}
                    renderScrollableBlock={renderScrollableBlock}
                />;
            }

            return renderScrollableBlock(
                <SyntaxHighlighter
                    style={syntaxTheme}
                    language={detectLanguageFromOutput(formatEditOutput(outputString, part.tool, metadata), part.tool, input)}
                    PreTag="div"
                    customStyle={{
                        ...toolDisplayStyles.getCollapsedStyles(),
                        padding: 0,
                        overflow: 'visible',
                    }}
                    codeTagProps={{
                        style: {
                            background: 'transparent',
                            backgroundColor: 'transparent',
                        },
                    }}
                    wrapLongLines
                >
                    {formatEditOutput(outputString, part.tool, metadata)}
                </SyntaxHighlighter>,
                { className: 'p-1' }
            );
        }

        return renderScrollableBlock(
            <div className="typography-meta text-muted-foreground/70">No output produced</div>,
            { maxHeightClass: 'max-h-60' }
        );
    };

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]'
            )}
        >
            <div 
                className="absolute left-[0.4375rem] w-px"
                style={{
                    backgroundColor: 'var(--tools-border)',
                    top: hasPrevTool ? '-0.45rem' : '-0.25rem',
                    bottom: hasNextTool ? '-0.6rem' : '0',
                    width: '1px'
                }}
            ></div>
            {(part.tool === 'todowrite' || part.tool === 'todoread' || part.tool === 'question') ? (
                renderResultContent()
            ) : (
                <>
                    {shouldShowWriteInputPreview && isWriteImageFile ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                <ImagePreview
                                    content={writeInputContent as string}
                                    filePath={writeFilePath as string}
                                    displayPath={writeDisplayPath ?? 'New file'}
                                />
                            )}
                        </div>
                    ) : shouldShowWriteInputPreview ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                <WriteInputPreview
                                    content={writeInputContent as string}
                                    filePath={writeFilePath}
                                    displayPath={writeDisplayPath ?? 'New file'}
                                    pierreTheme={pierreTheme}
                                    pierreThemeType={pierreThemeType}
                                />
                            )}
                        </div>
                    ) : hasInputText ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                <blockquote className="tool-input-text whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">
                                    {inputTextContent}
                                </blockquote>,
                                { maxHeightClass: 'max-h-60', className: 'tool-input-surface' }
                            )}
                        </div>
                    ) : null}

                    {part.tool !== 'write' && state.status === 'completed' && 'output' in state && (
                        <div>
                            <div className="mb-1 flex items-center justify-between gap-2">
                                <div className="typography-meta font-medium text-muted-foreground/80">
                                    Result:
                                </div>
                                {(part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch') && diffContent ? (
                                    <DiffViewToggle
                                        mode={diffViewMode}
                                        onModeChange={setDiffViewMode}
                                        className="h-5 w-5 p-0"
                                    />
                                ) : null}
                            </div>
                            {renderResultContent()}
                        </div>
                    )}

                    {state.status === 'error' && 'error' in state && (
                        <div>
                            <div className="typography-meta font-medium text-muted-foreground/80 mb-1">Error:</div>
                            <div className="typography-meta p-2 rounded-xl border" style={{
                                backgroundColor: 'var(--status-error-background)',
                                color: 'var(--status-error)',
                                borderColor: 'var(--status-error-border)',
                            }}>
                                {state.error}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
});

ToolExpandedContent.displayName = 'ToolExpandedContent';

const ToolPart: React.FC<ToolPartProps> = ({
    part,
    isExpanded,
    onToggle,
    syntaxTheme,
    isMobile,
    onContentChange,
    onShowPopup,
    hasPrevTool = false,
    hasNextTool = false,
}) => {
    const state = part.state;
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);

    const isTaskTool = part.tool.toLowerCase() === 'task';

    const isFinalized = state.status === 'completed' || state.status === 'error';
    const isActive = state.status === 'running' || state.status === 'pending';
    const isError = state.status === 'error';



    const shouldNotifyStructuralChange = isFinalized || isTaskTool;

    React.useEffect(() => {
        if (!shouldNotifyStructuralChange) {
            return;
        }
        if (typeof isExpanded === 'boolean') {
            onContentChange?.('structural');
        }
    }, [isExpanded, onContentChange, shouldNotifyStructuralChange]);

    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const time = stateWithData.time;

    const [pinnedTaskTime, setPinnedTaskTime] = React.useState<{ start?: number; end?: number }>({});

    React.useEffect(() => {
        setPinnedTaskTime({});
    }, [part.id]);

    React.useEffect(() => {
        if (!isTaskTool) {
            return;
        }

        setPinnedTaskTime((prev) => {
            const next = { ...prev };
            let changed = false;

            if (typeof time?.start === 'number' && (typeof prev.start !== 'number' || time.start < prev.start)) {
                next.start = time.start;
                changed = true;
            }

            if (typeof time?.end === 'number' && prev.end !== time.end) {
                next.end = time.end;
                changed = true;
            }

            return changed ? next : prev;
        });
    }, [isTaskTool, time?.end, time?.start]);

    const effectiveTimeStart = isTaskTool ? (pinnedTaskTime.start ?? time?.start) : time?.start;
    const effectiveTimeEnd = isTaskTool ? (pinnedTaskTime.end ?? time?.end) : time?.end;

    const endedTimestampText = React.useMemo(() => {
        if (typeof effectiveTimeEnd !== 'number' || !Number.isFinite(effectiveTimeEnd)) {
            return null;
        }

        const formatted = formatTimestampForDisplay(effectiveTimeEnd);
        return formatted.length > 0 ? formatted : null;
    }, [effectiveTimeEnd]);

    const taskOutputString = React.useMemo(() => {
        return typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    }, [stateWithData.output]);

    const parsedTaskMetadata = React.useMemo(() => {
        return parseTaskMetadataBlock(taskOutputString);
    }, [taskOutputString]);

    const taskSessionId = React.useMemo<string | undefined>(() => {
        if (!isTaskTool) {
            return undefined;
        }
        const candidate = metadata as { sessionId?: string } | undefined;
        if (typeof candidate?.sessionId === 'string' && candidate.sessionId.trim().length > 0) {
            return candidate.sessionId;
        }
        if (parsedTaskMetadata.sessionId) {
            return parsedTaskMetadata.sessionId;
        }
        return readTaskSessionIdFromOutput(taskOutputString);
    }, [isTaskTool, metadata, parsedTaskMetadata.sessionId, taskOutputString]);

    const childSessionMessages = useSessionStore(
        React.useCallback((store) => {
            if (!taskSessionId) {
                return EMPTY_SESSION_MESSAGES;
            }
            return (store.messages.get(taskSessionId) as SessionMessageWithParts[] | undefined) ?? EMPTY_SESSION_MESSAGES;
        }, [taskSessionId])
    );

    const metadataTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool) {
            return [];
        }
        const candidateSummary = (metadata as { summary?: unknown; entries?: unknown; tools?: unknown; calls?: unknown } | undefined);
        const normalized = normalizeTaskSummaryEntries(
            candidateSummary?.summary ?? candidateSummary?.entries ?? candidateSummary?.tools ?? candidateSummary?.calls
        );

        if (normalized.length > 0) {
            return normalized;
        }

        return parsedTaskMetadata.summaryEntries;
    }, [isTaskTool, metadata, parsedTaskMetadata.summaryEntries]);

    const childSessionTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool || !taskSessionId) {
            return [];
        }
        if (!Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return [];
        }
        return buildTaskSummaryEntriesFromSession(childSessionMessages);
    }, [childSessionMessages, isTaskTool, taskSessionId]);

    const taskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (childSessionTaskSummaryEntries.length > 0) {
            return childSessionTaskSummaryEntries;
        }
        return metadataTaskSummaryEntries;
    }, [childSessionTaskSummaryEntries, metadataTaskSummaryEntries]);

    const fetchedTaskSessionsRef = React.useRef<Set<string>>(new Set());
    React.useEffect(() => {
        if (!isTaskTool || !taskSessionId) {
            return;
        }
        if (childSessionTaskSummaryEntries.length > 0) {
            return;
        }
        if (fetchedTaskSessionsRef.current.has(taskSessionId)) {
            return;
        }

        fetchedTaskSessionsRef.current.add(taskSessionId);
        let cancelled = false;

        void opencodeClient
            .getSessionMessages(taskSessionId, 500)
            .then((messages) => {
                if (cancelled || !Array.isArray(messages)) {
                    return;
                }
                if (messages.length === 0) {
                    fetchedTaskSessionsRef.current.delete(taskSessionId);
                    return;
                }
                useSessionStore.getState().syncMessages(taskSessionId, messages);
            })
            .catch(() => {
                fetchedTaskSessionsRef.current.delete(taskSessionId);
            });

        return () => {
            cancelled = true;
        };
    }, [childSessionTaskSummaryEntries.length, isTaskTool, taskSessionId]);


    const taskSummaryLenRef = React.useRef<number>(taskSummaryEntries.length);
    React.useEffect(() => {
        if (!isTaskTool) {
            return;
        }
        if (taskSummaryLenRef.current === taskSummaryEntries.length) {
            return;
        }
        taskSummaryLenRef.current = taskSummaryEntries.length;
        onContentChange?.('structural');
    }, [isTaskTool, onContentChange, taskSummaryEntries.length]);

    const diffStats = (part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch') ? parseDiffStats(metadata) : null;
    const description = getToolDescription(part, state, isMobile, currentDirectory);
    const displayName = getToolMetadata(part.tool).displayName;
    
    // Get justification text (tool title/description) when setting is enabled
    const showTextJustificationActivity = useUIStore((state) => state.showTextJustificationActivity);
    const justificationText = React.useMemo(() => {
        if (!showTextJustificationActivity) return null;
        if (part.tool === 'apply_patch') return null;
        if (part.tool.toLowerCase() === 'structuredoutput' || part.tool.toLowerCase() === 'structured_output') return null;
        // Get title or description from state - this is the "yapping" text like "Shows system information"
        const title = (stateWithData as { title?: string }).title;
        if (typeof title === 'string' && title.trim().length > 0) {
            return title;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [showTextJustificationActivity, part.tool, stateWithData, input]);

    const runtime = React.useContext(RuntimeAPIContext);

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        if (isTaskTool || !runtime?.editor) {
            onToggle(part.id);
            return;
        }

        let filePath: unknown;
        if (part.tool === 'edit' || part.tool === 'multiedit') {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        } else if (part.tool === 'apply_patch') {
            const files = Array.isArray(metadata?.files) ? metadata?.files : [];
            const firstFile = files[0] as { relativePath?: string; filePath?: string } | undefined;
            filePath = firstFile?.relativePath || firstFile?.filePath;
        } else if (['write', 'create', 'file_write', 'read', 'view', 'file_read', 'cat'].includes(part.tool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            let absolutePath = filePath;
            if (!filePath.startsWith('/')) {
                absolutePath = currentDirectory.endsWith('/') ? currentDirectory + filePath : currentDirectory + '/' + filePath;
            }
            runtime.editor.openFile(absolutePath);
        } else {
            onToggle(part.id);
        }
    };

    const handleMainKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleMainClick(event);
    };

    if (!isFinalized && !isTaskTool) {
        return null;
    }

    return (
        <div className="my-1">
            {}
            <div
                className={cn(
                    'group/tool flex items-center gap-2 pr-2 pl-px py-1.5 rounded-xl cursor-pointer'
                )}
                onClick={handleMainClick}
                onKeyDown={handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className="flex items-center gap-2 flex-shrink-0">
                    {}
                    <button
                        type="button"
                        className="relative h-3.5 w-3.5 flex-shrink-0"
                        onClick={(event) => { event.stopPropagation(); onToggle(part.id); }}
                        aria-label={isExpanded ? 'Collapse tool details' : 'Expand tool details'}
                    >
                        {}
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && !isMobile && 'group-hover/tool:opacity-0'
                            )}
                            style={!isTaskTool && isError ? { color: 'var(--status-error)' } : { color: 'var(--tools-icon)' }}
                        >
                            {getToolIcon(part.tool)}
                        </div>
                        {}
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity flex items-center justify-center',
                                isExpanded && 'opacity-100',
                                !isExpanded && isMobile && 'opacity-0',
                                !isExpanded && !isMobile && 'opacity-0 group-hover/tool:opacity-100'
                            )}
                        >
                            {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                        </div>
                    </button>
                    <span
                        className="typography-meta font-medium"
                        style={!isTaskTool && isError ? { color: 'var(--status-error)' } : { color: 'var(--tools-title)' }}
                    >
                        {displayName}
                    </span>
                </div>

                <div className="flex items-center gap-1 flex-1 min-w-0 typography-meta" style={{ color: 'var(--tools-description)' }}>
                    {justificationText && (
                        <span className={cn("truncate", isMobile && "max-w-[120px]")} style={{ color: 'var(--tools-description)', opacity: 0.8 }}>
                            {justificationText}
                        </span>
                    )}
                    {!justificationText && description && (
                        <span className={cn("truncate", isMobile && "max-w-[120px]")}>
                            {description}
                        </span>
                    )}
                    {diffStats && (
                        <span className="text-muted-foreground/60 flex-shrink-0">
                            <span style={{ color: 'var(--status-success)' }}>+{diffStats.added}</span>
                            {' '}
                            <span style={{ color: 'var(--status-error)' }}>-{diffStats.removed}</span>
                        </span>
                    )}
                    {typeof effectiveTimeStart === 'number' && (
                        <span className="text-muted-foreground/80 flex-shrink-0 tabular-nums">
                            <LiveDuration
                                start={effectiveTimeStart}
                                end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                active={Boolean(isTaskTool && isActive && typeof effectiveTimeEnd !== 'number')}
                            />
                        </span>
                    )}
                    {endedTimestampText ? (
                        <span
                            className={cn(
                                'text-muted-foreground/70 flex-shrink-0 tabular-nums transition-opacity duration-150',
                                'opacity-0 group-hover/tool:opacity-100'
                            )}
                        >
                            {endedTimestampText}
                        </span>
                    ) : null}
                </div>
            </div>

            {}
            {isTaskTool && (taskSummaryEntries.length > 0 || isActive || isFinalized || taskSessionId) ? (
                <TaskToolSummary
                    entries={taskSummaryEntries}
                    isExpanded={isExpanded}
                    hasPrevTool={hasPrevTool}
                    hasNextTool={hasNextTool}
                    output={taskOutputString}
                    sessionId={taskSessionId}
                    onShowPopup={onShowPopup}
                    input={input}
                />
            ) : null}

            {!isTaskTool && isExpanded ? (
                <ToolExpandedContent
                    part={part}
                    state={state}
                    syntaxTheme={syntaxTheme}
                    isMobile={isMobile}
                    currentDirectory={currentDirectory}
                    onShowPopup={onShowPopup}
                    hasPrevTool={hasPrevTool}
                    hasNextTool={hasNextTool}
                />
            ) : null}
        </div>
    );
};

export default ToolPart;
