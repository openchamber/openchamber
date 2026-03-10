
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { RiArrowDownSLine, RiArrowRightSLine, RiExternalLinkLine } from '@remixicon/react';
import { File as PierreFile, PatchDiff } from '@pierre/diffs/react';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { getToolMetadata, getLanguageFromExtension, isImageFile, getImageMimeType } from '@/lib/toolHelpers';
import type { ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@opencode-ai/sdk/v2';
import { toolDisplayStyles } from '@/lib/typography';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { opencodeClient } from '@/lib/opencode/client';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Text } from '@/components/ui/text';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { MessageRecord } from '@/lib/messageCompletion';

import {
    formatEditOutput,
    detectLanguageFromOutput,
    formatInputForDisplay,
} from '../toolRenderers';
import { DiffViewToggle, type DiffViewMode } from '../DiffViewToggle';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { getToolIcon } from './toolPresentation';

type ToolStateWithMetadata = ToolStateUnion & { metadata?: Record<string, unknown>; input?: Record<string, unknown>; output?: string; error?: string; time?: { start: number; end?: number } };

interface ToolPartProps {
    part: ToolPartType;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    syntaxTheme: { [key: string]: React.CSSProperties };
    isMobile: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}

const getMultiFileDescription = (
    metadata: Record<string, unknown> | undefined,
    animate = true,
): React.ReactNode => {
    const files = Array.isArray(metadata?.files) ? metadata?.files : [];
    if (files.length <= 1) return null;

    const parseCount = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, Math.trunc(value));
        }
        if (typeof value === 'string') {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) {
                return Math.max(0, parsed);
            }
        }
        return null;
    };

    const combineCounts = (base: number | null, incoming: number | null): number | null => {
        if (base === null) return incoming;
        if (incoming === null) return base;
        return base + incoming;
    };

    const entriesByPath = new Map<string, { path: string; name: string; added: number | null; removed: number | null }>();

    for (const file of files) {
        const fileObj = file as { relativePath?: string; filePath?: string; additions?: unknown; deletions?: unknown };
        const filePath = fileObj.relativePath || fileObj.filePath || '';
        if (!filePath) continue;
        const fileName = filePath.split('/').pop() || filePath;
        const added = parseCount(fileObj.additions);
        const removed = parseCount(fileObj.deletions);

        const existing = entriesByPath.get(filePath);
        if (existing) {
            existing.added = combineCounts(existing.added, added);
            existing.removed = combineCounts(existing.removed, removed);
            continue;
        }

        entriesByPath.set(filePath, { path: filePath, name: fileName, added, removed });
    }

    const entries = Array.from(entriesByPath.values());

    return (
        <>
            {entries.map((entry) => {
                const hasPerFileDiff = entry.added !== null || entry.removed !== null;
                return (
                    <span key={entry.path} className="inline-flex min-w-0 max-w-full items-center gap-1 typography-meta leading-5" style={{ color: 'var(--tools-description)' }}>
                        <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" />
                        <Text
                            variant={animate ? 'generate-effect' : undefined}
                            className="min-w-0 max-w-full truncate typography-meta leading-5"
                            style={{ color: 'var(--tools-description)' }}
                            title={entry.path}
                        >
                            {entry.name}
                        </Text>
                        {hasPerFileDiff ? (
                            <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                <span style={{ color: 'var(--status-success)' }}>+{entry.added ?? 0}</span>
                                <span style={{ color: 'var(--tools-description)' }}>/</span>
                                <span style={{ color: 'var(--status-error)' }}>-{entry.removed ?? 0}</span>
                            </span>
                        ) : null}
                    </span>
                );
            })}
        </>
    );
};

const normalizeToolName = (toolName: string | undefined | null): string => {
    if (typeof toolName !== 'string') {
        return '';
    }

    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) {
        return '';
    }

    if (trimmed.includes('.')) {
        const dotParts = trimmed.split('.').filter(Boolean);
        const last = dotParts[dotParts.length - 1];
        if (last) return last;
    }

    return trimmed;
};

