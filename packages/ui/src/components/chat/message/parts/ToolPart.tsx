
import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { QuestionMarkdown } from '../../QuestionMarkdown';
import { MessageFilesDisplay } from '../../FileAttachment';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { ToolPart as ToolPartType, ToolState as ToolStateUnion, FilePart } from '@opencode-ai/sdk/v2';
import { toolDisplayStyles } from '@/lib/typography';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords, useEnsureSessionMessages } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Text } from '@/components/ui/text';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ToolPopupContent } from '../types';
import { PlainDiffFallback } from './PlainDiffFallback';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import {
    formatEditOutput,
    detectLanguageFromOutput,
    formatInputForDisplay,
    renderTodoOutput,
    tryParseJsonOutput,
    coerceToText,
    capToolOutputText,
} from '../toolRenderers';
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { JsonSummaryView } from './JsonSummaryView';
import { Icon } from "@/components/icon/Icon";
import { DiffViewToggle, type DiffViewMode } from '../DiffViewToggle';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { getToolIcon } from './toolPresentation';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
    buildTaskSummaryEntriesFromSession,
    normalizeTaskSummaryEntries,
    parseTaskMetadataBlock,
    prepareTaskToolOutput,
    readTaskSessionIdFromOutput,
    readTaskSessionIdFromRecord,
    type TaskToolSummaryEntry,
} from './taskToolModel';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { useI18n } from '@/lib/i18n';
import {
    extractFirstChangedLineFromDiff,
    getDiffPatchEntries,
    getFirstChangedLineFromMetadata,
    getMutatedToolPaths,
    getPatchText,
    getPrimaryDiffFromMetadata,
    getPrimaryToolPath,
    type DiffPatchEntry,
} from './toolDiffUtils';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { getStreamingOutputAppend, getToolOutput } from './toolOutput';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { getToolDescriptionFallback } from './toolRenderUtils';
import { ApplyPatchFileButtons } from './ApplyPatchFileButtons';
import { openApplyPatchFileInEditor } from './applyPatchEditorAction';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type ToolStateWithMetadata = ToolStateUnion & { metadata?: Record<string, unknown>; input?: Record<string, unknown>; output?: string; error?: string; time?: { start: number; end?: number }; attachments?: Array<FilePart> };

interface ToolPartProps {
    part: ToolPartType;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}

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

const GIT_REFRESH_MUTATING_TOOLS = new Set([
    'bash',
    'edit',
    'write',
    'apply_patch',
    'patch',
]);

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.max(0, (end ?? now) - start);
    const seconds = duration / 1000;

    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const now = useDurationTickerNow(active, 250);

    return <>{formatDuration(start, end, now)}</>;
};

const deferredToolBodyMounts: Array<{ active: boolean; fn: () => void }> = [];
let deferredToolBodyFrame: number | undefined;

const flushDeferredToolBodyMounts = () => {
    while (deferredToolBodyMounts.length > 0) {
        const item = deferredToolBodyMounts.pop();
        if (!item) {
            break;
        }
        if (item.active) {
            item.fn();
            deferredToolBodyFrame = deferredToolBodyMounts.length > 0
                ? window.requestAnimationFrame(flushDeferredToolBodyMounts)
                : undefined;
            return;
        }
    }

    deferredToolBodyFrame = undefined;
};

const scheduleDeferredToolBodyMount = (fn: () => void) => {
    if (typeof window === 'undefined') {
        fn();
        return () => undefined;
    }

    const item = { active: true, fn };
    deferredToolBodyMounts.push(item);

    if (deferredToolBodyFrame === undefined) {
        deferredToolBodyFrame = window.requestAnimationFrame(() => {
            deferredToolBodyFrame = window.requestAnimationFrame(flushDeferredToolBodyMounts);
        });
    }

    return () => {
        item.active = false;
    };
};

const useDeferredExpandedContent = (isExpanded: boolean) => {
    // If the tool is expanded when the row first mounts (e.g. "show tools open
    // by default", or scrolling a default-open tool back into a virtualized
    // view), render the body SYNCHRONOUSLY so the virtualizer measures the real
    // height immediately. Deferring it would let the row mount short and grow a
    // frame later, which makes the virtualizer compensate scroll and lurch the
    // viewport past several messages on slow scroll. Only defer LATER
    // user-initiated expansions, where instant single-item feedback isn't worth
    // blocking the click on a heavy body render.
    const [shouldRender, setShouldRender] = React.useState(isExpanded);
    const mountedRef = React.useRef(false);

    React.useEffect(() => {
        if (!isExpanded) {
            mountedRef.current = true;
            setShouldRender(false);
            return;
        }

        if (!mountedRef.current) {
            mountedRef.current = true;
            setShouldRender(true);
            return;
        }

        return scheduleDeferredToolBodyMount(() => {
            setShouldRender(true);
        });
    }, [isExpanded]);

    return shouldRender;
};

const parseDiffStats = (metadata?: Record<string, unknown>): { added: number; removed: number } | null => {
    const diffText = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff);
    if (!diffText) return null;

    let added = 0;
    let removed = 0;
    let lineStart = 0;

    for (let index = 0; index <= diffText.length; index += 1) {
        if (index < diffText.length && diffText.charCodeAt(index) !== 10) {
            continue;
        }

        const line = diffText.slice(lineStart, index);
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
        lineStart = index + 1;
    }

    if (added === 0 && removed === 0) return null;
    return { added, removed };
};

