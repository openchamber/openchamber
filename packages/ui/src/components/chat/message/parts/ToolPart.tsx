
import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { FormMarkdown } from '../../FormMarkdown';
import { MessageFilesDisplay } from '../../FileAttachment';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { FilePart, Metadata, Part, ToolInput, ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@/lib/opencode/model';
import { toolDisplayStyles } from '@/lib/typography';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionMessageRecords, useEnsureSessionMessages } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Text } from '@/components/ui/text';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ToolPopupContent } from '../types';
import { PlainDiffFallback } from './PlainDiffFallback';
import { isToolDiffPreviewOversized } from './toolDiffPreview';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import {
    formatEditOutput,
    detectLanguageFromOutput,
    formatInputForDisplay,
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
import { GuestToolTable } from './GuestToolTable';
import type { JsonValue } from '@openchamber/sdk';
import {
    guestToolTableRows,
    renderGuestToolHeader,
    useGuestToolPresentation,
    type GuestToolRule,
} from '@/lib/guests/tool-presentation';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
    buildTaskSummaryEntriesFromSession,
    normalizeTaskSummaryEntries,
    parseTaskMetadataBlock,
    prepareTaskToolOutput,
    readTaskSessionIdFromOutput,
    readTaskSessionIdFromRecord,
    resolveRunningTaskChildSessionId,
    type TaskToolSummaryEntry,
} from './taskToolModel';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { useI18n } from '@/lib/i18n';
import {
    extractFirstChangedLineFromDiff,
    getApplyPatchFilePath,
    getDiffPatchEntries,
    getFirstChangedLineFromMetadata,
    getPatchText,
    getPrimaryDiffFromMetadata,
    getPrimaryToolPath,
    getToolFallbackDiff,
    resolveToolQuickOpenTarget,
    type DiffPatchEntry,
} from './toolDiffUtils';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { getStreamingOutputAppend, getToolOutput } from './toolOutput';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import {
    executeOutputTruncation,
    executeScript,
    executeToolCalls,
    isEditTool,
    isExecuteTool,
    isReadTool,
    isFileChangeTool,
    isPatchTool,
    isQuestionTool,
    isShellTool,
    isSubagentTool,
    isWebSearchTool,
    isWriteTool,
    normalizeToolName,
    toolDescription, type ToolDescription,
    toolInputPath,
    toolFileDiffs,
} from '@/lib/opencode/tools';
import { parseWebSearchOutput, webSearchProviderOf } from '@/lib/opencode/websearch';
import { ApplyPatchFileButtons } from './ApplyPatchFileButtons';
import { openApplyPatchFileInEditor } from './applyPatchEditorAction';
import { WebSearchResults } from './WebSearchResults';

type ToolJsonViewMode = 'summary' | 'formatted' | 'raw';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type ToolStateWithMetadata = ToolStateUnion & { metadata?: Metadata; input?: ToolInput; output?: string; error?: string; time?: { start: number; end?: number }; attachments?: Array<FilePart> };

interface ToolPartProps {
    part: ToolPartType;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}

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

