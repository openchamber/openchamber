
import { cn } from '@/lib/utils';
import { typography } from '@/lib/typography';
import { formatToolInput, detectToolOutputLanguage } from '@/lib/toolHelpers';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { Icon } from "@/components/icon/Icon";
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';

export type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

const cleanOutput = (output: string) => {
    let cleaned = output.replace(/^<file>\s*\n?/, '').replace(/\n?<\/file>\s*$/, '');
    cleaned = cleaned.replace(/^\s*\d{5}\|\s?/gm, '');
    return cleaned.trim();
};

export const hasLspDiagnostics = (output: string): boolean => {
    if (!output) return false;
    return output.includes('<diagnostics')
        || output.includes('<file_diagnostics>')
        || output.includes('LSP errors detected')
        || output.includes('This file has errors');
};

const stripLspDiagnostics = (output: string): string => {
    if (!output) return '';
    return output
        .replace(/\n{0,2}LSP errors detected[\s\S]*?<diagnostics[^>]*>[\s\S]*?<\/diagnostics>/g, '')
        .replace(/\n{0,2}This file has errors[\s\S]*?<\/file_diagnostics>/g, '')
        .replace(/<diagnostics[^>]*>[\s\S]*?<\/diagnostics>/g, '')
        .replace(/<file_diagnostics>[\s\S]*?<\/file_diagnostics>/g, '')
        .trim();
};

const formatInputForDisplay = (input: Record<string, unknown>, toolName?: string) => {
    if (!input || typeof input !== 'object') {
        return String(input);
    }
    return formatToolInput(input, toolName || '');
};

const getPatchText = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    if (value && typeof value === 'object') {
        const patch = (value as { patch?: unknown }).patch;
        if (typeof patch === 'string') {
            const trimmed = patch.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
    }

    return undefined;
};

const getToolMetadataPatch = (metadata?: Record<string, unknown>): string | undefined => {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }

    const topLevelPatch = getPatchText((metadata as { patch?: unknown }).patch) ?? getPatchText(metadata.diff);
    if (topLevelPatch) {
        return topLevelPatch;
    }

    const files = Array.isArray((metadata as { files?: unknown }).files) ? (metadata as { files: unknown[] }).files : [];
    for (const file of files) {
        if (!file || typeof file !== 'object') {
            continue;
        }
        const patch = getPatchText((file as { patch?: unknown }).patch) ?? getPatchText((file as { diff?: unknown }).diff);
        if (patch) {
            return patch;
        }
    }

    return undefined;
};

export const tryParseJsonOutput = (output: string): { data: unknown; isJson: boolean } => {
    if (!output || typeof output !== 'string') {
        return { data: null, isJson: false };
    }

    const trimmed = output.trim();

    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return { data: null, isJson: false };
    }

    if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
        return { data: null, isJson: false };
    }

    if (trimmed.length < 2) {
        return { data: null, isJson: false };
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
            return { data: parsed, isJson: true };
        }
        return { data: null, isJson: false };
    } catch {
        return { data: null, isJson: false };
    }
};

export const formatEditOutput = (output: string, toolName: string, metadata?: Record<string, unknown>): string => {
    let cleaned = cleanOutput(output);

    if ((toolName === 'edit' || toolName === 'multiedit' || toolName === 'write' || toolName === 'apply_patch') && hasLspDiagnostics(cleaned)) {
        cleaned = stripLspDiagnostics(cleaned);
    }

    if ((toolName === 'edit' || toolName === 'multiedit' || toolName === 'apply_patch') && cleaned.trim().length === 0) {
        const diff = getToolMetadataPatch(metadata);
        if (diff) {
            return diff;
        }
    }

    return cleaned;
};

export interface ParsedReadOutputLine {
    text: string;
    lineNumber: number | null;
    isInfo: boolean;
}

export interface ParsedReadToolOutput {
    type: 'file' | 'directory' | 'unknown';
    lines: ParsedReadOutputLine[];
}

export const parseReadToolOutput = (output: string): ParsedReadToolOutput => {
    const typeMatch = output.match(/<type>(file|directory)<\/type>/i);
    const detectedType = (typeMatch?.[1]?.toLowerCase() ?? 'unknown') as ParsedReadToolOutput['type'];

    const contentMatch = output.match(/<content>([\s\S]*?)<\/content>/i);
    const rawContent = contentMatch?.[1] ?? output;
    const normalizedContent = rawContent.replace(/\r\n/g, '\n');
    const rawLines = normalizedContent.split('\n');

    const isTruncationInfoLine = (text: string): boolean => {
        return /\(\s*File has more lines\..*offset.*\)/i.test(text.trim());
    };

    const parsedLines = rawLines.map((line): ParsedReadOutputLine => {
        const trimmed = line.trim();
        const isInfo = (trimmed.startsWith('(') && trimmed.endsWith(')')) || isTruncationInfoLine(trimmed);

        if (detectedType !== 'directory') {
            const numberedMatch = line.match(/^(\d+):\s?(.*)$/);
            if (numberedMatch) {
                const numberedText = numberedMatch[2];
                const numberedTrimmed = numberedText.trim();
                const numberedIsInfo =
                    (numberedTrimmed.startsWith('(') && numberedTrimmed.endsWith(')'))
                    || isTruncationInfoLine(numberedTrimmed);
                return {
                    lineNumber: numberedIsInfo ? null : Number(numberedMatch[1]),
                    text: numberedText,
                    isInfo: numberedIsInfo,
                };
            }
        }

        return {
            lineNumber: null,
            text: line,
            isInfo,
        };
    });

    const lines = parsedLines.filter((line, index, arr) => {
        if (line.text.trim().length > 0) {
            return true;
        }

        const prev = arr[index - 1];
        const next = arr[index + 1];
        const adjacentToInfo = Boolean(prev?.isInfo || next?.isInfo);
        const hasNumber = line.lineNumber !== null;

        // Drop numbered blank lines wrapped around helper/info rows.
        if (adjacentToInfo && hasNumber) {
            return false;
        }

        return true;
    });

    return {
        type: detectedType,
        lines,
    };
};