const parseWriteLineCount = (input?: Record<string, unknown>): number | null => {
    if (!input?.content || typeof input.content !== 'string') return null;
    let lines = 1;
    for (let index = 0; index < input.content.length; index += 1) {
        if (input.content.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
};

const buildWritePreviewPatch = (filePath: string | undefined, content: string): string | undefined => {
    const normalizedContent = content.replace(/\r\n/g, '\n');
    if (!normalizedContent.trim()) {
        return undefined;
    }

    const normalizedPath = (() => {
        const candidate = (filePath ?? '').trim();
        if (!candidate) {
            return 'new-file';
        }
        return candidate.startsWith('/') ? candidate.slice(1) : candidate;
    })();

    const lines = normalizedContent.split('\n');
    const hunkSize = lines.length;
    const body = lines.map((line) => `+${line}`).join('\n');

    return [
        '--- /dev/null',
        `+++ b/${normalizedPath}`,
        `@@ -0,0 +1,${hunkSize} @@`,
        body,
    ].join('\n');
};

const normalizeDisplayPath = (value: string): string => {
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!trimmed || trimmed === '/') {
        return trimmed;
    }
    return trimmed.replace(/\/+$/, '');
};

const getRelativePath = (absolutePath: string, currentDirectory: string): string => {
    const normalizedAbsolutePath = normalizeDisplayPath(absolutePath);
    const normalizedCurrentDirectory = normalizeDisplayPath(currentDirectory);

    if (!normalizedAbsolutePath) {
        return '';
    }

    if (!normalizedCurrentDirectory) {
        return normalizedAbsolutePath;
    }

    if (normalizedAbsolutePath === normalizedCurrentDirectory) {
        return '.';
    }

    const prefix = `${normalizedCurrentDirectory}/`;
    if (normalizedAbsolutePath.startsWith(prefix)) {
        return normalizedAbsolutePath.slice(prefix.length);
    }

    return normalizedAbsolutePath;
};

type ToolDiagnostic = {
    message: string;
    line: number;
    character: number;
};

type ToolDiagnosticSection = {
    displayPath: string;
    diagnostics: ToolDiagnostic[];
    remaining: number;
};

const TOOL_DIAGNOSTICS_MAX_PER_FILE = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const normalizeToolDiagnostic = (value: unknown): ToolDiagnostic | null => {
    if (!isRecord(value)) {
        return null;
    }

    const message = typeof value.message === 'string' ? value.message.trim() : '';
    if (!message) {
        return null;
    }

    const severity = typeof value.severity === 'number' && Number.isFinite(value.severity) ? Math.trunc(value.severity) : undefined;
    if (severity !== undefined && severity !== 1) {
        return null;
    }

    const range = isRecord(value.range) ? value.range : undefined;
    const start = range && isRecord(range.start) ? range.start : undefined;
    const rawLine = typeof start?.line === 'number' && Number.isFinite(start.line) ? Math.max(0, Math.trunc(start.line)) : 0;
    const rawCharacter = typeof start?.character === 'number' && Number.isFinite(start.character)
        ? Math.max(0, Math.trunc(start.character))
        : 0;

    return {
        message,
        line: rawLine + 1,
        character: rawCharacter + 1,
    };
};

const getToolDiagnosticSection = (
    toolName: string,
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined,
    currentDirectory: string,
): ToolDiagnosticSection | null => {
    if (!['edit', 'multiedit', 'write', 'apply_patch'].includes(toolName)) {
        return null;
    }

    const primaryPath = getPrimaryToolPath(toolName, input, metadata);
    if (!primaryPath || !metadata || !isRecord(metadata.diagnostics)) {
        return null;
    }

    const normalizedPath = normalizeDisplayPath(primaryPath);
    const absolutePath = normalizedPath.startsWith('/')
        ? normalizedPath
        : `${normalizeDisplayPath(currentDirectory)}/${normalizedPath}`.replace(/\/+/g, '/');

    const rawDiagnostics = (metadata.diagnostics as Record<string, unknown>)[normalizedPath]
        ?? (metadata.diagnostics as Record<string, unknown>)[absolutePath];
    if (!Array.isArray(rawDiagnostics)) {
        return null;
    }

    const diagnostics = rawDiagnostics
        .map((entry) => normalizeToolDiagnostic(entry))
        .filter((entry): entry is ToolDiagnostic => !!entry);
    if (diagnostics.length === 0) {
        return null;
    }

    const visible = diagnostics.slice(0, TOOL_DIAGNOSTICS_MAX_PER_FILE);
    return {
        displayPath: normalizedPath.startsWith('/') ? getRelativePath(normalizedPath, currentDirectory) : normalizedPath,
        diagnostics: visible,
        remaining: Math.max(0, diagnostics.length - visible.length),
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

    if (part.tool === 'read' && input) {
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

    if (part.tool === 'lsp' && input) {
        const filePath = input?.filePath || input?.file_path || input?.path;
        if (typeof filePath === 'string') {
            return getRelativePath(filePath, currentDirectory);
        }
    }

    return null;
};

const getLspToolDescription = (input: Record<string, unknown> | undefined, currentDirectory: string): string => {
    if (!input) {
        return '';
    }

    const operation = typeof input.operation === 'string' ? input.operation : 'lsp';
    if (operation === 'workspaceSymbol') {
        const query = typeof input.query === 'string' && input.query.trim().length > 0
            ? ` "${input.query.trim()}"`
            : '';
        return `${operation}${query}`;
    }

    const filePath = typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.path === 'string'
                ? input.path
                : '';
    const displayPath = filePath ? getRelativePath(filePath, currentDirectory) : '';

    if (operation === 'documentSymbol') {
        return displayPath ? `${operation} ${displayPath}` : operation;
    }

    const line = typeof input.line === 'number' && Number.isFinite(input.line) ? Math.trunc(input.line) : undefined;
    const character = typeof input.character === 'number' && Number.isFinite(input.character) ? Math.trunc(input.character) : undefined;
    const position = line !== undefined && character !== undefined ? `:${line}:${character}` : '';

    return displayPath ? `${operation} ${displayPath}${position}` : operation;
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

    if (part.tool === 'lsp') {
        return getLspToolDescription(input, currentDirectory);
    }

    const desc = input?.description || metadata?.description || ('title' in state && state.title) || '';
    return getToolDescriptionFallback(part.tool, desc, input);
};

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
    followKey?: string;
}

const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
    followKey,
}) => {
    const scrollRef = React.useRef<HTMLElement>(null);
    const isFollowingRef = React.useRef(true);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (followKey === undefined) {
            isFollowingRef.current = true;
            return;
        }
        if (!element || !isFollowingRef.current) {
            return;
        }
        element.scrollTop = element.scrollHeight;
    }, [followKey]);

    return (
        <div className={cn('w-full min-w-0 flex-none overflow-hidden', outerClassName)}>
            <ScrollShadow
                ref={scrollRef}
                data-scrollable="true"
                onWheelCapture={(event) => {
                    if (followKey !== undefined && event.deltaY < 0) {
                        isFollowingRef.current = false;
                    }
                }}
                onScroll={(event) => {
                    if (followKey === undefined) {
                        return;
                    }
                    const element = event.currentTarget;
                    isFollowingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
                }}
                className={cn(
                    'tool-output-surface p-2 rounded-xl w-full min-w-0',
                    maxHeightClass,
                    disableHorizontal ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
                    className,
                )}
            >
                <div className="w-full min-w-0">
                    {children}
                </div>
            </ScrollShadow>
        </div>
    );
};

const getToolOutputLanguage = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
    input: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return 'bash';
    }

    return detectLanguageFromOutput(formatEditOutput(output, part.tool, metadata), part.tool, input);
};

const getToolOutputText = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
): string => {
    // Cap oversized payloads before JSON.parse / syntax highlighting / DOM work
    // so a single huge tool output can't trigger a V8 Zone-allocation OOM that
    // hard-crashes the renderer (issue #2265).
    const capped = capToolOutputText(output);
    if (part.tool === 'bash') {
        return capped;
    }

    return formatEditOutput(capped, part.tool, metadata);
};