const parseDiffStats = (metadata?: Metadata): { added: number; removed: number } | null => {
    const files = toolFileDiffs(metadata);
    if (files.length > 0) {
        let added = 0;
        let removed = 0;
        for (const file of files) {
            // Missing counts are unknown, not zero; never show a partial total.
            if (file.additions === undefined || file.deletions === undefined) return null;
            added += file.additions;
            removed += file.deletions;
        }
        return { added, removed };
    }

    const diffText = getPatchText(metadata?.patch)
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
    if (!isFileChangeTool(toolName)) {
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
    const described = toolDescription(part.tool, stateWithData.input, stateWithData.metadata);
    if (described?.kind !== 'path') {
        return null;
    }
    return getRelativePath(described.value, currentDirectory);
};

type DescriptionTranslate = (
    key: 'chat.toolPart.questionsAsked' | 'chat.toolPart.filesCount' | 'chat.toolPart.moreToolCalls',
    params: { count: number },
) => string;

/** Localized text for a tool description; paths are made relative to the project. */
const describeTool = (described: ToolDescription | null, currentDirectory: string, t: DescriptionTranslate): string => {
    if (!described) return '';
    switch (described.kind) {
        case 'path':
            return getRelativePath(described.value, currentDirectory);
        case 'text':
            return described.value;
        case 'questions':
            return t('chat.toolPart.questionsAsked', { count: described.count });
        case 'files':
            return t('chat.toolPart.filesCount', { count: described.count });
        case 'tools': {
            const named = described.calls
                .map(({ name, count }) => (count > 1 ? `${name} \u00d7${count}` : name))
                .join(', ');
            return described.overflow > 0
                ? `${named}, ${t('chat.toolPart.moreToolCalls', { count: described.overflow })}`
                : named;
        }
    }
};

const getToolDescription = (part: ToolPartType, state: ToolStateUnion, currentDirectory: string, t: DescriptionTranslate): string => {
    const stateWithData = state as ToolStateWithMetadata;
    return describeTool(toolDescription(part.tool, stateWithData.input, stateWithData.metadata), currentDirectory, t);
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
    const lastScrollTopRef = React.useRef(0);

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
        // Read back the clamped position before the queued scroll event fires.
        lastScrollTopRef.current = element.scrollTop;
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
                    const distanceToEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
                    // Output can grow between an automatic scroll and its event.
                    // A larger bottom gap alone does not mean the reader moved up.
                    if (distanceToEnd <= 2) {
                        isFollowingRef.current = true;
                    } else if (element.scrollTop < lastScrollTopRef.current - 1) {
                        isFollowingRef.current = false;
                    }
                    lastScrollTopRef.current = element.scrollTop;
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
    if (isShellTool(part.tool)) {
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
    if (isShellTool(part.tool)) {
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

type JsonOutputResult = ReturnType<typeof tryParseJsonOutput>;

const JsonToolOutput: React.FC<{
    jsonResult: JsonOutputResult;
    renderedOutput: string;
}> = ({ jsonResult, renderedOutput }) => {
    const { t } = useI18n();
    const jsonViewMode = useUIStore((state) => state.toolJsonViewMode);
    const [copiedJson, setCopiedJson] = React.useState(false);

    React.useEffect(() => {
        setCopiedJson(false);
    }, [renderedOutput]);

    const handleJsonViewChange = React.useCallback((view: ToolJsonViewMode, event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        useUIStore.getState().setToolJsonViewMode(view);
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
};

const ToolScrollableTextOutput: React.FC<{
    output: string;
    part: ToolPartType;
    metadata: Record<string, unknown> | undefined;
    input: Record<string, unknown> | undefined;
    isStreaming?: boolean;
    /** An extension's rule for this tool; its `output` forces the body mode, `auto` keeps detection. */
    presentation?: GuestToolRule | null;
    onShowPopup?: (content: ToolPopupContent) => void;
}> = ({ output, part, metadata, input, isStreaming = false, presentation = null, onShowPopup }) => {
    const renderedOutput = getToolOutputText(output, part, metadata);
    const outputLanguage = getToolOutputLanguage(output, part, metadata, input);
    const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
    const forcedMode = presentation?.output && presentation.output !== 'auto' ? presentation.output : null;

    if (isShellTool(part.tool) && isStreaming) {
        return (
            <div className="typography-code text-muted-foreground/90">
                <StreamingPlainTextOutput output={renderedOutput} />
            </div>
        );
    }

    if (forcedMode === 'markdown') {
        return (
            <div className="w-full min-w-0">
                <SimpleMarkdownRenderer content={renderedOutput} variant="tool" onShowPopup={onShowPopup} />
            </div>
        );
    }

    if (forcedMode === 'table' && presentation?.columns?.length) {
        // A declared table whose output is not a list falls through to the
        // host's own detection, so the user still sees the raw result.
        // SAFETY: `tryParseJsonOutput` fills `data` from JSON.parse of the tool
        // output, so a parsed result is a JSON value.
        const rows = jsonResult.isJson ? guestToolTableRows(jsonResult.data as JsonValue) : null;
        if (rows) {
            return <GuestToolTable rows={rows} columns={presentation.columns} />;
        }
    }

    if (forcedMode === 'text' || forcedMode === 'code') {
        return (
            <WorkerHighlightedCode
                language={forcedMode === 'code' && presentation?.language ? presentation.language : 'text'}
                code={renderedOutput}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        );
    }

    if (jsonResult.isJson) {
        return <JsonToolOutput jsonResult={jsonResult} renderedOutput={renderedOutput} />;
    }

    return (
        <div className={isShellTool(part.tool) ? 'typography-code text-muted-foreground/90' : undefined}>
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
    // `title` only reaches here from a legacy `<task_metadata>` block; a live
    // v2 call is described from its own input.
    const title = entry.state?.title;
    if (typeof title === 'string' && title.trim().length > 0) {
        return title;
    }

    const described = toolDescription(entry.tool, entry.state?.input, undefined);
    if (described?.kind === 'files') {
        const names = described.files.slice(0, 3).map((path) => path.split(/[\\/]/).pop() || path);
        const remaining = described.files.length - names.length;
        return `${names.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`;
    }
    return described && (described.kind === 'path' || described.kind === 'text') ? described.value.trim() : '';
};

const shouldRenderGitPathLabel = (toolName: string, label: string): boolean => {
    if (!isReadTool(toolName) && !isFileChangeTool(toolName)) {
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
                        renderAnimatedPathWithIcon(label, animateTailText, true, showToolFileIcons, 'typography-meta')
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
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} className="pt-0" disableHorizontal>
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

const useRunningTaskChildSessionId = (part: ToolPartType | undefined, directory: string): string | undefined => {
    const startedAt = part?.state.status === 'running' ? part.state.time.start : undefined;
    const agent = part?.state.input.agent;
    const parentSessionID = part?.sessionID;
    const messageID = part?.messageID;
    const partID = part?.id;
    // The selector runs on every store change while a Task is running, so it
    // rescans only when the session list or this message's parts change.
    const selector = React.useMemo(() => {
        let lastSessions: State['session'] | undefined;
        let lastSiblings: Part[] | undefined;
        let lastResult: string | undefined;
        return (state: State): string | undefined => {
            if (!parentSessionID || !messageID || !partID || startedAt === undefined) return undefined;
            const siblings = state.part[messageID];
            if (state.session === lastSessions && siblings === lastSiblings) return lastResult;
            lastSessions = state.session;
            lastSiblings = siblings;
            lastResult = resolveRunningTaskChildSessionId({
                sessions: state.session,
                parentSessionID,
                startedAt,
                agent,
                siblingParts: siblings,
                partID,
            });
            return lastResult;
        };
    }, [agent, messageID, parentSessionID, partID, startedAt]);
    return useDirectorySync(selector, directory || undefined);
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

    // v2 names the subagent to run in `input.agent`.
    const agentType = typeof input?.agent === 'string'
        ? input.agent
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

const renderAnimatedPathWithIcon = (path: string, animate = true, grow = true, showFileIcons = true, textClassName = TOOL_ROW_DESCRIPTION_CLASS) => {
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <Text
                    variant={animate ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 truncate whitespace-nowrap', textClassName, grow && 'flex-1')}
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
            <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden', textClassName, grow && 'flex-1')}>
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

const DiffPreview: React.FC<{ diff: string; diffViewMode: DiffViewMode }> = ({ diff, diffViewMode }) => {
    if (isToolDiffPreviewOversized(diff)) return <PlainDiffFallback diff={diff} />;

    return (
        <React.Suspense fallback={<PlainDiffFallback diff={diff} />}>
            <LazyToolPartDiffPreview diff={diff} diffViewMode={diffViewMode} />
        </React.Suspense>
    );
};

interface ToolExpandedContentProps {
    part: ToolPartType;
    state: ToolStateUnion;
    currentDirectory: string;
    isExpanded: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    presentation: GuestToolRule | null;
}

const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    currentDirectory,
    isExpanded,
    onShowPopup,
    presentation,
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
    const isStreamingBash = isShellTool(part.tool) && state.status === 'running';
    const throttledOutputString = useStreamingTextThrottle({
        text: rawOutputString,
        isStreaming: isStreamingBash,
        identityKey: part.id,
        allowTextReplacement: isStreamingBash,
    });
    const outputString = isStreamingBash ? throttledOutputString : rawOutputString;
    const attachments = stateWithData.attachments;
    const diffContent = getToolFallbackDiff(metadata) ?? null;
    const diffEntries = React.useMemo(
        () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
        [currentDirectory, diffContent, metadata]
    );
    const hasVisualDiffEntry = diffEntries.some((entry) => entry.renderMode === 'diff');
    // `execute` renders its script and its call list itself, below.
    const hideToolInputPreview = part.tool === 'openchamber'
        || part.tool === 'openchamber_web'
        || part.tool === 'openchamber_memory'
        || part.tool === 'openchamber_notify'
        || isPatchTool(part.tool)
        || isEditTool(part.tool)
        || isExecuteTool(part.tool);
    const isExecute = isExecuteTool(part.tool);
    const executeCode = React.useMemo(() => (isExecute ? executeScript(input) : undefined), [input, isExecute]);
    const executeCalls = React.useMemo(() => (isExecute ? executeToolCalls(metadata) : []), [isExecute, metadata]);
    const executeTruncation = React.useMemo(
        () => (isExecute ? executeOutputTruncation(metadata) : null),
        [isExecute, metadata],
    );
    const diagnosticSection = React.useMemo(
        () => getToolDiagnosticSection(part.tool, input, metadata, currentDirectory),
        [currentDirectory, input, metadata, part.tool],
    );

    const inputTextContent = React.useMemo(() => {
        if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
            return '';
        }

        if ('command' in input && typeof input.command === 'string' && isShellTool(part.tool)) {
            return formatInputForDisplay(input, part.tool);
        }

        if (typeof (input as { content?: unknown }).content === 'string') {
            return (input as { content?: string }).content ?? '';
        }

        return formatInputForDisplay(input, part.tool);
    }, [input, part.tool]);
    const hasInputText = !hideToolInputPreview && inputTextContent.trim().length > 0;
    // `null` keeps the plain text renderer for a result OpenCode formatted differently.
    const webSearchOutput = React.useMemo(
        () => (isWebSearchTool(part.tool) && state.status === 'completed' && hasStringOutput ? parseWebSearchOutput(outputString) : null),
        [hasStringOutput, outputString, part.tool, state.status],
    );
    const isWriteLikeTool = isWriteTool(part.tool);
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

        // An extension that declared how this tool's output renders goes
        // first; `auto` and a missing rule keep every built-in branch below.
        if (presentation?.output && presentation.output !== 'auto' && hasStringOutput && outputString.trim()) {
            return renderScrollableBlock(
                <ToolScrollableTextOutput
                    output={coerceToText(outputString)}
                    part={part}
                    metadata={metadata}
                    input={input}
                    presentation={presentation}
                    onShowPopup={onShowPopup}
                />,
                { className: 'p-1' }
            );
        }

        // Question tool: show parsed Q&A summary or question content from input
        if (isQuestionTool(part.tool)) {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="space-y-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="space-y-0.5">
                                    <FormMarkdown content={qa.question} size="micro" className="text-muted-foreground" />
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
                                <FormMarkdown content={coerceToText(q.question)} size="meta" className="text-foreground" />
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

        if (isSubagentTool(part.tool) && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={coerceToText(outputString)} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if (isFileChangeTool(part.tool) && (diffEntries.length > 0 || !!diagnosticSection)) {
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

        if (webSearchOutput) {
            return renderScrollableBlock(
                <WebSearchResults output={webSearchOutput} providerId={webSearchProviderOf(metadata)} />,
                { className: 'p-1', maxHeightClass: 'max-h-[50vh]' }
            );
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
                    className: isShellTool(part.tool) ? 'p-1 rounded-none' : 'p-1',
                    maxHeightClass: isShellTool(part.tool) ? 'max-h-[46vh]' : undefined,
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
        || (isShellTool(part.tool) && hasVisibleOutput);

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-4'
            )}
        >
            {isQuestionTool(part.tool) ? (
                renderResultContent()
            ) : (
                <>
                    {isExecute ? (
                        <div className="my-1 space-y-2">
                            {executeCode ? renderScrollableBlock(
                                <WorkerHighlightedCode
                                    language="javascript"
                                    code={executeCode}
                                    style={TOOL_COLLAPSED_CUSTOM_STYLE}
                                    codeStyle={CODE_TAG_PROPS.style}
                                    wrap
                                />,
                                { maxHeightClass: 'max-h-60', className: 'tool-input-surface' },
                            ) : null}
                            {executeCalls.length > 0 ? (
                                <div>
                                    <div className="typography-meta font-medium text-muted-foreground/80 mb-1">
                                        {t('chat.toolPart.scriptCalls')}
                                    </div>
                                    <ul className="space-y-0.5">
                                        {executeCalls.map((call, index) => (
                                            <li key={`${call.tool}-${index}`} className="flex min-w-0 items-baseline gap-2">
                                                <span
                                                    className="typography-code flex-shrink-0"
                                                    style={call.status === 'error' ? TOOL_ERROR_TITLE_STYLE : undefined}
                                                >
                                                    {call.tool}
                                                </span>
                                                {call.status && call.status !== 'error' && call.status !== 'completed' ? (
                                                    <span className="typography-micro flex-shrink-0 text-muted-foreground/70">
                                                        {call.status}
                                                    </span>
                                                ) : null}
                                                {call.input ? (
                                                    <span className="typography-meta truncate text-muted-foreground/70">
                                                        {call.input}
                                                    </span>
                                                ) : null}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {hasInputText ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                isShellTool(part.tool) ? (
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
                                    className: isShellTool(part.tool) ? 'tool-input-surface p-0 rounded-none' : 'tool-input-surface',
                                }
                            )}
                        </div>
                    ) : null}

                    {shouldRenderResult && (
                        <div>
                            {isFileChangeTool(part.tool) && hasVisualDiffEntry ? (
                                <div className="mb-1 flex items-center justify-end gap-2">
                                    <DiffViewToggle
                                        mode={diffViewMode}
                                        onModeChange={setDiffViewMode}
                                        className="h-5 w-5 p-0"
                                    />
                                </div>
                            ) : null}
                            {renderResultContent()}
                            {executeTruncation ? (
                                <div className="typography-meta mt-1 text-muted-foreground/70">
                                    {t('chat.toolPart.outputTruncated')}
                                    {executeTruncation.outputPath ? ` \u2014 ${executeTruncation.outputPath}` : ''}
                                </div>
                            ) : null}
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
    const isTaskTool = isSubagentTool(normalizedPartTool);
    // The registry sees the full name OpenCode reported (`mcp.jira.search`);
    // the built-in switches below keep the normalized one.
    const presentation = useGuestToolPresentation(part.tool);

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

    const authoritativeTaskSessionId = React.useMemo<string | undefined>(() => {
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

    // A parent message loaded over REST mid-run lacks the progress-only join
    // (see resolveRunningTaskChildSessionId); recover it from the child
    // session records until the authoritative id arrives.
    const inferredTaskSessionId = useRunningTaskChildSessionId(
        isTaskTool && !authoritativeTaskSessionId && state.status === 'running' ? part : undefined,
        currentDirectory,
    );
    const taskSessionId = authoritativeTaskSessionId ?? inferredTaskSessionId;

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
        return (isEditTool(normalizedPartTool) || isPatchTool(normalizedPartTool))
            ? parseDiffStats(metadata)
            : null;
    }, [metadata, normalizedPartTool]);
    const writeLineCount = React.useMemo(() => {
        return isWriteTool(normalizedPartTool) ? parseWriteLineCount(input) : null;
    }, [input, normalizedPartTool]);
    const isMultiFileApplyPatch = isPatchTool(normalizedPartTool) && Array.isArray(metadata?.files) && (metadata?.files as []).length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as ToolPartType) : part;
    const descriptionPath = getToolDescriptionPath(normalizedPart, state, currentDirectory);
    const builtInDescription = getToolDescription(normalizedPart, state, currentDirectory, t);
    const stateOutput = typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    const guestHeader = React.useMemo(
        () => (presentation ? renderGuestToolHeader(presentation, { input, output: stateOutput, metadata }) : null),
        [input, metadata, presentation, stateOutput],
    );
    const description = guestHeader?.subtitle ?? builtInDescription;
    const displayName = guestHeader?.title ?? getToolMetadata(normalizedPartTool || part.tool).displayName;
    
    // Tool title/description — shown inline as context. A subtitle the
    // extension declared replaces it, since both land in the same slot.
    const guestSubtitle = guestHeader?.subtitle ?? null;
    const justificationText = React.useMemo(() => {
        if (guestSubtitle) {
            return null;
        }
        if (isShellTool(normalizedPartTool)) {
            return null;
        }
        if (isPatchTool(normalizedPartTool)) {
            return null;
        }
        if (
            descriptionPath
            && (isPatchTool(normalizedPartTool) || isEditTool(normalizedPartTool) || isWriteTool(normalizedPartTool))
        ) {
            return null;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [descriptionPath, guestSubtitle, normalizedPartTool, input]);
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();

    const openApplyPatchFile = (file: Record<string, unknown>, event: React.MouseEvent<HTMLButtonElement>) => {
        if (!runtime?.editor) {
            return;
        }

        event.stopPropagation();
        const rawPath = getApplyPatchFilePath(file);
        const displayPath = rawPath ? getRelativePath(rawPath, currentDirectory) : '';
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
        if (isEditTool(normalizedPartTool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (isPatchTool(normalizedPartTool)) {
            filePath = getPrimaryToolPath(normalizedPartTool, input, metadata);
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (isWriteTool(normalizedPartTool)) {
            filePath = toolInputPath(input);
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
            if (runtime.runtime.isVSCode && toolDiff && (isEditTool(normalizedPartTool) || isPatchTool(normalizedPartTool))) {
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
        const target = resolveToolQuickOpenTarget(toolName, input, metadata);
        if (!target) return null;
        return {
            absolutePath: toAbsoluteFilePath(currentDirectory, target.filePath),
            line: target.line,
            toolDiff: target.patch,
            toolName,
        };
    }, [isTaskTool, normalizedPartTool, part.tool, input, metadata, currentDirectory]);

    const openQuickTarget = () => {
        if (!quickOpenTarget) return;
        const { absolutePath, line, toolDiff, toolName } = quickOpenTarget;
        if (runtime?.editor) {
            if (runtime.runtime.isVSCode && toolDiff && (isEditTool(toolName) || isPatchTool(toolName))) {
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
                                        {getToolIcon(normalizedPartTool || part.tool, presentation)}
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
                                currentDirectory={currentDirectory}
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
                                    {getToolIcon(normalizedPartTool || part.tool, presentation)}
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
                                            'flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded transition-opacity hover:bg-interactive-hover',
                                            'opacity-60 hover:opacity-100 focus-visible:opacity-100',
                                        )}
                                        style={{ color: 'var(--tools-icon)' }}
                                        title={t('chat.toolPart.openFile')}
                                        aria-label={t('chat.toolPart.openFile')}
                                    >
                                        <Icon name="external-link" className="h-3 w-3" />
                                    </button>
                                ) : null}
                            </div>
                            {isShellTool(normalizedPartTool) && typeof effectiveTimeStart === 'number' ? (
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
                                    style={{ color: 'var(--tools-description)' }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && description && (
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
                                presentation={presentation}
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