const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes cap

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.min(Math.max(0, (end ?? now) - start), MAX_DURATION_MS);
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

const parseWriteLineCount = (input?: Record<string, unknown>): number | null => {
    if (!input?.content || typeof input.content !== 'string') return null;
    const lines = input.content.split('\n');
    return lines.length;
};

const extractFirstChangedLineFromDiff = (diffText: string): number | undefined => {
    if (!diffText || typeof diffText !== 'string') {
        return undefined;
    }

    const lines = diffText.split('\n');
    let currentNewLine: number | undefined;
    let firstHunkStart: number | undefined;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
            const parsed = Number.parseInt(hunkMatch[1] ?? '', 10);
            if (Number.isFinite(parsed)) {
                currentNewLine = Math.max(1, parsed);
                if (!Number.isFinite(firstHunkStart)) {
                    firstHunkStart = currentNewLine;
                }
            }
            continue;
        }

        if (currentNewLine === undefined || !Number.isFinite(currentNewLine)) {
            continue;
        }

        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
            continue;
        }

        if (line.startsWith('+')) {
            return currentNewLine;
        }

        if (line.startsWith(' ')) {
            currentNewLine += 1;
            continue;
        }

        if (line.startsWith('-') || line.startsWith('\\')) {
            continue;
        }
    }

    return firstHunkStart;
};

const getFirstChangedLineFromMetadata = (tool: string, metadata?: Record<string, unknown>): number | undefined => {
    if (!metadata || (tool !== 'edit' && tool !== 'multiedit' && tool !== 'apply_patch')) {
        return undefined;
    }

    if (typeof metadata.diff === 'string') {
        const line = extractFirstChangedLineFromDiff(metadata.diff);
        if (Number.isFinite(line)) {
            return line;
        }
    }

    const files = Array.isArray(metadata.files) ? metadata.files : [];
    const firstFile = files[0] as { diff?: unknown } | undefined;
    if (typeof firstFile?.diff === 'string') {
        const line = extractFirstChangedLineFromDiff(firstFile.diff);
        if (Number.isFinite(line)) {
            return line;
        }
    }

    return undefined;
};

const getPrimaryDiffFromMetadata = (
    tool: string,
    metadata?: Record<string, unknown>,
    preferredPath?: string,
): string | undefined => {
    if (!metadata || (tool !== 'edit' && tool !== 'multiedit' && tool !== 'apply_patch')) {
        return undefined;
    }

    const files = Array.isArray(metadata.files) ? metadata.files : [];
    if (files.length > 0) {
        const preferred = typeof preferredPath === 'string' && preferredPath.length > 0
            ? preferredPath
            : undefined;
        const matched = preferred
            ? files.find((file) => {
                if (!file || typeof file !== 'object') {
                    return false;
                }
                const candidate = file as { relativePath?: unknown; filePath?: unknown };
                return candidate.relativePath === preferred || candidate.filePath === preferred;
            })
            : files[0];

        if (matched && typeof matched === 'object') {
            const patch = (matched as { diff?: unknown }).diff;
            if (typeof patch === 'string' && patch.trim().length > 0) {
                return patch;
            }
        }
    }

    if (typeof metadata.diff === 'string' && metadata.diff.trim().length > 0) {
        return metadata.diff;
    }

    return undefined;
};