const StreamingPlainTextOutput: React.FC<{ output: string }> = ({ output }) => {
    const preRef = React.useRef<HTMLPreElement>(null);
    const previousOutputRef = React.useRef('');

    React.useLayoutEffect(() => {
        const element = preRef.current;
        if (!element) {
            return;
        }

        const firstChild = element.firstChild;
        const textNode = firstChild instanceof globalThis.Text
            ? firstChild
            : document.createTextNode('');
        if (textNode !== firstChild) {
            element.replaceChildren(textNode);
        }

        const append = getStreamingOutputAppend(previousOutputRef.current, output);
        if (append === undefined) {
            textNode.data = output;
        } else if (append.length > 0) {
            textNode.appendData(append);
        }
        previousOutputRef.current = output;
    }, [output]);

    return (
        <pre
            ref={preRef}
            className="m-0 whitespace-pre-wrap break-words"
            style={{
                ...TOOL_COLLAPSED_CUSTOM_STYLE,
                lineHeight: 'round(var(--code-block-line-height), 1px)',
                overflowWrap: 'break-word',
            }}
        />
    );
};

const ToolScrollableTextOutput: React.FC<{
    output: string;
    part: ToolPartType;
    metadata: Record<string, unknown> | undefined;
    input: Record<string, unknown> | undefined;
    isStreaming?: boolean;
}> = ({ output, part, metadata, input, isStreaming = false }) => {
    const { t } = useI18n();
    const renderedOutput = getToolOutputText(output, part, metadata);
    const outputLanguage = getToolOutputLanguage(output, part, metadata, input);
    const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
    const [jsonViewMode, setJsonViewMode] = React.useState<'summary' | 'formatted' | 'raw'>('summary');
    const [copiedJson, setCopiedJson] = React.useState(false);

    React.useEffect(() => {
        setJsonViewMode('summary');
        setCopiedJson(false);
    }, [renderedOutput]);

    const handleJsonViewChange = React.useCallback((view: 'summary' | 'formatted' | 'raw', event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setJsonViewMode(view);
    }, []);

    const handleCopyOutput = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const result = await copyTextToClipboard(renderedOutput);
        if (!result.ok) {
            toast.error(t('chat.toolPart.copyOutputFailed'));
            return;
        }
        setCopiedJson(true);
        if (typeof window !== 'undefined') {
            window.setTimeout(() => setCopiedJson(false), 1200);
        }
    }, [renderedOutput, t]);

    if (part.tool === 'bash' && isStreaming) {
        return (
            <div className="typography-code text-muted-foreground/90">
                <StreamingPlainTextOutput output={renderedOutput} />
            </div>
        );
    }

    if (jsonResult.isJson) {
        return (
            <div className="tool-output-surface relative p-2 rounded-xl w-full min-w-0">
                <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'summary' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('summary', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showNavigableJson')}
                        title={t('chat.toolPart.showNavigableJson')}
                    >
                        <Icon name="list-unordered" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'formatted' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('formatted', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showFormattedJson')}
                        title={t('chat.toolPart.showFormattedJson')}
                    >
                        <Icon name="node-tree" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'raw' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('raw', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={t('chat.toolPart.showRawJson')}
                        title={t('chat.toolPart.showRawJson')}
                    >
                        <Icon name="code-box" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 rounded-md bg-[var(--surface-elevated)]/80 text-muted-foreground hover:text-foreground"
                        onClick={handleCopyOutput}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={copiedJson ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
                        title={copiedJson ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
                    >
                        <Icon name={copiedJson ? 'check' : 'file-copy'} className="h-3.5 w-3.5" />
                    </Button>
                </div>
                {jsonViewMode === 'summary' ? (
                    <JsonSummaryView data={jsonResult.data} />
                ) : jsonViewMode === 'formatted' ? (
                    <JsonTreeViewer
                        data={jsonResult.data}
                        initiallyExpandedDepth={1}
                        maxHeight="400px"
                    />
                ) : (
                    <div className="typography-code pr-12 text-muted-foreground/90">
                        <WorkerHighlightedCode
                            language="json"
                            code={renderedOutput}
                            style={TOOL_COLLAPSED_CUSTOM_STYLE}
                            codeStyle={CODE_TAG_PROPS.style}
                            wrap
                        />
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={part.tool === 'bash' ? 'typography-code text-muted-foreground/90' : undefined}>
            <WorkerHighlightedCode
                language={outputLanguage}
                code={renderedOutput}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        </div>
    );
};

ToolScrollableTextOutput.displayName = 'ToolScrollableTextOutput';

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

    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return true;
    }

    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    if (baseName.startsWith('.') || baseName.includes('.')) {
        return true;
    }

    return /^[A-Za-z0-9_-]+$/.test(baseName);
};

const getTaskSummaryEntryRenderSignature = (entry: TaskToolSummaryEntry): string => {
    const toolName = normalizeToolName(entry.tool);
    const status = entry.state?.status ?? '';
    const label = getTaskSummaryLabel(entry);
    return `${entry.id ?? ''}\u0001${toolName}\u0001${status}\u0001${label}`;
};

const areTaskSummaryEntriesRenderEqual = (
    prevEntries: TaskToolSummaryEntry[],
    nextEntries: TaskToolSummaryEntry[],
): boolean => {
    if (prevEntries === nextEntries) return true;
    if (prevEntries.length !== nextEntries.length) return false;
    for (let index = 0; index < prevEntries.length; index += 1) {
        if (getTaskSummaryEntryRenderSignature(prevEntries[index]) !== getTaskSummaryEntryRenderSignature(nextEntries[index])) {
            return false;
        }
    }
    return true;
};

const TaskSummaryEntryRow = React.memo(({
    entry,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entry: TaskToolSummaryEntry;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const normalizedToolName = normalizeToolName(entry.tool);
    const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
    const label = getTaskSummaryLabel(entry);
    const hasLabel = label.trim().length > 0;
    const status = entry.state?.status;
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolRevealOnMount animate={animateTailText} wipe>
            {/* Single-line rows everywhere: the old mobile break-words mode
                wrapped long shell commands into a hanging column and floated
                the icon to the top of the block. Errors still wrap — they must
                stay readable. */}
            <div className={cn('flex gap-2 min-w-0 w-full', status === 'error' && isMobile ? 'items-start' : 'items-center')}>
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
                        renderAnimatedPathWithIcon(label, animateTailText, true, showToolFileIcons)
                    ) : (
                        status === 'error' ? (
                            <span className={cn(
                                'typography-meta flex-1 min-w-0 text-[var(--status-error)]',
                                isMobile ? 'whitespace-normal break-words' : 'truncate',
                            )}>
                                {label}
                            </span>
                        ) : (
                            <Text
                                variant={animateTailText ? 'generate-effect' : 'static'}
                                className="typography-meta flex-1 min-w-0 truncate text-muted-foreground/70"
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
}, (prev, next) => {
    return prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && getTaskSummaryEntryRenderSignature(prev.entry) === getTaskSummaryEntryRenderSignature(next.entry);
});

TaskSummaryEntryRow.displayName = 'TaskSummaryEntryRow';

const TaskSummaryEntriesList = React.memo(({
    entries,
    isExpanded,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const visibleEntries = isExpanded ? entries : entries.slice(-6);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);
    const visibleStartIndex = entries.length - visibleEntries.length;

    return (
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
            <div className="w-full min-w-0 space-y-1">
                {hiddenCount > 0 ? (
                    <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
                ) : null}

                {visibleEntries.map((entry, idx) => {
                    const absoluteIndex = isExpanded ? idx : visibleStartIndex + idx;
                    const rowKey = entry.id ?? `${getTaskSummaryEntryRenderSignature(entry)}:${absoluteIndex}`;
                    return (
                        <TaskSummaryEntryRow
                            key={rowKey}
                            entry={entry}
                            isMobile={isMobile}
                            animateTailText={animateTailText}
                            showToolFileIcons={showToolFileIcons}
                        />
                    );
                })}
            </div>
        </ToolScrollableSection>
    );
}, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && areTaskSummaryEntriesRenderEqual(prev.entries, next.entries);
});

TaskSummaryEntriesList.displayName = 'TaskSummaryEntriesList';

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
    const { t } = useI18n();
    const currentDirectory = useEffectiveDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const runtime = React.useContext(RuntimeAPIContext);

    const trimmedOutput = prepareTaskToolOutput(output);
    const hasOutput = trimmedOutput.length > 0;
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId && currentDirectory) {
            // In contexts with no ContextPanel (embedded session-chat iframe)
            // or single-surface layouts (mobile, VS Code), navigate in place.
            // Otherwise open a new side-panel tab.
            if (isEmbeddedSessionChat() || isMobile || runtime?.runtime.isVSCode) {
                setCurrentSession(sessionId, currentDirectory);
                return;
            }

            openContextPanelTab(currentDirectory, {
                mode: 'chat',
                dedupeKey: `session:${sessionId}`,
                label: agentType.charAt(0).toUpperCase() + agentType.slice(1),
                readOnly: true,
            });
        }
    };

    const agentType = typeof input?.subagent_type === 'string'
        ? input.subagent_type
        : 'subagent';

    if (entries.length === 0 && !hasOutput && !sessionId) {
        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]">
                <div className="typography-meta text-muted-foreground/70">
                    {isActive ? 'Waiting for subagent activity...' : 'No subagent session id on task metadata.'}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]',
                'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                'before:top-[-0.25rem] before:bottom-0'
            )}
        >
            {entries.length > 0 ? (
                <TaskSummaryEntriesList
                    entries={entries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    animateTailText={animateTailText}
                    showToolFileIcons={showToolFileIcons}
                />
            ) : null}

            {sessionId && (
                <button
                    type="button"
                    className="flex items-center gap-2 typography-meta text-primary hover:text-primary/80 w-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleOpenSession}
                >
                    <Icon name="external-link" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="typography-meta text-primary font-medium">{t('chat.toolPart.openSubtask', { type: agentType.charAt(0).toUpperCase() + agentType.slice(1) })}</span>
                </button>
            )}

            {hasOutput ? (
                <div className={cn('space-y-1', (entries.length > 0 || sessionId) && 'pt-1')}
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
                            <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        )}
                        <span className="typography-meta text-foreground/80 font-medium">{t('chat.toolPart.output')}</span>
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

const TOOL_COLLAPSED_CUSTOM_STYLE: React.CSSProperties = {
    ...toolDisplayStyles.getCollapsedStyles(),
    padding: 0,
    overflow: 'visible',
};

const CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent' } };

const TOOL_ERROR_ICON_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_ICON_STYLE: React.CSSProperties = { color: 'var(--tools-icon)' };
const TOOL_ERROR_TITLE_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
const TOOL_NORMAL_TITLE_STYLE: React.CSSProperties = { color: 'var(--tools-title)' };

const renderPathLikeGitChanges = (path: string, grow = true) => {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash === -1) {
        return (
            <span
                className={cn('min-w-0 truncate typography-ui-label text-foreground', grow && 'flex-1')}
                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                title={path}
            >
                {path}
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 flex items-baseline overflow-hidden typography-ui-label', grow && 'flex-1')} title={path}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0 text-muted-foreground">/</span> : null}
            <span className="min-w-0 truncate text-muted-foreground" style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}>
                {displayDir}
            </span>
            <span className="flex-shrink-0">
                <span className="text-muted-foreground">/</span>
                <span className="text-foreground">{name}</span>
            </span>
        </span>
    );
};

const renderAnimatedPathWithIcon = (path: string, animate = true, grow = true, showFileIcons = true) => {
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}
                    style={{ color: 'var(--tools-title)' }}
                >
                    {path}
                </Text>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS, grow && 'flex-1')}>
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
        </span>
    );
};