export const renderListOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length === 0) return null;

        const items: Array<{ name: string; depth: number; isFile: boolean }> = [];
        lines.forEach((line) => {
            const match = line.match(/^(\s*)(.+)$/);
            if (match) {
                const [, spaces, name] = match;
                const depth = Math.floor(spaces.length / 2);
                const isFile = !name.endsWith('/');
                items.push({
                    name: name.replace(/\/$/, ''),
                    depth,
                    isFile,
                });
            }
        });

        return (
            <div
                className={cn(
                    'w-full min-w-0 font-mono space-y-0.5',
                    options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30'
                )}
                style={typography.tool.popup}
            >
                {items.map((item, idx) => (
                    <div key={idx} className="min-w-0" style={{ paddingLeft: `${item.depth * 20}px` }}>
                        {item.isFile ? (
                            <span className="text-foreground/90 block truncate">{item.name}</span>
                        ) : (
                            <span className="font-semibold text-foreground block truncate">{item.name}/</span>
                        )}
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

const GREP_DOT_STYLE = { backgroundColor: 'var(--status-info)', opacity: 0.6 };

export const renderGrepOutput = (output: string, isMobile: boolean, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length === 0) return null;

        const fileGroups: Record<string, Array<{ lineNum: string; content: string }>> = {};

        lines.forEach((line) => {
            const match = line.match(/^(.+?):(\d+):(.*)$/) || line.match(/^(.+?):(.*)$/);
            if (match) {
                const [, filepath, lineNumOrContent, content] = match;
                const lineNum = content !== undefined ? lineNumOrContent : '';
                const actualContent = content !== undefined ? content : lineNumOrContent;

                if (!fileGroups[filepath]) {
                    fileGroups[filepath] = [];
                }
                fileGroups[filepath].push({ lineNum, content: actualContent });
            }
        });

        return (
            <div
                className={cn(
                    'space-y-2 w-full min-w-0',
                    options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30'
                )}
                style={typography.tool.popup}
            >
                <div className="typography-meta text-muted-foreground mb-2">
                    Found {lines.length} match{lines.length !== 1 ? 'es' : ''}
                </div>
                {Object.entries(fileGroups).map(([filepath, matches]) => (
                    <div key={filepath} className="space-y-1">
                        <div className={cn('font-medium text-muted-foreground', isMobile ? 'typography-micro' : 'typography-code')}>
                            {filepath}
                        </div>
                        <div className="pl-4 space-y-1">
                            {matches.map((match, idx) => {
                                if (!match.lineNum && !match.content) {
                                    return null;
                                }
                                return (
                                    <div key={idx} className={cn('flex items-start gap-2 min-w-0', isMobile ? 'typography-micro' : 'typography-code')}>
                                        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={GREP_DOT_STYLE} />
                                        <div className="flex gap-2 min-w-0 flex-1">
                                            {match.lineNum && (
                                                <span className="text-muted-foreground font-mono whitespace-nowrap">
                                                    Line {match.lineNum}:
                                                </span>
                                            )}
                                            <span className="text-foreground font-mono break-words flex-1">
                                                {match.content || '\u00A0'}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );

    } catch {
        return null;
    }
};

const GLOB_DOT_STYLE = { backgroundColor: 'var(--status-info)', opacity: 0.6 };

export const renderGlobOutput = (output: string, isMobile: boolean, options?: { unstyled?: boolean }) => {
    try {
        const paths = output.trim().split('\n').filter(Boolean);
        if (paths.length === 0) return null;

        const groups: Record<string, string[]> = {};
        paths.forEach((path) => {
            const lastSlash = path.lastIndexOf('/');
            const dir = lastSlash > 0 ? path.substring(0, lastSlash) : '/';
            const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

            if (!groups[dir]) {
                groups[dir] = [];
            }
            groups[dir].push(filename);
        });

        const sortedDirs = Object.keys(groups).sort();

        return (
            <div
                className={cn(
                    'space-y-2 w-full min-w-0',
                    options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30'
                )}
                style={typography.tool.popup}
            >
                <div className="typography-meta text-muted-foreground mb-2">
                    Found {paths.length} file{paths.length !== 1 ? 's' : ''}
                </div>
                {sortedDirs.map((dir) => (
                    <div key={dir} className="space-y-1">
                        <div className={cn('font-medium text-muted-foreground', isMobile ? 'typography-micro' : 'typography-code')}>
                            {dir}/
                        </div>
                        <div className={cn('pl-4 grid gap-1', isMobile ? 'grid-cols-1' : 'grid-cols-2')}>
                            {groups[dir].sort().map((filename) => (
                                <div key={filename} className={cn('flex items-center gap-2 min-w-0', isMobile ? 'typography-micro' : 'typography-code')}>
                                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={GLOB_DOT_STYLE} />
                                    <span className="text-foreground font-mono truncate">{filename}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

type Todo = {
    id?: string;
    content: string;
    status: 'in_progress' | 'pending' | 'completed' | 'cancelled';
    priority?: 'high' | 'medium' | 'low';
};

export const renderTodoOutput = (
    output: string,
    labels: {
        total: string;
        inProgress: string;
        pending: string;
        completed: string;
        cancelled: string;
    },
    options?: { unstyled?: boolean },
) => {
    try {
        const todos = JSON.parse(output) as Todo[];
        if (!Array.isArray(todos)) {
            return null;
        }

        const todosByStatus = todos.reduce((acc, t) => {
            const status = t.status as keyof typeof acc;
            if (status in acc) acc[status].push(t);
            return acc;
        }, { in_progress: [] as Todo[], pending: [] as Todo[], completed: [] as Todo[], cancelled: [] as Todo[] });

        const getPriorityDot = (priority?: string) => {
            const baseClasses = 'w-2 h-2 rounded-full flex-shrink-0 mt-1';
            switch (priority) {
                case 'high':
                    return <div className={baseClasses} style={{ backgroundColor: 'var(--status-error)' }} />;
                case 'medium':
                    return <div className={baseClasses} style={{ backgroundColor: 'var(--primary)' }} />;
                case 'low':
                    return <div className={baseClasses} style={{ backgroundColor: 'var(--status-info)' }} />;
                default:
                    return <div className={baseClasses} style={{ backgroundColor: 'var(--muted-foreground)', opacity: 0.5 }} />;
            }
        };

        return (
            <div
                className={cn(
                    'space-y-3 w-full min-w-0',
                    options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30'
                )}
                style={typography.tool.popup}
            >
                <div className="flex gap-4 typography-meta pb-2 border-b border-border/20">
                    <span className="font-medium" style={{ color: 'var(--muted-foreground)' }}>{labels.total}: {todos.length}</span>
                    {todosByStatus.in_progress.length > 0 && (
                        <span className="font-medium" style={{ color: 'var(--foreground)' }}>{labels.inProgress}: {todosByStatus.in_progress.length}</span>
                    )}
                    {todosByStatus.pending.length > 0 && (
                        <span style={{ color: 'var(--muted-foreground)' }}>{labels.pending}: {todosByStatus.pending.length}</span>
                    )}
                    {todosByStatus.completed.length > 0 && (
                        <span style={{ color: 'var(--status-success)' }}>{labels.completed}: {todosByStatus.completed.length}</span>
                    )}
                    {todosByStatus.cancelled.length > 0 && (
                        <span style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>{labels.cancelled}: {todosByStatus.cancelled.length}</span>
                    )}
                </div>

                {todosByStatus.in_progress.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: 'var(--foreground)' }} />
                            <span className="typography-meta font-semibold text-foreground uppercase tracking-wide">{labels.inProgress}</span>
                        </div>
                        <div className="space-y-1.5 pl-4">
                            {todosByStatus.in_progress.map((todo, idx) => (
                                <div key={todo.id || idx} className="flex items-start gap-2">
                                    {getPriorityDot(todo.priority)}
                                    <span className="typography-code text-foreground flex-1 leading-relaxed">{todo.content}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {todosByStatus.pending.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
                            <span className="typography-meta font-semibold text-muted-foreground uppercase tracking-wide">{labels.pending}</span>
                        </div>
                        <div className="space-y-1.5 pl-4">
                            {todosByStatus.pending.map((todo, idx) => (
                                <div key={todo.id || idx} className="flex items-start gap-2">
                                    {getPriorityDot(todo.priority)}
                                    <span className="typography-code text-foreground flex-1 leading-relaxed">{todo.content}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {todosByStatus.completed.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Icon name="check" className="w-3 h-3"  style={{ color: 'var(--status-success)' }}/>
                            <span className="typography-meta font-semibold uppercase tracking-wide" style={{ color: 'var(--status-success)' }}>{labels.completed}</span>
                        </div>
                        <div className="space-y-1.5 pl-4">
                            {todosByStatus.completed.map((todo, idx) => (
                                <div key={todo.id || idx} className="flex items-start gap-2">
                                    <Icon name="check" className="w-3 h-3 mt-0.5 flex-shrink-0"  style={{ color: 'var(--status-success)', opacity: 0.7 }}/>
                                    <span className="typography-code text-foreground flex-1 leading-relaxed">{todo.content}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {todosByStatus.cancelled.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <span className="w-3 h-3 text-muted-foreground/50">×</span>
                            <span className="typography-meta font-semibold text-muted-foreground/50 uppercase tracking-wide">{labels.cancelled}</span>
                        </div>
                        <div className="space-y-1.5 pl-4">
                            {todosByStatus.cancelled.map((todo, idx) => (
                                <div key={todo.id || idx} className="flex items-start gap-2">
                                    <span className="w-3 h-3 text-muted-foreground/50 mt-0.5 flex-shrink-0">×</span>
                                    <span className="typography-code text-muted-foreground/50 line-through flex-1 leading-relaxed">{todo.content}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderWebSearchOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        return (
            <div
                className={cn(
                    'typography-code max-w-none w-full min-w-0',
                    options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/20'
                )}
                style={typography.tool.popup}
            >
                <SimpleMarkdownRenderer content={output} variant="tool" />
            </div>
        );
    } catch {
        return null;
    }
};

export type DiffLineType = 'context' | 'added' | 'removed';

export interface UnifiedDiffLine {
    type: DiffLineType;
    lineNumber: number | null;
    content: string;
}

export interface UnifiedDiffHunk {
    file: string;
    oldStart: number;
    newStart: number;
    lines: UnifiedDiffLine[];
}

export interface SideBySideDiffLine {
    leftLine: { type: 'context' | 'removed' | 'empty'; lineNumber: number | null; content: string };
    rightLine: { type: 'context' | 'added' | 'empty'; lineNumber: number | null; content: string };
}

export interface SideBySideDiffHunk {
    file: string;
    oldStart: number;
    newStart: number;
    lines: SideBySideDiffLine[];
}

export const parseDiffToUnified = (diffText: string): UnifiedDiffHunk[] => {
    const lines = diffText.split('\n');
    let currentFile = '';
    const hunks: UnifiedDiffHunk[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('Index:') || line.startsWith('===') || line.startsWith('---') || line.startsWith('+++')) {
            if (line.startsWith('Index:')) {
                currentFile = line.split(' ')[1].split('/').pop() || 'file';
            }
            i++;
            continue;
        }

        if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
            const oldStart = match ? parseInt(match[1]) : 0;
            const newStart = match ? parseInt(match[2]) : 0;

            const unifiedLines: UnifiedDiffLine[] = [];
            let oldLineNum = oldStart;
            let newLineNum = newStart;
            let j = i + 1;

            while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('Index:')) {
                const contentLine = lines[j];
                if (contentLine.startsWith('+')) {
                    unifiedLines.push({ type: 'added', lineNumber: newLineNum, content: contentLine.substring(1) });
                    newLineNum++;
                } else if (contentLine.startsWith('-')) {
                    unifiedLines.push({ type: 'removed', lineNumber: oldLineNum, content: contentLine.substring(1) });
                    oldLineNum++;
                } else if (contentLine.startsWith(' ')) {
                    unifiedLines.push({ type: 'context', lineNumber: newLineNum, content: contentLine.substring(1) });
                    oldLineNum++;
                    newLineNum++;
                }
                j++;
            }

            hunks.push({
                file: currentFile,
                oldStart,
                newStart,
                lines: unifiedLines,
            });

            i = j;
            continue;
        }

        i++;
    }

    return hunks;
};

export const parseDiffToLines = (diffText: string): SideBySideDiffHunk[] => {
    const lines = diffText.split('\n');
    let currentFile = '';
    const hunks: SideBySideDiffHunk[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('Index:') || line.startsWith('===') || line.startsWith('---') || line.startsWith('+++')) {
            if (line.startsWith('Index:')) {
                currentFile = line.split(' ')[1].split('/').pop() || 'file';
            }
            i++;
            continue;
        }

        if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
            const oldStart = match ? parseInt(match[1]) : 0;
            const newStart = match ? parseInt(match[2]) : 0;

            const changes: Array<{
                type: 'context' | 'added' | 'removed';
                content: string;
                oldLine?: number;
                newLine?: number;
            }> = [];

            let oldLineNum = oldStart;
            let newLineNum = newStart;
            let j = i + 1;

            while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('Index:')) {
                const contentLine = lines[j];
                if (contentLine.startsWith('+')) {
                    changes.push({ type: 'added', content: contentLine.substring(1), newLine: newLineNum });
                    newLineNum++;
                } else if (contentLine.startsWith('-')) {
                    changes.push({ type: 'removed', content: contentLine.substring(1), oldLine: oldLineNum });
                    oldLineNum++;
                } else if (contentLine.startsWith(' ')) {
                    changes.push({
                        type: 'context',
                        content: contentLine.substring(1),
                        oldLine: oldLineNum,
                        newLine: newLineNum,
                    });
                    oldLineNum++;
                    newLineNum++;
                }
                j++;
            }

            const alignedLines: Array<{
                leftLine: { type: 'context' | 'removed' | 'empty'; lineNumber: number | null; content: string };
                rightLine: { type: 'context' | 'added' | 'empty'; lineNumber: number | null; content: string };
            }> = [];

            const leftSide: Array<{ type: 'context' | 'removed'; lineNumber: number; content: string }> = [];
            const rightSide: Array<{ type: 'context' | 'added'; lineNumber: number; content: string }> = [];

            changes.forEach((change) => {
                if (change.type === 'context') {
                    leftSide.push({ type: 'context', lineNumber: change.oldLine!, content: change.content });
                    rightSide.push({ type: 'context', lineNumber: change.newLine!, content: change.content });
                } else if (change.type === 'removed') {
                    leftSide.push({ type: 'removed', lineNumber: change.oldLine!, content: change.content });
                } else if (change.type === 'added') {
                    rightSide.push({ type: 'added', lineNumber: change.newLine!, content: change.content });
                }
            });

            const alignmentPoints: Array<{ leftIdx: number; rightIdx: number }> = [];

            leftSide.forEach((leftItem, leftIdx) => {
                if (leftItem.type === 'context') {
                    const rightIdx = rightSide.findIndex((rightItem, rIdx) =>
                        rightItem.type === 'context' &&
                        rightItem.content === leftItem.content &&
                        !alignmentPoints.some((ap) => ap.rightIdx === rIdx)
                    );
                    if (rightIdx >= 0) {
                        alignmentPoints.push({ leftIdx, rightIdx });
                    }
                }
            });

            alignmentPoints.sort((a, b) => a.leftIdx - b.leftIdx);

            let leftIdx = 0;
            let rightIdx = 0;
            let alignIdx = 0;

            while (leftIdx < leftSide.length || rightIdx < rightSide.length) {
                const nextAlign = alignIdx < alignmentPoints.length ? alignmentPoints[alignIdx] : null;

                if (nextAlign && leftIdx === nextAlign.leftIdx && rightIdx === nextAlign.rightIdx) {
                    const leftItem = leftSide[leftIdx];
                    const rightItem = rightSide[rightIdx];

                    alignedLines.push({
                        leftLine: {
                            type: 'context',
                            lineNumber: leftItem.lineNumber,
                            content: leftItem.content,
                        },
                        rightLine: {
                            type: 'context',
                            lineNumber: rightItem.lineNumber,
                            content: rightItem.content,
                        },
                    });

                    leftIdx++;
                    rightIdx++;
                    alignIdx++;
                } else {
                    const needProcessLeft = leftIdx < leftSide.length && (!nextAlign || leftIdx < nextAlign.leftIdx);
                    const needProcessRight = rightIdx < rightSide.length && (!nextAlign || rightIdx < nextAlign.rightIdx);

                    if (needProcessLeft && needProcessRight) {
                        const leftItem = leftSide[leftIdx];
                        const rightItem = rightSide[rightIdx];

                        alignedLines.push({
                            leftLine: {
                                type: leftItem.type,
                                lineNumber: leftItem.lineNumber,
                                content: leftItem.content,
                            },
                            rightLine: {
                                type: rightItem.type,
                                lineNumber: rightItem.lineNumber,
                                content: rightItem.content,
                            },
                        });

                        leftIdx++;
                        rightIdx++;
                    } else if (needProcessLeft) {
                        const leftItem = leftSide[leftIdx];
                        alignedLines.push({
                            leftLine: {
                                type: leftItem.type,
                                lineNumber: leftItem.lineNumber,
                                content: leftItem.content,
                            },
                            rightLine: {
                                type: 'empty',
                                lineNumber: null,
                                content: '',
                            },
                        });
                        leftIdx++;
                    } else if (needProcessRight) {
                        const rightItem = rightSide[rightIdx];
                        alignedLines.push({
                            leftLine: {
                                type: 'empty',
                                lineNumber: null,
                                content: '',
                            },
                            rightLine: {
                                type: rightItem.type,
                                lineNumber: rightItem.lineNumber,
                                content: rightItem.content,
                            },
                        });
                        rightIdx++;
                    } else {
                        break;
                    }
                }
            }

            hunks.push({
                file: currentFile,
                oldStart,
                newStart,
                lines: alignedLines,
            });

            i = j;
            continue;
        }

        i++;
    }

    return hunks;
};

export const detectLanguageFromOutput = (output: string, toolName: string, input?: Record<string, unknown>) => {
    return detectToolOutputLanguage(toolName, output, input);
};

export const renderLspDiagnosticsOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length === 0) return null;

        const diagnostics: Array<{ severity: string; file: string; line: number; col: number; code: string; message: string }> = [];
        lines.forEach((line) => {
            const match = line.match(/^(error|warning|info|hint)\[([^\]]+)\]\s*\((\d+)\)\s*at\s+([^:]+):(\d+):(\d+):\s*(.+)$/);
            if (match) {
                const [, severity, , code, file, lineNum, col, message] = match;
                diagnostics.push({ severity, file, line: Number(lineNum), col: Number(col), code, message });
            }
        });

        const grouped = diagnostics.reduce((acc, d) => {
            if (!acc[d.severity]) acc[d.severity] = [];
            acc[d.severity].push(d);
            return acc;
        }, {} as Record<string, typeof diagnostics>);

        const severityOrder = ['error', 'warning', 'info', 'hint'];
        const severityColors = {
            error: 'var(--status-error)',
            warning: 'var(--status-warning)',
            info: 'var(--status-info)',
            hint: 'var(--muted-foreground)'
        };

        return (
            <div className={cn('space-y-3 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                {severityOrder.filter(s => grouped[s]).map(severity => (
                    <div key={severity} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                            <Icon name={severity === 'error' ? 'close-circle' : severity === 'warning' ? 'error-warning' : 'information'} className="h-3.5 w-3.5" style={{ color: severityColors[severity as keyof typeof severityColors] }} />
                            <span className="typography-meta font-semibold uppercase tracking-wide" style={{ color: severityColors[severity as keyof typeof severityColors] }}>{severity} ({grouped[severity].length})</span>
                        </div>
                        <div className="pl-5 space-y-1">
                            {grouped[severity].map((d, idx) => (
                                <div key={idx} className="typography-code text-foreground/90">
                                    <span className="text-muted-foreground">{d.file}:{d.line}:{d.col}</span> - {d.message}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
                {diagnostics.length === 0 && output && (
                    <div className="space-y-1.5">
                        <span className="typography-meta text-muted-foreground">{output}</span>
                    </div>
                )}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderLspGotoDefinitionOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const locations = output.trim().split('\n').filter(Boolean);
        if (locations.length === 0) return null;

        return (
            <div className={cn('space-y-1 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                {locations.map((loc, idx) => {
                    const match = loc.match(/^(.+):(\d+):(\d+)$/);
                    if (!match) return null;
                    const [, file, line, col] = match;
                    return (
                        <div key={idx} className="flex items-center gap-2">
                            <Icon name="file-text" className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="typography-code text-foreground font-mono truncate">{file}:{line}:{col}</span>
                        </div>
                    );
                })}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderLspFindReferencesOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        const refs = output.trim().split('\n').filter(Boolean);
        if (refs.length === 0) return null;

        const grouped: Record<string, Array<{ line: number; col: number }>> = {};
        refs.forEach(ref => {
            const match = ref.match(/^(.+):(\d+):(\d+)$/);
            if (match) {
                const [, file, line, col] = match;
                if (!grouped[file]) grouped[file] = [];
                grouped[file].push({ line: Number(line), col: Number(col) });
            }
        });

        return (
            <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="typography-meta text-muted-foreground">
                    {t ? t('chat.toolPart.foundReferences', { count: refs.length }) : `Found ${refs.length} reference${refs.length !== 1 ? 's' : ''}`}
                </div>
                {Object.entries(grouped).map(([file, locs]) => (
                    <div key={file} className="space-y-1">
                        <div className="typography-code font-medium text-muted-foreground">{file} ({locs.length})</div>
                        <div className="pl-4 space-y-0.5">
                            {locs.map((loc, idx) => (
                                <div key={idx} className="typography-code text-foreground/90">Line {loc.line}:{loc.col}</div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

export { formatInputForDisplay };

export const renderLspSymbolsOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length === 0) return null;

        const symbols: Array<{ depth: number; type: string; name: string }> = [];
        lines.forEach(line => {
            const spaces = line.match(/^(\s*)/)?.[1].length || 0;
            const depth = Math.floor(spaces / 2);
            const text = line.trim();
            const match = text.match(/^(function|variable|class|method|interface|type)\s+(.+)$/);
            if (match) {
                symbols.push({ depth, type: match[1], name: match[2] });
            }
        });

        const typeIcons: Record<string, string> = {
            function: 'function',
            variable: 'variable',
            class: 'stack',
            method: 'function',
            interface: 'file-code',
            type: 'file-code'
        };

        return (
            <div className={cn('space-y-0.5 w-full min-w-0 font-mono', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                {symbols.map((sym, idx) => (
                    <div key={idx} style={{ paddingLeft: `${sym.depth * 20}px` }} className="flex items-center gap-2">
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        <Icon name={(typeIcons[sym.type] || 'file') as any} className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="typography-code text-foreground">{sym.name}</span>
                        <span className="typography-micro text-muted-foreground/60">{sym.type}</span>
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderLspRenameOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        const match = output.match(/Applied\s+(\d+)\s+edit\(s\)\s+to\s+(\d+)\s+file\(s\):/);
        if (!match) return null;

        const [, edits, files] = match;
        const fileLines = output.split('\n').slice(1).filter(l => l.trim().startsWith('-'));
        const fileList = fileLines.map(l => l.trim().replace(/^-\s*/, ''));

        return (
            <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="flex items-center gap-2">
                    <Icon name="checkbox-circle" className="h-4 w-4" style={{ color: 'var(--status-success)' }} />
                    <span className="typography-meta font-medium" style={{ color: 'var(--status-success)' }}>
                        {t ? t('chat.toolPart.renameCompleted') : 'Rename completed'}
                    </span>
                </div>
                <div className="typography-code text-foreground">Applied {edits} edit(s) to {files} file(s)</div>
                {fileList.length > 0 && (
                    <div className="pl-4 space-y-0.5">
                        {fileList.map((file, idx) => (
                            <div key={idx} className="typography-code text-muted-foreground">{file}</div>
                        ))}
                    </div>
                )}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderLspPrepareRenameOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        const match = output.match(/Rename available at\s+(\d+):(\d+)-(\d+):(\d+)\s+\(current:\s+"([^"]+)"\)/);
        if (!match) return null;

        const [, startLine, startCol, endLine, endCol, currentName] = match;

        return (
            <div className={cn('space-y-1 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="flex items-center gap-2">
                    <Icon name="information" className="h-3.5 w-3.5" style={{ color: 'var(--status-info)' }} />
                    <span className="typography-meta font-medium" style={{ color: 'var(--status-info)' }}>
                        {t ? t('chat.toolPart.renameAvailable') : 'Rename available'}
                    </span>
                </div>
                <div className="typography-code text-foreground">Current name: <span className="font-semibold">{currentName}</span></div>
                <div className="typography-code text-muted-foreground">Range: {startLine}:{startCol} - {endLine}:{endCol}</div>
            </div>
        );
    } catch {
        return null;
    }
};

export const renderSessionListOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length < 2) return null;

        const rows = lines.slice(1).filter(l => l.startsWith('|') && !l.includes('---'));
        const sessions = rows.map(row => {
            const cols = row.split('|').map(c => c.trim()).filter(Boolean);
            if (cols.length >= 5) {
                return { id: cols[0], messages: cols[1], first: cols[2], last: cols[3], agents: cols[4] };
            }
            return null;
        }).filter(Boolean);

        return (
            <div className={cn('w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="typography-meta text-muted-foreground mb-2">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</div>
                <div className="space-y-2">
                    {sessions.map((s, idx) => s && (
                        <div key={idx} className="p-2 rounded-lg border border-border/20 bg-surface-elevated/50">
                            <div className="flex items-center gap-2 mb-1">
                                <Icon name="chat-3" className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                                <span className="typography-code font-semibold text-foreground font-mono">{s.id}</span>
                            </div>
                            <div className="typography-micro text-muted-foreground space-y-0.5 pl-5">
                                <div>{s.messages} messages • {s.first} to {s.last}</div>
                                <div>Agents: {s.agents}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    } catch {
        return null;
    }
};

export const renderSessionReadOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n');
        const messages: Array<{ id: string; role: string; timestamp: string; content: string }> = [];
        
        let i = 0;
        while (i < lines.length) {
            const match = lines[i].match(/^\[Message\s+(\d+)\]\s+(user|assistant)\s+\(([^)]+)\)$/);
            if (match) {
                const [, id, role, timestamp] = match;
                const contentLines: string[] = [];
                i++;
                while (i < lines.length && !lines[i].match(/^\[Message\s+\d+\]/)) {
                    if (lines[i].trim()) contentLines.push(lines[i]);
                    i++;
                }
                messages.push({ id, role, timestamp, content: contentLines.join('\n') });
            } else {
                i++;
            }
        }

        return (
            <div className={cn('space-y-3 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                {messages.map((msg, idx) => (
                    <div key={idx} className="space-y-1">
                        <div className="flex items-center gap-2">
                            <Icon name={msg.role === 'user' ? 'user' : 'robot'} className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="typography-meta font-semibold text-foreground">{msg.role}</span>
                            <span className="typography-micro text-muted-foreground">{msg.timestamp}</span>
                        </div>
                        <div className="typography-code text-foreground/90 pl-5 whitespace-pre-wrap">{msg.content}</div>
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderSessionInfoOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        const info: Record<string, string> = {};
        lines.forEach(line => {
            const match = line.match(/^([^:]+):\s*(.+)$/);
            if (match) {
                info[match[1].trim()] = match[2].trim();
            }
        });

        return (
            <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                {Object.entries(info).map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                        <span className="typography-meta font-medium text-muted-foreground min-w-[120px]">{key}:</span>
                        <span className="typography-code text-foreground flex-1">{value}</span>
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderSessionSearchOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        const matches: Array<{ session: string; message: string; role: string; excerpt: string }> = [];
        
        lines.forEach(line => {
            const match = line.match(/^\[([^\]]+)\]\s+Message\s+([^\s]+)\s+\(([^)]+)\)$/);
            if (match) {
                const [, session, message, role] = match;
                matches.push({ session, message, role, excerpt: '' });
            } else if (matches.length > 0 && line.trim()) {
                matches[matches.length - 1].excerpt += line + '\n';
            }
        });

        return (
            <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="typography-meta text-muted-foreground mb-2">Found {matches.length} match{matches.length !== 1 ? 'es' : ''}</div>
                {matches.map((m, idx) => (
                    <div key={idx} className="p-2 rounded-lg border border-border/20 bg-surface-elevated/50 space-y-1">
                        <div className="flex items-center gap-2">
                            <Icon name="search" className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="typography-code font-mono text-foreground">{m.session}</span>
                            <span className="typography-micro text-muted-foreground">({m.role})</span>
                        </div>
                        <div className="typography-code text-foreground/80 pl-5 whitespace-pre-wrap">{m.excerpt.trim()}</div>
                    </div>
                ))}
            </div>
        );
    } catch {
        return null;
    }
};

export const renderBackgroundOutputOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        if (output.includes('# Task Status')) {
            const lines = output.split('\n');
            const info: Record<string, string> = {};
            lines.forEach(line => {
                const match = line.match(/^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|$/);
                if (match && !match[1].includes('---')) {
                    const key = match[1].trim();
                    const value = match[2].trim().replace(/`/g, '').replace(/\*\*/g, '');
                    if (key !== 'Field') info[key] = value;
                }
            });

            return (
                <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                    <div className="flex items-center gap-2 mb-2">
                        <Icon name="loader-4" className="h-4 w-4 animate-spin" style={{ color: 'var(--status-info)' }} />
                        <span className="typography-meta font-semibold" style={{ color: 'var(--status-info)' }}>
                            {t ? t('chat.toolPart.taskRunning') : 'Task Running'}
                        </span>
                    </div>
                    {Object.entries(info).map(([key, value]) => (
                        <div key={key} className="flex gap-2">
                            <span className="typography-meta font-medium text-muted-foreground min-w-[100px]">{key}:</span>
                            <span className="typography-code text-foreground flex-1">{value}</span>
                        </div>
                    ))}
                </div>
            );
        }

        if (output.includes('Task Result')) {
            const lines = output.split('\n');
            const taskId = lines.find(l => l.startsWith('Task ID:'))?.replace('Task ID:', '').trim();
            const description = lines.find(l => l.startsWith('Description:'))?.replace('Description:', '').trim();
            const duration = lines.find(l => l.startsWith('Duration:'))?.replace('Duration:', '').trim();
            const dividerIdx = lines.findIndex(l => l.trim() === '---');
            const content = dividerIdx >= 0 ? lines.slice(dividerIdx + 1).join('\n').trim() : '';

            return (
                <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                    <div className="flex items-center gap-2">
                        <Icon name="checkbox-circle" className="h-4 w-4" style={{ color: 'var(--status-success)' }} />
                        <span className="typography-meta font-semibold" style={{ color: 'var(--status-success)' }}>
                            {t ? t('chat.toolPart.taskCompleted') : 'Task Completed'}
                        </span>
                    </div>
                    {taskId && <div className="typography-code text-muted-foreground">Task ID: {taskId}</div>}
                    {description && <div className="typography-code text-foreground">{description}</div>}
                    {duration && <div className="typography-micro text-muted-foreground">Duration: {duration}</div>}
                    {content && (
                        <div className="mt-2 pt-2 border-t border-border/20">
                            <div className="typography-code text-foreground whitespace-pre-wrap">{content}</div>
                        </div>
                    )}
                </div>
            );
        }

        return null;
    } catch {
        return null;
    }
};

export const renderMonitorOutputOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        const data = JSON.parse(output);
        if (!data.lines || !Array.isArray(data.lines)) return null;

        return (
            <div className={cn('space-y-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="flex items-center gap-2">
                    <Icon name="terminal-box" className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="typography-meta font-medium text-foreground">
                        {t ? t('chat.toolPart.monitorOutput') : 'Monitor Output'}
                    </span>
                    {data.counters && (
                        <span className="typography-micro text-muted-foreground ml-auto">
                            {data.counters.total_lines} lines
                            {data.counters.matches > 0 && ` • ${data.counters.matches} matches`}
                        </span>
                    )}
                </div>
                <div className="font-mono text-sm space-y-0.5 max-h-[40vh] overflow-y-auto">
                    {data.lines.map((line: string, idx: number) => (
                        <div key={idx} className="typography-code text-foreground/90">{line}</div>
                    ))}
                </div>
            </div>
        );
    } catch {
        return null;
    }
};

export const renderSkillOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        return (
            <div className={cn('w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <SimpleMarkdownRenderer content={output} variant="tool" />
            </div>
        );
    } catch {
        return null;
    }
};

export const renderSkillMcpOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const parsed = JSON.parse(output);
        if (Array.isArray(parsed)) {
            const textContent = parsed
                .filter((item) => item.type === 'text' && typeof item.text === 'string')
                .map((item) => item.text)
                .join('\n\n');
            
            if (textContent) {
                return (
                    <div className={cn('w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                        <SimpleMarkdownRenderer content={textContent} variant="tool" />
                    </div>
                );
            }
        }
        return null;
    } catch {
        return renderSkillOutput(output, options);
    }
};

export const renderHashlineEditOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        const isError = output.toLowerCase().includes('error:');
        const icon = isError ? 'close-circle' : 'checkbox-circle';
        const color = isError ? 'var(--status-error)' : 'var(--status-success)';

        return (
            <div className={cn('space-y-1 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    <Icon name={icon as any} className="h-4 w-4" style={{ color }} />
                    <span className="typography-meta font-semibold" style={{ color }}>
                        {isError ? (t ? t('chat.toolPart.editFailed') : 'Edit Failed') : (t ? t('chat.toolPart.editApplied') : 'Edit Applied')}
                    </span>
                </div>
                <div className="typography-code text-foreground whitespace-pre-wrap pl-6">{output}</div>
            </div>
        );
    } catch {
        return null;
    }
};

type ContentType = 'json' | 'html' | 'markdown' | 'text';

const detectContentType = (output: string): ContentType => {
    const trimmed = output.trim();
    
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch {
            return 'text';
        }
    }
    
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
        return 'html';
    }
    
    if (trimmed.includes('##') || trimmed.includes('```') || /^#\s/.test(trimmed)) {
        return 'markdown';
    }
    
    return 'text';
};

export const renderWebFetchOutput = (output: string, options?: { unstyled?: boolean }) => {
    const WebFetchContent = () => {
        const contentType = detectContentType(output);
        
        const container = (children: React.ReactNode) => (
            <div className={cn('w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                <div className="typography-meta text-muted-foreground mb-2">
                    Content type: {contentType}
                </div>
                {children}
            </div>
        );
        
        if (contentType === 'json') {
            try {
                const parsed = JSON.parse(output.trim());
                return container(<JsonTreeViewer data={parsed} maxHeight="60vh" />);
            } catch {
                return container(<pre className="typography-code text-foreground whitespace-pre-wrap">{output}</pre>);
            }
        }
        
        if (contentType === 'markdown') {
            return container(<SimpleMarkdownRenderer content={output} variant="tool" />);
        }
        
        if (contentType === 'html') {
            return container(
                <WorkerHighlightedCode
                    code={output}
                    language="html"
                />
            );
        }
        
        return container(<pre className="typography-code text-foreground whitespace-pre-wrap">{output}</pre>);
    };

    try {
        return <WebFetchContent />;
    } catch {
        return null;
    }
};

export const renderCodeSearchOutput = (output: string, options?: { unstyled?: boolean }, t?: TranslateFn) => {
    try {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length === 0) return null;

        const fileGroups: Record<string, Array<{ lineNum: string; content: string }>> = {};
        let currentRepo = '';

        lines.forEach((line) => {
            const repoMatch = line.match(/^\*\*(.+?)\*\*$/);
            if (repoMatch) {
                currentRepo = repoMatch[1];
                return;
            }

            const match = line.match(/^(.+?):(\d+):(.*)$/) || line.match(/^(.+?):(.*)$/);
            if (match) {
                const [, filepath, lineNumOrContent, content] = match;
                const lineNum = content !== undefined ? lineNumOrContent : '';
                const actualContent = content !== undefined ? content : lineNumOrContent;

                const fullPath = currentRepo ? `${currentRepo}/${filepath}` : filepath;

                if (!fileGroups[fullPath]) {
                    fileGroups[fullPath] = [];
                }
                fileGroups[fullPath].push({ lineNum, content: actualContent });
            }
        });

        if (Object.keys(fileGroups).length === 0) return null;

        const totalMatches = Object.values(fileGroups).reduce((sum, matches) => sum + matches.length, 0);

        return (
            <div
                className={cn(
                    'space-y-2 w-full min-w-0',
                    options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30'
                )}
                style={typography.tool.popup}
            >
                <div className="typography-meta text-muted-foreground mb-2">
                    {t ? t('chat.toolPart.codesearchResults', { count: totalMatches, files: Object.keys(fileGroups).length }) : `Found ${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${Object.keys(fileGroups).length} file${Object.keys(fileGroups).length !== 1 ? 's' : ''}`}
                </div>
                {Object.entries(fileGroups).map(([filepath, matches]) => (
                    <div key={filepath} className="space-y-1">
                        <div className="flex items-center gap-2 pl-6">
                            <Icon name="file-code" className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--primary)' }} />
                            <span className="typography-code font-medium text-muted-foreground">{filepath}</span>
                        </div>
                        <div className="pl-6 space-y-1">
                            {matches.map((match, idx) => {
                                if (!match.lineNum && !match.content) {
                                    return null;
                                }
                                return (
                                    <div key={idx} className="flex items-start gap-2 min-w-0 typography-code">
                                        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ backgroundColor: 'var(--status-info)', opacity: 0.6 }} />
                                        <div className="flex gap-2 min-w-0 flex-1">
                                            {match.lineNum && (
                                                <span className="text-muted-foreground font-mono whitespace-nowrap">
                                                    Line {match.lineNum}:
                                                </span>
                                            )}
                                            <span className="text-foreground font-mono break-words flex-1">
                                                {match.content || '\u00A0'}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );

    } catch {
        return null;
    }
};

export const renderStructuredOutput = (output: string, options?: { unstyled?: boolean }) => {
    const StructuredOutputContent = () => {
        const { t } = useI18n();
        
        try {
            const parsed = JSON.parse(output);
            if (parsed === null || typeof parsed !== 'object') return null;
            
            return (
                <div className={cn('w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                    <div className="typography-meta text-muted-foreground mb-2">
                        {t('chat.toolPart.structuredData')}
                    </div>
                    <JsonTreeViewer 
                        data={parsed} 
                        initiallyExpandedDepth={2}
                        maxHeight="400px"
                    />
                </div>
            );
        } catch {
            return null;
        }
    };

    return <StructuredOutputContent />;
};

export const renderPlanModeOutput = (output: string, toolName: string, options?: { unstyled?: boolean }) => {
    const PlanModeContent = () => {
        const { t } = useI18n();
        const isEnter = toolName === 'plan_enter';
        const isError = output.toLowerCase().includes('error');
        
        const icon = isError ? 'close-circle' : (isEnter ? 'play' : 'stop');
        const color = isError ? 'var(--status-error)' : (isEnter ? 'var(--status-success)' : 'var(--status-info)');
        const label = isEnter ? t('chat.toolPart.enteringPlanMode') : t('chat.toolPart.exitingPlanMode');
        
        return (
            <div className={cn('flex items-center gap-2 w-full min-w-0', options?.unstyled ? null : 'p-3 bg-muted/20 rounded-xl border border-border/30')} style={typography.tool.popup}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <Icon name={icon as any} className="h-4 w-4 flex-shrink-0" style={{ color }} />
                <span className="typography-meta font-medium" style={{ color }}>
                    {label}
                </span>
                {output !== label && (
                    <span className="typography-meta text-muted-foreground">
                        {output.replace(label, '').trim()}
                    </span>
                )}
            </div>
        );
    };

    try {
        return <PlanModeContent />;
    } catch {
        return null;
    }
};