const getRelativePath = (absolutePath: string, currentDirectory: string): string => {
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

const getToolDescriptionPath = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string): string | null => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        const firstFile = files[0] as { relativePath?: string; filePath?: string } | undefined;
        const filePath = firstFile?.relativePath || firstFile?.filePath;
        if (files.length > 1) return null;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
        return null;
    }

    if ((part.tool === 'edit' || part.tool === 'multiedit') && input) {
        const filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    if (['write', 'create', 'file_write'].includes(part.tool) && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    return null;
};

const getToolDescription = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string): string => {
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;

    const filePathLabel = getToolDescriptionPath(part, state, currentDirectory);
    if (filePathLabel) {
        return filePathLabel;
    }

    if (part.tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files) ? metadata?.files : [];
        if (files.length > 1) {
            return `${files.length} files`;
        }
        return '';
    }

    // Question tool: show "Asked N question(s)"
    if (part.tool === 'question' && input?.questions && Array.isArray(input.questions)) {
        const count = input.questions.length;
        return `Asked ${count} question${count !== 1 ? 's' : ''}`;
    }

    if (part.tool === 'bash' && input?.command && typeof input.command === 'string') {
        const firstLine = input.command.split('\n')[0];
        return firstLine.substring(0, 100);
    }

    if (part.tool === 'task' && input?.description && typeof input.description === 'string') {
        return input.description.substring(0, 80);
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
        input?: Record<string, unknown>;
    };
};

type SessionMessageWithParts = MessageRecord;

const EMPTY_SESSION_MESSAGES: SessionMessageWithParts[] = [];

const normalizeSessionIdCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const readTaskSessionIdFromRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    return (
        normalizeSessionIdCandidate(record.sessionID)
        ?? normalizeSessionIdCandidate(record.sessionId)
    );
};