// The rich diff preview is the only tool-card piece that needs the
// @pierre/diffs + Shiki stack; lazy-loading it keeps that stack out of the
// eager chat graph. While the chunk loads, the plain-text patch renders as the
// Suspense fallback, mirroring the preview's own error fallback.
const LazyToolPartDiffPreview = lazyWithChunkRecovery(() => import('./ToolPartDiffPreview'));

const DiffPreview: React.FC<{ diff: string; diffViewMode: DiffViewMode }> = ({ diff, diffViewMode }) => (
    <React.Suspense fallback={<PlainDiffFallback diff={diff} />}>
        <LazyToolPartDiffPreview diff={diff} diffViewMode={diffViewMode} />
    </React.Suspense>
);

interface ToolExpandedContentProps {
    part: ToolPartType;
    state: ToolStateUnion;
    currentDirectory: string;
    isExpanded: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    currentDirectory,
    isExpanded,
    onShowPopup,
}) => {
    const { t } = useI18n();
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const rawOutput = getToolOutput(part.tool, stateWithData.output, metadata?.output, state.status);
    const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
    const rawOutputString = typeof rawOutput === 'string' ? rawOutput : '';
    const isStreamingBash = part.tool === 'bash' && state.status === 'running';
    const throttledOutputString = useStreamingTextThrottle({
        text: rawOutputString,
        isStreaming: isStreamingBash,
        identityKey: part.id,
        allowTextReplacement: isStreamingBash,
    });
    const outputString = isStreamingBash ? throttledOutputString : rawOutputString;
    const attachments = stateWithData.attachments;
    const fileDiff = isRecord(metadata?.filediff) ? metadata.filediff : undefined;
    const diffContent = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff)
        ?? getPatchText(fileDiff?.patch)
        ?? getPatchText(fileDiff?.diff)
        ?? null;
    const diffEntries = React.useMemo(
        () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
        [currentDirectory, diffContent, metadata]
    );
    const hasVisualDiffEntry = diffEntries.some((entry) => entry.renderMode === 'diff');
    const hideToolInputPreview = part.tool === 'openchamber'
        || part.tool === 'openchamber_web'
        || part.tool === 'openchamber_memory'
        || part.tool === 'apply_patch'
        || part.tool === 'edit'
        || part.tool === 'multiedit';
    const diagnosticSection = React.useMemo(
        () => getToolDiagnosticSection(part.tool, input, metadata, currentDirectory),
        [currentDirectory, input, metadata, part.tool],
    );

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
    const hasInputText = !hideToolInputPreview && inputTextContent.trim().length > 0;
    const isWriteLikeTool = part.tool === 'write' || part.tool === 'create' || part.tool === 'file_write';
    const isTodoTool = part.tool === 'todowrite' || part.tool === 'todoread';
    const todoContent = React.useMemo(() => {
        if (Array.isArray(input?.todos)) {
            return JSON.stringify(input.todos);
        }
        return outputString;
    }, [input?.todos, outputString]);
    const writeLikeInputPatch = React.useMemo(() => {
        if (!isWriteLikeTool || !hasInputText) {
            return undefined;
        }
        const filePath = typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : undefined;
        return buildWritePreviewPatch(filePath, inputTextContent);
    }, [hasInputText, input?.filePath, input?.file_path, input?.path, inputTextContent, isWriteLikeTool]);

    React.useEffect(() => {
        setDiffViewMode('unified');
    }, [part.id]);

    const renderScrollableBlock = (
        content: React.ReactNode,
        options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string; followKey?: string }
    ) => (
        <ToolScrollableSection
            maxHeightClass={options?.maxHeightClass}
            className={options?.className}
            disableHorizontal={options?.disableHorizontal}
            outerClassName={options?.outerClassName}
            followKey={options?.followKey}
        >
            {content}
        </ToolScrollableSection>
    );

    const renderResultContent = () => {
        const getEntryAbsolutePath = (entry: DiffPatchEntry) => toAbsoluteFilePath(currentDirectory, entry.filePath ?? entry.title);
        const openEntryFile = (entry: DiffPatchEntry, event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const line = extractFirstChangedLineFromDiff(entry.patch);
            const absolutePath = getEntryAbsolutePath(entry);
            if (runtime?.editor && runtime.runtime.isVSCode) {
                void runtime.editor.openFile(absolutePath, line);
                return;
            }
            useUIStore.getState().openContextFileAtLine(currentDirectory, absolutePath, line ?? 1, 1);
            // Dedicated mobile app: the pending file navigation is consumed by
            // the FilesView pane — surface it (workspace drawer Files tab).
            mobileActions?.openFiles();
        };
        const openEntryDiff = (entry: DiffPatchEntry, event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const line = extractFirstChangedLineFromDiff(entry.patch);
            const absolutePath = getEntryAbsolutePath(entry);
            if (runtime?.editor && runtime.runtime.isVSCode) {
                void runtime.editor.openDiff('', absolutePath, `${getRelativePath(absolutePath, currentDirectory)} (changes)`, { line, patch: entry.patch });
                return;
            }
            const store = useUIStore.getState();
            const relativePath = getRelativePath(absolutePath, currentDirectory);
            if (store.isMobile) {
                store.navigateToDiff(relativePath);
                return;
            }
            store.openContextDiff(currentDirectory, relativePath);
        };
        const renderDiagnosticsSection = () => {
            if (!diagnosticSection) {
                return null;
            }

            return (
                <div
                    className="tool-output-surface rounded-xl border p-2 space-y-2"
                    style={{
                        borderColor: 'var(--status-error-border)',
                        backgroundColor: 'var(--status-error-background)',
                    }}
                >
                    <div className="typography-meta font-medium" style={{ color: 'var(--status-error)' }}>
                        {t('chat.toolPart.lspErrors')}
                    </div>
                    <div className="space-y-1">
                        <div className="flex items-center gap-1 min-w-0">
                            {renderPathLikeGitChanges(diagnosticSection.displayPath, false)}
                        </div>
                        <div className="space-y-1">
                            {diagnosticSection.diagnostics.map((diagnostic, index) => (
                                <div key={`${diagnosticSection.displayPath}:${diagnostic.line}:${diagnostic.character}:${index}`} className="rounded-md border px-2 py-1" style={{ borderColor: 'var(--status-error-border)', backgroundColor: 'var(--surface-elevated)' }}>
                                    <div className="flex items-start gap-2 min-w-0">
                                        <span className="typography-micro shrink-0" style={{ color: 'var(--status-error)' }}>
                                            [{diagnostic.line}:{diagnostic.character}]
                                        </span>
                                        <span className="typography-meta text-foreground whitespace-pre-wrap break-words">
                                            {diagnostic.message}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {diagnosticSection.remaining > 0 ? (
                            <div className="typography-micro text-muted-foreground">
                                {t('chat.toolPart.moreErrors', { count: diagnosticSection.remaining })}
                            </div>
                        ) : null}
                    </div>
                </div>
            );
        };

        // Question tool: show parsed Q&A summary or question content from input
        if (part.tool === 'question') {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="space-y-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="space-y-0.5">
                                    <QuestionMarkdown content={qa.question} size="micro" className="text-muted-foreground" />
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
                        <div className="typography-meta font-medium text-muted-foreground mb-1">{t('chat.toolPart.error')}</div>
                        <div className="typography-meta p-2 rounded-xl border" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                            borderColor: 'var(--status-error-border)',
                        }}>
                            {coerceToText(state.error)}
                        </div>
                    </div>
                );
            }

            // Show question content from input whenever available, whether the tool is
            // pending/running or completed without parseable output. This ensures question
            // text persists across refreshes even if the QuestionCard store data is lost.
            const questionInput = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label: string; description: string }>; multiple?: boolean }> } | undefined;
            if (questionInput?.questions && Array.isArray(questionInput.questions) && questionInput.questions.length > 0) {
                return renderScrollableBlock(
                    <div className="space-y-2">
                        {questionInput.questions.map((q, index) => (
                            <div key={index} className="space-y-0.5">
                                {q.header ? (
                                    <div className="typography-micro text-muted-foreground">{coerceToText(q.header)}</div>
                                ) : null}
                                <QuestionMarkdown content={coerceToText(q.question)} size="meta" className="text-foreground" />
                                {Array.isArray(q.options) && q.options.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {q.options.map((opt) => (
                                            <span key={coerceToText(opt.label)} className="typography-micro px-1.5 py-0.5 rounded bg-muted/30 border border-border/30 text-muted-foreground">
                                                {coerceToText(opt.label)}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>,
                    { maxHeightClass: 'max-h-[40vh]' }
                );
            }

            return <div className="typography-meta text-muted-foreground">{t('chat.toolPart.awaitingResponse')}</div>;
        }

        if (part.tool === 'task' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={coerceToText(outputString)} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if ((part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch' || part.tool === 'write') && (diffEntries.length > 0 || !!diagnosticSection)) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {diffEntries.map((entry) => (
                        <div key={entry.id} className="w-full min-w-0">
                            <div className="mb-1 flex min-w-0 items-center gap-1 px-2 py-1">
                                <div className="min-w-0 flex-1 typography-meta font-medium text-muted-foreground">
                                    {renderPathLikeGitChanges(entry.title)}
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={(event) => openEntryFile(entry, event)}
                                    aria-label={t('chat.toolPart.openFileAtFirstChange')}
                                    title={t('chat.toolPart.openFileAtFirstChange')}
                                >
                                    <Icon name="file-edit" className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={(event) => openEntryDiff(entry, event)}
                                    aria-label={t('chat.toolPart.openFileDiff')}
                                    title={t('chat.toolPart.openFileDiff')}
                                >
                                    <Icon name="git-pull-request" className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                            {entry.renderMode === 'diff' ? (
                                <DiffPreview
                                    diff={entry.patch}
                                    diffViewMode={diffViewMode}
                                />
                            ) : (
                                <PlainDiffFallback diff={entry.patch} />
                            )}
                        </div>
                    ))}
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' }
            );
        }

        if (part.tool === 'write' && diagnosticSection) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' },
            );
        }

        if (isWriteLikeTool) {
            return null;
        }

        if (hasStringOutput && outputString.trim()) {
            const output = (
                <ToolScrollableTextOutput
                    output={coerceToText(outputString)}
                    part={part}
                    metadata={metadata}
                    input={input}
                    isStreaming={isStreamingBash}
                />
            );

            return renderScrollableBlock(
                output,
                {
                    className: part.tool === 'bash' ? 'p-1 rounded-none' : 'p-1',
                    maxHeightClass: part.tool === 'bash' ? 'max-h-[46vh]' : undefined,
                    followKey: isStreamingBash ? outputString : undefined,
                }
            );
        }

        return renderScrollableBlock(
            <div className="typography-meta text-muted-foreground/70">{t('chat.toolPart.noOutputProduced')}</div>,
            { maxHeightClass: 'max-h-60' }
        );
    };

    const hasVisibleOutput = outputString.trim().length > 0;
    const shouldRenderResult = (state.status === 'completed' && 'output' in state)
        || (part.tool === 'bash' && hasVisibleOutput);

    if (isTodoTool) {
        if (state.status === 'error' && 'error' in state) {
            return (
                <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
                    <div className="typography-meta font-medium text-muted-foreground/80 mb-1">{t('chat.toolPart.error')}</div>
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

        const todoOutput = renderTodoOutput(todoContent, {
            total: t('chat.todo.total'),
            inProgress: t('chat.todo.inProgress'),
            pending: t('chat.todo.pending'),
            completed: t('chat.todo.completed'),
            cancelled: t('chat.todo.cancelled'),
        }, { unstyled: true });

        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
                {renderScrollableBlock(
                    todoOutput ?? (
                        <ToolScrollableTextOutput
                            output={todoContent}
                            part={part}
                            metadata={metadata}
                            input={input}
                        />
                    ),
                    { className: 'p-2', maxHeightClass: 'max-h-[46vh]' },
                )}
            </div>
        );
    }

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
                    {hasInputText ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                part.tool === 'bash' ? (
                                    <pre className="tool-input-text whitespace-pre-wrap break-words typography-code text-muted-foreground/90 m-0 p-0">
                                        {inputTextContent}
                                    </pre>
                                ) : isWriteLikeTool && writeLikeInputPatch ? (
                                    <DiffPreview
                                        diff={writeLikeInputPatch}
                                        diffViewMode={diffViewMode}
                                    />
                                ) : (
                                    <blockquote className="tool-input-text whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">
                                        {inputTextContent}
                                    </blockquote>
                                ),
                                {
                                    maxHeightClass: isWriteLikeTool && writeLikeInputPatch && isExpanded ? 'max-h-[50vh]' : 'max-h-60',
                                    className: part.tool === 'bash' ? 'tool-input-surface p-0 rounded-none' : 'tool-input-surface',
                                }
                            )}
                        </div>
                    ) : null}

                    {shouldRenderResult && (
                        <div>
                            {(part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch' || part.tool === 'write') && hasVisualDiffEntry ? (
                                <div className="mb-1 flex items-center justify-end gap-2">
                                    <DiffViewToggle
                                        mode={diffViewMode}
                                        onModeChange={setDiffViewMode}
                                        className="h-5 w-5 p-0"
                                    />
                                </div>
                            ) : null}
                            {renderResultContent()}
                        </div>
                    )}

                    {state.status === 'error' && 'error' in state && (
                        <div>
                            <div className="typography-meta font-medium text-muted-foreground/80 mb-1">{t('chat.toolPart.error')}</div>
                            <div className="typography-meta p-2 rounded-xl border" style={{
                                backgroundColor: 'var(--status-error-background)',
                                color: 'var(--status-error)',
                                borderColor: 'var(--status-error-border)',
                            }}>
                                {coerceToText(state.error)}
                            </div>
                        </div>
                    )}
                </>
            )}

            {Array.isArray(attachments) && attachments.length > 0 && state.status === 'completed' ? (
                <MessageFilesDisplay files={attachments} onShowPopup={onShowPopup} compact />
            ) : null}
        </div>
    );
});

