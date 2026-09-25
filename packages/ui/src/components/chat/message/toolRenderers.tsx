import { carriesFileDiffs, isFileChangeTool } from '@/lib/opencode/tools';

import { cn } from '@/lib/utils';
import { typography } from '@/lib/typography';
import { formatToolInput, detectToolOutputLanguage } from '@/lib/toolHelpers';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { parseWebSearchOutput } from '@/lib/opencode/websearch';
import { WebSearchResults } from './parts/WebSearchResults';

const cleanOutput = (output: string) => {
    let cleaned = output.replace(/^<file>\s*\n?/, '').replace(/\n?<\/file>\s*$/, '');
    cleaned = cleaned.replace(/^\s*\d{5}\|\s?/gm, '');
    return cleaned.trim();
};

export const coerceToText = (value: unknown, fallback = ''): string => {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return fallback;
    }
};

// Guards the renderer process against V8 "Zone Allocation failed" OOM crashes
// (issue #2265). When a tool returns oversized external content — e.g. a fetched
// web page with full-resolution base64 images inlined — the entire payload flows
// through this module as a single JS string that is JSON.parsed, syntax
// highlighted, and attached to the DOM. A large enough single string exceeds
// V8's Zone allocator and hard-crashes the renderer before any virtualization or
// CSS clip can help. Capping the string length before that work happens keeps a
// useful head of the output while preventing the pathological allocation.
export const TOOL_OUTPUT_MAX_CHARS = 512 * 1024;

export const capToolOutputText = (
    output: string,
    maxChars: number = TOOL_OUTPUT_MAX_CHARS,
): string => {
    if (typeof output !== 'string' || output.length <= maxChars) {
        return output;
    }
    const omitted = output.length - maxChars;
    const notice = `\n\n… [output truncated: ${omitted} more characters not shown to prevent the renderer from running out of memory]`;
    return output.slice(0, maxChars) + notice;
};

const hasLspDiagnostics = (output: string): boolean => {
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

    if (isFileChangeTool(toolName) && hasLspDiagnostics(cleaned)) {
        cleaned = stripLspDiagnostics(cleaned);
    }

    if (carriesFileDiffs(toolName) && cleaned.trim().length === 0) {
        const diff = getToolMetadataPatch(metadata);
        if (diff) {
            return diff;
        }
    }

    return cleaned;
};

interface ParsedReadOutputLine {
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

export const renderWebSearchOutput = (output: string, options?: { unstyled?: boolean }) => {
    try {
        const parsed = parseWebSearchOutput(output);
        if (parsed) {
            return (
                <div className={cn('w-full min-w-0', options?.unstyled ? null : 'p-2 bg-muted/20 rounded-xl border border-border/20')}>
                    <WebSearchResults output={parsed} providerId={null} />
                </div>
            );
        }
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

type DiffLineType = 'context' | 'added' | 'removed';

interface UnifiedDiffLine {
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

export const parseDiffToUnified = (diffText: string): UnifiedDiffHunk[] => {
    const lines = diffText.split('\n');
    let currentFile = '';
    const hunks: UnifiedDiffHunk[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.startsWith('Index:') || line.startsWith('===') || line.startsWith('---') || line.startsWith('+++')) {
            if (line.startsWith('Index:')) {
                currentFile = line.slice('Index:'.length).trim().split('/').pop() || 'file';
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

export const detectLanguageFromOutput = (output: string, toolName: string, input?: Record<string, unknown>) => {
    return detectToolOutputLanguage(toolName, output, input);
};

export { formatInputForDisplay };