const readTaskSessionIdFromOutput = (output: string | undefined): string | undefined => {
    if (typeof output !== 'string' || output.trim().length === 0) {
        return undefined;
    }
    const parsedMetadata = parseTaskMetadataBlock(output);
    if (parsedMetadata.sessionId) {
        return parsedMetadata.sessionId;
    }
    const taskMatch = output.match(/task_id\s*:\s*([^\s<"']+)/i);
    const sessionMatch = output.match(/session[_\s-]?id\s*:\s*([^\s<"']+)/i);
    const candidate = taskMatch?.[1] ?? sessionMatch?.[1];
    return normalizeSessionIdCandidate(candidate);
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
            const toolName = normalizeToolName(part.tool);
            if (!toolName || toolName === 'task' || toolName === 'todowrite' || toolName === 'todoread') {
                continue;
            }
            const partState = part.state as { status?: string; title?: string; input?: unknown } | undefined;
            entries.push({
                id: part.id,
                tool: part.tool,
                state: {
                    status: partState?.status,
                    title: partState?.title,
                    input: partState?.input && typeof partState.input === 'object'
                        ? (partState.input as Record<string, unknown>)
                        : undefined,
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

    const input = entry.state?.input;
    if (input && typeof input === 'object') {
        const pathCandidate = input.filePath ?? input.file_path ?? input.path;
        if (typeof pathCandidate === 'string' && pathCandidate.trim().length > 0) {
            return pathCandidate.trim();
        }

        const urlCandidate = input.url;
        if (typeof urlCandidate === 'string' && urlCandidate.trim().length > 0) {
            return urlCandidate.trim();
        }
    }

    return '';
};

const FILE_PATH_LABEL_TOOLS = new Set([
    'read',
    'view',
    'file_read',
    'cat',
    'write',
    'create',
    'file_write',
    'edit',
    'multiedit',
    'apply_patch',
]);

const shouldRenderGitPathLabel = (toolName: string, label: string): boolean => {
    if (!FILE_PATH_LABEL_TOOLS.has(toolName.toLowerCase())) {
        return false;
    }

    const trimmed = label.trim();
    if (!trimmed || trimmed === 'Patch' || /^\d+\s+files$/.test(trimmed)) {
        return false;
    }

    return trimmed.includes('/') || trimmed.includes('\\');
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
            state?: { status?: unknown; title?: unknown; input?: unknown };
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
                input: record.state?.input && typeof record.state.input === 'object'
                    ? (record.state.input as Record<string, unknown>)
                    : undefined,
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
    isMobile: boolean;
    output?: string;
    sessionId?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
    animateTailText?: boolean;
    isActive?: boolean;
}> = ({ entries, isExpanded, isMobile, output, sessionId, onShowPopup, input, animateTailText = true, isActive = false }) => {
    const setCurrentSession = useSessionStore((state) => state.setCurrentSession);
    const displayEntries = entries;

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
        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]">
                <div className="typography-meta text-muted-foreground/70">
                    {isActive ? 'Waiting for subagent activity...' : 'No subagent session id on task metadata.'}
                </div>
            </div>
        );
    }

    const visibleEntries = isExpanded ? displayEntries : displayEntries.slice(-6);
    const hiddenCount = Math.max(0, displayEntries.length - visibleEntries.length);

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]',
                'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                'before:top-[-0.25rem] before:bottom-0'
            )}
        >
            {displayEntries.length > 0 ? (
                <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
                    <div className="w-full min-w-0 space-y-1">
                        {hiddenCount > 0 ? (
                            <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
                        ) : null}

                        {visibleEntries.map((entry, idx) => {
                            const normalizedToolName = normalizeToolName(entry.tool);
                            const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
                            const label = getTaskSummaryLabel(entry);
                            const hasLabel = label.trim().length > 0;
                            const status = entry.state?.status;

                            const displayName = getToolMetadata(toolName).displayName;

                            return (
                                <ToolRevealOnMount key={entry.id ?? `${toolName}-${idx}`} animate={animateTailText} wipe>
                                    <div className={cn("flex gap-2 min-w-0 w-full", isMobile ? 'items-start' : 'items-center')}>
                                        <span className="flex-shrink-0 text-foreground/80">{getToolIcon(toolName)}</span>
                                        <span
                                            className="typography-meta text-foreground/80 flex-shrink-0"
                                            style={{ color: 'var(--tools-title)' }}
                                            title={displayName}
                                        >
                                            {displayName}
                                        </span>
                                        {hasLabel ? (
                                            status !== 'error' && shouldRenderGitPathLabel(toolName, label) ? (
                                                renderAnimatedPathWithIcon(label, animateTailText, true)
                                            ) : (
                                                status === 'error' ? (
                                                    <span className={cn(
                                                        'typography-meta flex-1 min-w-0 text-[var(--status-error)]',
                                                        isMobile ? 'whitespace-normal break-words' : 'truncate'
                                                    )}>
                                                        {label}
                                                    </span>
                                                ) : (
                                                    <Text
                                                        variant={animateTailText ? 'generate-effect' : undefined}
                                                        className={cn(
                                                            'typography-meta flex-1 min-w-0 text-muted-foreground/70',
                                                            isMobile ? 'whitespace-normal break-words' : 'truncate'
                                                        )}
                                                        style={{ color: 'var(--tools-description)' }}
                                                        title={label}
                                                    >
                                                        {label}
                                                    </Text>
                                                )
                                            )
                                        ) : null}
                                    </div>
                                </ToolRevealOnMount>
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

const renderPathLikeGitChanges = (path: string, grow = true) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return (
            <span
                className={cn('min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
                style={{ direction: 'rtl', textAlign: 'left' }}
                title={path}
            >
                {path}
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);

    return (
        <span className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
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

const renderAnimatedPathWithIcon = (path: string, animate = true, grow = true) => {
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1', grow && 'flex-1')} title={path}>
                <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" />
                <Text
                    key={animate ? `path-full-${path}` : undefined}
                    variant={animate ? 'generate-effect' : undefined}
                    className="min-w-0 truncate typography-meta"
                    style={{ color: 'var(--tools-title)' }}
                >
                    {path}
                </Text>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" />
            <span className={cn('min-w-0 inline-flex items-baseline overflow-hidden typography-meta', grow && 'flex-1')}>
                <Text
                    key={animate ? `path-dir-${dir}` : undefined}
                    variant={animate ? 'generate-effect' : undefined}
                    className="min-w-0 truncate typography-meta"
                    style={{ color: 'var(--tools-description)', direction: 'rtl', textAlign: 'left' }}
                >
                    {dir}
                </Text>
                <span className="flex-shrink-0 inline-flex items-baseline">
                    <Text variant={animate ? 'generate-effect' : undefined} className="typography-meta" style={{ color: 'var(--tools-description)' }}>
                        /
                    </Text>
                    <Text
                        key={animate ? `path-name-${name}` : undefined}
                        variant={animate ? 'generate-effect' : undefined}
                        className="typography-meta"
                        style={{ color: 'var(--tools-title)' }}
                    >
                        {name}
                    </Text>
                </span>
            </span>
        </span>
    );
};

const getDiffPatchEntries = (
    metadata: Record<string, unknown> | undefined,
    fallbackDiff: string,
    currentDirectory: string,
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
                ? getRelativePath(rawPath, currentDirectory)
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
            <div className="bg-muted/20 px-2 py-1 rounded-lg mb-1 flex items-center gap-2 min-w-0" style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}>
                {renderPathLikeGitChanges(displayPath)}
                <span className="typography-meta text-muted-foreground/80 flex-shrink-0">({headerLineLabel})</span>
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
            <div className="bg-muted/20 px-2 py-1 rounded-lg mb-2 flex items-center min-w-0" style={{ borderWidth: '1px', borderColor: 'var(--tools-border)' }}>
                {renderPathLikeGitChanges(displayPath)}
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
    currentDirectory: string;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    syntaxTheme,
    currentDirectory,
    onShowPopup,
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
        () => (diffContent ? getDiffPatchEntries(metadata, diffContent, currentDirectory) : []),
        [currentDirectory, diffContent, metadata]
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
        ? (writeFilePath ? getRelativePath(writeFilePath, currentDirectory) : 'New file')
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

        if (part.tool === 'task' && hasStringOutput) {
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
                'relative pr-2 pb-2 pt-2 space-y-2 pl-4'
            )}
        >
            {part.tool === 'question' ? (
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
    animateTailText = true,
}) => {
    const state = part.state;
    const currentDirectory = useDirectoryStore((s) => s.currentDirectory);

    const normalizedPartTool = normalizeToolName(part.tool);
    const isTaskTool = normalizedPartTool === 'task';

    const status = state?.status as string | undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    const isError = status === 'error' || status === 'failed';

    const [activeLatched, setActiveLatched] = React.useState<boolean>(!isFinalized);
    const previousPartIdRef = React.useRef<string | undefined>(part.id);

    React.useEffect(() => {
        if (previousPartIdRef.current === part.id) {
            return;
        }
        previousPartIdRef.current = part.id;
        // Reset latch only when tool identity changes.
        setActiveLatched(!isFinalized);
    }, [isFinalized, part.id]);

    React.useEffect(() => {
        if (!isFinalized) {
            setActiveLatched(true);
        }
    }, [isFinalized]);



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
    const partMetadata = (part as unknown as { metadata?: unknown }).metadata;
    const input = stateWithData.input;
    const time = stateWithData.time;

    const [pinnedTime, setPinnedTime] = React.useState<{ start?: number; end?: number }>({});
    const [localStartAt, setLocalStartAt] = React.useState<number | undefined>(undefined);
    const [localFinalizedAt, setLocalFinalizedAt] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        setPinnedTime({});
        setLocalStartAt(undefined);
        setLocalFinalizedAt(undefined);
    }, [part.id]);

    React.useEffect(() => {
        if (isFinalized) {
            return;
        }
        if (typeof time?.start === 'number') {
            return;
        }
        setLocalStartAt((prev) => prev ?? Date.now());
    }, [isFinalized, time?.start]);

    React.useEffect(() => {
        setPinnedTime((prev) => {
            const next = { ...prev };
            let changed = false;

            if (typeof time?.start === 'number' && (typeof prev.start !== 'number' || time.start < prev.start)) {
                next.start = time.start;
                changed = true;
            }

            if (typeof time?.end === 'number' && (typeof prev.end !== 'number' || time.end > prev.end)) {
                next.end = time.end;
                changed = true;
            }

            return changed ? next : prev;
        });
    }, [time?.end, time?.start]);

    const effectiveTimeStart = React.useMemo(() => {
        // Once we captured a local start (during pending, before server sends time.start),
        // always prefer it so the timer never jumps when server start arrives later.
        if (typeof localStartAt === 'number') {
            return localStartAt;
        }
        const candidates = [pinnedTime.start, time?.start].filter(
            (value): value is number => typeof value === 'number'
        );
        if (candidates.length === 0) {
            return undefined;
        }
        return Math.min(...candidates);
    }, [localStartAt, pinnedTime.start, time?.start]);

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

        const metadataSessionId = readTaskSessionIdFromRecord(metadata);
        if (metadataSessionId) {
            return metadataSessionId;
        }

        const partLevelSessionId = readTaskSessionIdFromRecord(partMetadata);
        if (partLevelSessionId) {
            return partLevelSessionId;
        }

        if (parsedTaskMetadata.sessionId) {
            return parsedTaskMetadata.sessionId;
        }
        return readTaskSessionIdFromOutput(taskOutputString);
    }, [isTaskTool, metadata, parsedTaskMetadata.sessionId, partMetadata, taskOutputString]);

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

    const childSessionHasInFlightTools = React.useMemo(() => {
        if (!isTaskTool || !taskSessionId || !Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return false;
        }

        for (const message of childSessionMessages) {
            if (message?.info?.role !== 'assistant') {
                continue;
            }
            const parts = Array.isArray(message.parts) ? message.parts : [];
            for (const childPart of parts) {
                if (childPart?.type !== 'tool') {
                    continue;
                }
                const childStatus =
                    typeof childPart === 'object' && childPart !== null && 'state' in childPart
                        ? (childPart.state as { status?: string } | undefined)?.status
                        : undefined;
                if (childStatus === 'running' || childStatus === 'pending' || childStatus === 'started') {
                    return true;
                }
            }
        }

        return false;
    }, [childSessionMessages, isTaskTool, taskSessionId]);

    React.useEffect(() => {
        if (typeof time?.end === 'number' || typeof pinnedTime.end === 'number') {
            setLocalFinalizedAt(undefined);
            return;
        }

        if (typeof effectiveTimeStart !== 'number') {
            return;
        }

        if (!isFinalized) {
            return;
        }

        setLocalFinalizedAt((prev) => prev ?? Date.now());
    }, [
        effectiveTimeStart,
        isFinalized,
        pinnedTime.end,
        time?.end,
    ]);

    const effectiveTimeEnd = isFinalized ? (pinnedTime.end ?? time?.end ?? localFinalizedAt) : undefined;
    const isActive = !isFinalized && activeLatched;
    const shouldTreatAsFinalized = isFinalized;

    const taskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (childSessionTaskSummaryEntries.length > 0) {
            return childSessionTaskSummaryEntries;
        }
        return metadataTaskSummaryEntries;
    }, [childSessionTaskSummaryEntries, metadataTaskSummaryEntries]);

    React.useEffect(() => {
        if (!isTaskTool || !taskSessionId) {
            return;
        }

        const shouldPoll = isActive || childSessionHasInFlightTools || childSessionTaskSummaryEntries.length === 0;
        const shouldFetchSnapshot = childSessionTaskSummaryEntries.length === 0 || shouldPoll;
        if (!shouldFetchSnapshot) {
            return;
        }

        let cancelled = false;
        let pollTimer: number | undefined;

        const fetchSessionMessages = async () => {
            try {
                const messages = await opencodeClient.getSessionMessages(taskSessionId, 500);
                if (cancelled || !Array.isArray(messages) || messages.length === 0) {
                    return;
                }
                useSessionStore.getState().syncMessages(taskSessionId, messages);
            } catch {
                // Ignore transient subagent fetch errors.
            }
        };

        void fetchSessionMessages();

        if (shouldPoll && typeof window !== 'undefined') {
            pollTimer = window.setInterval(() => {
                void fetchSessionMessages();
            }, 1200);
        }

        return () => {
            cancelled = true;
            if (typeof pollTimer === 'number') {
                window.clearInterval(pollTimer);
            }
        };
    }, [childSessionHasInFlightTools, childSessionTaskSummaryEntries.length, isActive, isTaskTool, taskSessionId]);


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

    const diffStats = (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch') ? parseDiffStats(metadata) : null;
    const writeLineCount = normalizedPartTool === 'write' ? parseWriteLineCount(input) : null;
    const isMultiFileApplyPatch = normalizedPartTool === 'apply_patch' && Array.isArray(metadata?.files) && (metadata?.files as []).length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as ToolPartType) : part;
    const descriptionPath = getToolDescriptionPath(normalizedPart, state, currentDirectory);
    const description = getToolDescription(normalizedPart, state, currentDirectory);
    const displayName = getToolMetadata(normalizedPartTool || part.tool).displayName;
    
    // Tool title/description — shown inline as context
    const justificationText = React.useMemo(() => {
        if (normalizedPartTool === 'apply_patch') {
            return null;
        }
        if (
            descriptionPath
            && (normalizedPartTool === 'apply_patch' || normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'write')
        ) {
            return null;
        }
        const title = (stateWithData as { title?: string }).title;
        if (typeof title === 'string' && title.trim().length > 0) {
            return title;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [descriptionPath, normalizedPartTool, stateWithData, input]);

    const runtime = React.useContext(RuntimeAPIContext);

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        if (isTaskTool || !runtime?.editor) {
            onToggle(part.id);
            return;
        }

        let filePath: unknown;
        let targetLine: number | undefined;
        let toolDiff: string | undefined;
        if (part.tool === 'edit' || part.tool === 'multiedit') {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            targetLine = getFirstChangedLineFromMetadata(part.tool, metadata);
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(part.tool, metadata, filePath);
            }
        } else if (part.tool === 'apply_patch') {
            const files = Array.isArray(metadata?.files) ? metadata?.files : [];
            const firstFile = files[0] as { relativePath?: string; filePath?: string } | undefined;
            filePath = firstFile?.relativePath || firstFile?.filePath;
            targetLine = getFirstChangedLineFromMetadata(part.tool, metadata);
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(part.tool, metadata, filePath);
            }
        } else if (['write', 'create', 'file_write'].includes(part.tool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            let absolutePath = filePath;
            if (!filePath.startsWith('/')) {
                absolutePath = currentDirectory.endsWith('/') ? currentDirectory + filePath : currentDirectory + '/' + filePath;
            }
            if (runtime.runtime.isVSCode && toolDiff && (part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch')) {
                const label = `${getRelativePath(absolutePath, currentDirectory)} (changes)`;
                void runtime.editor.openDiff('', absolutePath, label, { line: targetLine, patch: toolDiff });
                return;
            }
            runtime.editor.openFile(absolutePath, targetLine);
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

    if (!shouldTreatAsFinalized && !isActive && !isTaskTool) {
        return null;
    }

    return (
        <div>
            {}
            <div
                className={cn(
                    'group/tool flex gap-2 pr-2 pl-px py-1.5 rounded-xl cursor-pointer',
                    isMultiFileApplyPatch ? 'flex-wrap items-start' : 'items-center'
                )}
                onClick={handleMainClick}
                onKeyDown={handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className={cn('flex gap-2', isMultiFileApplyPatch ? 'w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5' : 'items-center flex-shrink-0')}>
                    {}
                    <div
                        className="relative h-3.5 w-3.5 flex-shrink-0 cursor-pointer"
                        onClick={(event) => { event.stopPropagation(); onToggle(part.id); }}
                    >
                        {}
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0'
                            )}
                            style={!isTaskTool && isError ? { color: 'var(--status-error)' } : { color: 'var(--tools-icon)' }}
                        >
                            {getToolIcon(normalizedPartTool || part.tool)}
                        </div>
                        {}
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity flex items-center justify-center',
                                isExpanded && 'opacity-100',
                                !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
                            )}
                        >
                            {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                        </div>
                    </div>
                    {isMultiFileApplyPatch ? (
                        <>
                            <MinDurationShineText
                                active={Boolean(isActive && !isError)}
                                minDurationMs={300}
                                className="typography-meta font-medium flex-shrink-0"
                                style={!isTaskTool && isError ? { color: 'var(--status-error)' } : { color: 'var(--tools-title)' }}
                                title={displayName}
                            >
                                {displayName}
                            </MinDurationShineText>
                            {typeof effectiveTimeStart === 'number' ? (
                                <span className="flex-shrink-0 tabular-nums text-muted-foreground/80 typography-meta">
                                    <LiveDuration
                                        start={effectiveTimeStart}
                                        end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                        active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
                                    />
                                </span>
                            ) : null}
                            {getMultiFileDescription(metadata, animateTailText)}
                        </>
                    ) : (
                        <>
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className="typography-meta font-medium flex-shrink-0"
                                    style={!isTaskTool && isError ? { color: 'var(--status-error)' } : { color: 'var(--tools-title)' }}
                                    title={displayName}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                            {typeof effectiveTimeStart === 'number' ? (
                                <span className="flex-shrink-0 tabular-nums text-muted-foreground/80 typography-meta">
                                    <LiveDuration
                                        start={effectiveTimeStart}
                                        end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                        active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
                                    />
                                </span>
                            ) : null}
                        </>
                    )}
                </div>

                {!isMultiFileApplyPatch && (
                    <div className="flex items-center gap-1 flex-1 min-w-0 typography-meta" style={{ color: 'var(--tools-description)' }}>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                            {justificationText && (
                                <span
                                    className="min-w-0 truncate typography-meta"
                                    style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && description && (
                                descriptionPath && description === descriptionPath ? (
                                    renderAnimatedPathWithIcon(descriptionPath, animateTailText, false)
                                ) : (
                                    <Text
                                        variant={animateTailText ? 'generate-effect' : undefined}
                                        className="min-w-0 truncate typography-meta"
                                        style={{ color: 'var(--tools-description)' }}
                                        title={description}
                                    >
                                        {description}
                                    </Text>
                                )
                            )}
                            {diffStats && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{diffStats.added}</span>
                                    <span style={{ color: 'var(--tools-description)' }}>/</span>
                                    <span style={{ color: 'var(--status-error)' }}>-{diffStats.removed}</span>
                                </span>
                            )}
                            {writeLineCount && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{writeLineCount}</span>
                                </span>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {}
            {isTaskTool && (taskSummaryEntries.length > 0 || isActive || shouldTreatAsFinalized || taskSessionId) ? (
                <TaskToolSummary
                    entries={taskSummaryEntries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    output={taskOutputString}
                    sessionId={taskSessionId}
                    onShowPopup={onShowPopup}
                    input={input}
                    animateTailText={animateTailText}
                    isActive={isActive}
                />
            ) : null}

            {!isTaskTool && isExpanded ? (
                <ToolExpandedContent
                    part={part}
                    state={state}
                    syntaxTheme={syntaxTheme}
                    currentDirectory={currentDirectory}
                    onShowPopup={onShowPopup}
                />
            ) : null}
        </div>
    );
};

export default ToolPart;