ToolExpandedContent.displayName = 'ToolExpandedContent';

const ToolPartContent: React.FC<ToolPartProps> = ({
    part,
    isExpanded,
    onToggle,
    isMobile,
    onShowPopup,
    animateTailText = true,
}) => {
    const { t } = useI18n();
    const state = part.state;
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const showToolFileIcons = useUIStore((s) => s.showToolFileIcons);
    const currentDirectory = useEffectiveDirectory() ?? '';

    const normalizedPartTool = normalizeToolName(part.tool);
    const isTaskTool = normalizedPartTool === 'task';

    const status = state?.status as string | undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    const isSuccessfullyFinalized = status === 'completed';
    const isError = status === 'error' || status === 'failed';

    const [activeLatched, setActiveLatched] = React.useState<boolean>(!isFinalized);
    const previousPartIdRef = React.useRef<string | undefined>(part.id);
    const observedActiveGitToolRef = React.useRef(!isFinalized);

    React.useEffect(() => {
        if (previousPartIdRef.current === part.id) {
            return;
        }
        previousPartIdRef.current = part.id;
        observedActiveGitToolRef.current = !isFinalized;
        // Reset latch only when tool identity changes.
        setActiveLatched(!isFinalized);
    }, [isFinalized, part.id]);

    React.useEffect(() => {
        if (!isFinalized) {
            setActiveLatched(true);
        }
    }, [isFinalized]);

    React.useEffect(() => {
        if (!isFinalized) {
            observedActiveGitToolRef.current = true;
            return;
        }

        // Historical completed tools can remount when the timeline changes.
        // Refresh only for a tool whose active state this instance observed.
        const finalizedAfterObservedActive = observedActiveGitToolRef.current;
        if (!finalizedAfterObservedActive) {
            return;
        }

        if (!isSuccessfullyFinalized || !GIT_REFRESH_MUTATING_TOOLS.has(normalizedPartTool)) {
            observedActiveGitToolRef.current = false;
            return;
        }
        if (!currentDirectory) {
            return;
        }

        observedActiveGitToolRef.current = false;
        const paths = getMutatedToolPaths(normalizedPartTool, input, metadata)
            .map((path) => getRelativePath(path, currentDirectory));
        sessionEvents.requestGitRefresh({
            directory: currentDirectory,
            ...(paths.length > 0 ? { paths } : {}),
        });
    }, [currentDirectory, input, isFinalized, isSuccessfullyFinalized, metadata, normalizedPartTool]);

    const expandedContentRef = React.useRef<HTMLDivElement>(null);

    React.useLayoutEffect(() => {
        if (isTaskTool) {
            return;
        }

        const element = expandedContentRef.current;
        if (!element) {
            return;
        }

        element.style.height = isExpanded ? 'auto' : '0px';
        element.style.overflow = isExpanded ? 'visible' : 'hidden';
    }, [isExpanded, isTaskTool]);

    const partMetadata = (part as unknown as { metadata?: unknown }).metadata;
    const time = stateWithData.time;

    const [pinnedTime, setPinnedTime] = React.useState<{ start?: number; end?: number }>(() => ({
        start: typeof time?.start === 'number' ? time.start : undefined,
        end: typeof time?.end === 'number' ? time.end : undefined,
    }));
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

    const hasFinalMetadataTaskSummary = isFinalized && metadataTaskSummaryEntries.length > 0;

    const taskSessionId = React.useMemo<string | undefined>(() => {
        if (!isTaskTool) {
            return undefined;
        }

        // Current OpenCode publishes this authoritative join while the Task is
        // running. The remaining sources only support older persisted parts.
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

    const childSessionLookupId = hasFinalMetadataTaskSummary ? '' : (taskSessionId ?? '');

    const childSessionMessages = useSessionMessageRecords(childSessionLookupId, currentDirectory);
    useEnsureSessionMessages(childSessionLookupId, currentDirectory);

    const childSessionTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool || !taskSessionId) {
            return [];
        }
        if (!Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return [];
        }
        return buildTaskSummaryEntriesFromSession(childSessionMessages);
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
    const diffStats = React.useMemo(() => {
        return (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch')
            ? parseDiffStats(metadata)
            : null;
    }, [metadata, normalizedPartTool]);
    const writeLineCount = React.useMemo(() => {
        return normalizedPartTool === 'write' ? parseWriteLineCount(input) : null;
    }, [input, normalizedPartTool]);
    const isMultiFileApplyPatch = normalizedPartTool === 'apply_patch' && Array.isArray(metadata?.files) && (metadata?.files as []).length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as ToolPartType) : part;
    const descriptionPath = getToolDescriptionPath(normalizedPart, state, currentDirectory);
    const description = getToolDescription(normalizedPart, state, currentDirectory);
    const displayName = getToolMetadata(normalizedPartTool || part.tool).displayName;
    
    // Tool title/description — shown inline as context
    const justificationText = React.useMemo(() => {
        if (normalizedPartTool === 'bash') {
            return null;
        }
        if (normalizedPartTool === 'apply_patch') {
            return null;
        }
        if (normalizedPartTool === 'lsp') {
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
    const mobileActions = useMobileAppActions();

    const openApplyPatchFile = (file: Record<string, unknown>, event: React.MouseEvent<HTMLButtonElement>) => {
        if (!runtime?.editor) {
            return;
        }

        event.stopPropagation();
        const displayPath = typeof file.relativePath === 'string'
            ? file.relativePath
            : typeof file.filePath === 'string'
                ? getRelativePath(file.filePath, currentDirectory)
                : '';
        openApplyPatchFileInEditor({
            currentDirectory,
            diffLabel: `${displayPath} (changes)`,
            editor: runtime.editor,
            file,
            isVSCode: runtime.runtime.isVSCode,
        });
    };

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        if (isTaskTool || !runtime?.editor) {
            onToggle(part.id);
            return;
        }

        let filePath: unknown;
        let targetLine: number | undefined;
        let toolDiff: string | undefined;
        if (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit') {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (normalizedPartTool === 'apply_patch') {
            filePath = getPrimaryToolPath(normalizedPartTool, input, metadata);
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (['write', 'create', 'file_write'].includes(normalizedPartTool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        } else if (normalizedPartTool === 'lsp') {
            filePath = input?.filePath || input?.file_path || input?.path;
            const line = input?.line;
            targetLine = typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : undefined;
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
            if (runtime.runtime.isVSCode && toolDiff && (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch')) {
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
        // Nested buttons (quick-open, copy) handle their own Enter/Space; the row
        // must not swallow the key and toggle instead.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleMainClick(event);
    };

    // Quick-open target for the file-link icon in the tool header. Resolves the
    // primary file path (and, for diff tools, the first changed line + diff) so
    // the user can open the file in the side panel (web/desktop) or editor
    // (VS Code) without expanding the tool card. Reuses the same path helpers as
    // handleMainClick above; the difference is the web fallback — handleMainClick
    // only opens when runtime.editor is available, this icon also falls back to
    // useUIStore.openContextFile{AtLine} so the file opens in the right pane.
    const quickOpenTarget = React.useMemo<{ absolutePath: string; line?: number; toolDiff?: string; toolName: string } | null>(() => {
        if (isTaskTool) return null;
        const toolName = normalizedPartTool || part.tool;
        const filePath = getPrimaryToolPath(toolName, input, metadata);
        if (typeof filePath !== 'string') return null;
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        let line: number | undefined;
        let toolDiff: string | undefined;
        if (toolName === 'edit' || toolName === 'multiedit' || toolName === 'apply_patch') {
            line = getFirstChangedLineFromMetadata(toolName, metadata, filePath);
            toolDiff = getPrimaryDiffFromMetadata(toolName, metadata, filePath);
        }
        return { absolutePath, line, toolDiff, toolName };
    }, [isTaskTool, normalizedPartTool, part.tool, input, metadata, currentDirectory]);

    const openQuickTarget = () => {
        if (!quickOpenTarget) return;
        const { absolutePath, line, toolDiff, toolName } = quickOpenTarget;
        if (runtime?.editor) {
            if (runtime.runtime.isVSCode && toolDiff && (toolName === 'edit' || toolName === 'multiedit' || toolName === 'apply_patch')) {
                const label = `${getRelativePath(absolutePath, currentDirectory)} (changes)`;
                void runtime.editor.openDiff('', absolutePath, label, { line, patch: toolDiff });
                return;
            }
            runtime.editor.openFile(absolutePath, line);
            return;
        }
        const uiStore = useUIStore.getState();
        if (typeof line === 'number' && Number.isFinite(line)) {
            uiStore.openContextFileAtLine(currentDirectory, absolutePath, Math.max(1, Math.trunc(line)), 1);
        } else {
            uiStore.openContextFile(currentDirectory, absolutePath);
        }
        mobileActions?.openFiles();
    };

    const handleQuickOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        openQuickTarget();
    };

    const iconStyle = !isTaskTool && isError ? TOOL_ERROR_ICON_STYLE : TOOL_NORMAL_ICON_STYLE;
    const titleStyle = !isTaskTool && isError ? TOOL_ERROR_TITLE_STYLE : TOOL_NORMAL_TITLE_STYLE;
    const shouldRenderTaskSummary = useDeferredExpandedContent(isTaskTool && (taskSummaryEntries.length > 0 || isActive || shouldTreatAsFinalized || !!taskSessionId));
    const shouldRenderExpandedContent = useDeferredExpandedContent(!isTaskTool && isExpanded);

    if (!shouldTreatAsFinalized && !isActive && !isTaskTool) {
        return null;
    }

    return (
        <div>
            {}
            <div
                className={cn(
                    'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl',
                    isMultiFileApplyPatch ? 'flex-wrap items-start cursor-pointer' : 'items-center cursor-pointer',
                )}
                onClick={isMultiFileApplyPatch ? () => onToggle(part.id) : handleMainClick}
                onKeyDown={isMultiFileApplyPatch ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onToggle(part.id);
                } : handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className={cn('flex gap-1.5', isMultiFileApplyPatch ? 'w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5' : 'items-center flex-shrink-0')}>
                    {isMultiFileApplyPatch ? (
                        <>
                            <div className="flex h-5 flex-shrink-0 items-center gap-1.5">
                                <span className="relative h-3.5 w-3.5 flex-shrink-0">
                                    <span className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded ? 'opacity-0' : 'group-hover/tool:opacity-0',
                                    )} style={iconStyle}>
                                        {getToolIcon(normalizedPartTool || part.tool)}
                                    </span>
                                    <Icon
                                        name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                                        className={cn(
                                            'absolute inset-0 h-3.5 w-3.5 transition-opacity',
                                            isExpanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                                        )}
                                    />
                                </span>
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                            <ApplyPatchFileButtons
                                metadata={metadata}
                                animate={animateTailText}
                                showFileIcons={showToolFileIcons}
                                textClassName={TOOL_ROW_DESCRIPTION_CLASS}
                                openDiffLabel={t('chat.toolPart.openFileDiff')}
                                onFileClick={runtime?.editor ? openApplyPatchFile : undefined}
                            />
                        </>
                    ) : (
                        <>
                            <div
                                // h-5 matches StaticToolRow's icon column, so expandable
                                // and static rows come out the same height (the 14px
                                // icon alone left these rows ~2px shorter).
                                className="relative h-5 w-3.5 flex-shrink-0 cursor-pointer"
                                onClick={(event) => { event.stopPropagation(); onToggle(part.id); }}
                            >
                                <div
                                    className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded && 'opacity-0',
                                        !isExpanded && 'group-hover/tool:opacity-0'
                                    )}
                                    style={iconStyle}
                                >
                                    {getToolIcon(normalizedPartTool || part.tool)}
                                </div>
                                <div
                                    className={cn(
                                        'absolute inset-0 transition-opacity flex items-center justify-center',
                                        isExpanded && 'opacity-100',
                                        !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
                                    )}
                                >
                                    {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                                </div>
                            </div>
                            <div className={cn('flex items-center min-w-0 flex-1', quickOpenTarget ? 'gap-1' : 'gap-2')}>
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                    title={displayName}
                                >
                                    {displayName}
                                </MinDurationShineText>
                                {quickOpenTarget ? (
                                    <button
                                        type="button"
                                        onClick={handleQuickOpen}
                                        className={cn(
                                            'flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded transition-opacity hover:bg-[var(--surface-hover)]',
                                            // Coarse pointers never hover, so the icon has to rest visible
                                            // there or it stays invisible while remaining tappable.
                                            'opacity-0 group-hover/tool:opacity-60 hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60',
                                        )}
                                        style={{ color: 'var(--tools-icon)' }}
                                        title={t('chat.toolPart.openFile')}
                                        aria-label={t('chat.toolPart.openFile')}
                                    >
                                        <Icon name="external-link" className="h-3 w-3" />
                                    </button>
                                ) : null}
                            </div>
                            {normalizedPartTool === 'bash' && typeof effectiveTimeStart === 'number' ? (
                                <span className={cn('flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)}>
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
                    <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                            {justificationText && (
                                <span
                                    className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                    style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && normalizedPartTool === 'lsp' && descriptionPath ? (
                                renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                            ) : null}
                            {!justificationText && normalizedPartTool !== 'lsp' && description && (
                                descriptionPath && description === descriptionPath ? (
                                    renderAnimatedPathWithIcon(descriptionPath, animateTailText, false, showToolFileIcons)
                                ) : (
                                    <Text
                                        variant={animateTailText ? 'generate-effect' : 'static'}
                                        className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
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
            {shouldRenderTaskSummary ? (
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

            {!isTaskTool ? (
                <div
                    ref={expandedContentRef}
                    aria-hidden={!isExpanded}
                    style={{
                        height: isExpanded ? 'auto' : '0px',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        overflowAnchor: 'none',
                    }}
                >
                    {shouldRenderExpandedContent ? (
                        <div
                            className="relative ml-2 pl-3"
                        >
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                            <ToolExpandedContent
                                part={part}
                                state={state}
                                currentDirectory={currentDirectory}
                                isExpanded={isExpanded}
                                onShowPopup={onShowPopup}
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

class ToolPartErrorBoundary extends React.Component<{
    children: React.ReactNode;
    displayName: string;
    errorLabel: string;
    resetKey: unknown;
    toolName: string;
}, { hasError: boolean; error?: Error }> {
    state: { hasError: boolean; error?: Error } = { hasError: false };

    static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
        return { hasError: true, error };
    }

    componentDidUpdate(prevProps: { resetKey: unknown }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false, error: undefined });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool part failed to render; showing safe fallback.', error);
        }
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const message = this.state.error?.message;
        return (
            <div className="flex items-center gap-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0">
                <div className="h-3.5 w-3.5 flex-shrink-0" style={TOOL_ERROR_ICON_STYLE}>
                    {getToolIcon(this.props.toolName)}
                </div>
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')} style={TOOL_ERROR_TITLE_STYLE}>
                    {this.props.displayName}
                </span>
                {message ? (
                    <span className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={message}>
                        {this.props.errorLabel}: {message}
                    </span>
                ) : null}
            </div>
        );
    }
}

const ToolPart: React.FC<ToolPartProps> = (props) => {
    const { t } = useI18n();
    const toolName = normalizeToolName(props.part.tool) || 'tool';
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolPartErrorBoundary
            displayName={displayName}
            errorLabel={t('chat.toolPart.error')}
            resetKey={props.part}
            toolName={toolName}
        >
            <ToolPartContent {...props} />
        </ToolPartErrorBoundary>
    );
};

export default React.memo(ToolPart, (prev, next) => {
    return areRenderRelevantPartsEqual([prev.part], [next.part])
        && prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.alwaysShowActions === next.alwaysShowActions
        && prev.onShowPopup === next.onShowPopup
        && prev.animateTailText === next.animateTailText;
});
