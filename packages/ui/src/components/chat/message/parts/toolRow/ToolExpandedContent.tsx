import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { SimpleMarkdownRenderer } from '../../../MarkdownRenderer';
import { FormMarkdown } from '../../../FormMarkdown';
import { MessageFilesDisplay } from '../../../FileAttachment';
import type { ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@/lib/opencode/model';
import { HighlightedCode } from '@/components/code/HighlightedCode';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import type { ToolPopupContent } from '../../types';
import { PlainDiffFallback } from '../PlainDiffFallback';
import { formatInputForDisplay, coerceToText } from '../../toolRenderers';
import { Icon } from '@/components/icon/Icon';
import { DiffViewToggle, type DiffViewMode } from '../../DiffViewToggle';
import { useDefaultDiffViewMode } from '../../useDefaultDiffViewMode';
import { type GuestToolRule } from '@/lib/guests/tool-presentation';
import { prepareTaskToolOutput } from '../taskToolModel';
import { fenceUiBlocks } from '../../../uiBlocks/taggedBlocks';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { extractFirstChangedLineFromDiff, getDiffPatchEntries, getToolFallbackDiff, type DiffPatchEntry } from '../toolDiffUtils';
import { useStreamingTextThrottle } from '../../../hooks/useStreamingTextThrottle';
import { getToolOutput } from '../toolOutput';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { executeOutputTruncation, executeScript, executeToolCalls, isEditTool, isExecuteTool, isFileChangeTool, isPatchTool, isQuestionTool, isShellTool, isSubagentTool, isTodoWriteTool, isWebSearchTool, todoWriteItems, isWriteTool, isOpenChamberTool, openChamberCallSummary } from '@/lib/opencode/tools';
import { parseWebSearchOutput, webSearchProviderOf } from '@/lib/opencode/websearch';
import { OpenChamberToolOutput } from '../OpenChamberToolOutput';
import { OpencodeToolOutput } from '../OpencodeToolOutput';
import { opencodeCallSucceeded, opencodeToolVerb, parseOpencodeToolResult } from '../opencodeToolResult';
import { hasOpenChamberView, parseOpenChamberEnvelope, secretRowView } from '../openChamberToolEnvelope';
import { Field, QuietAction } from '../ToolResultParts';
import { WebSearchResults } from '../WebSearchResults';
import { TodoWriteList } from '../TodoWriteList';
import { createPortal } from 'react-dom';
import type { ToolStateWithMetadata } from './types';
import { TOOL_COLLAPSED_CUSTOM_STYLE, CODE_TAG_PROPS, TOOL_ERROR_TITLE_STYLE } from './toolRowStyles';
import { getRelativePath } from './toolPaths';
import { buildWritePreviewPatch } from './toolChangeSummary';
import { getToolDiagnosticSection } from './toolDiagnostics';
import { parseQuestionOutput } from './questionOutput';
import { ToolScrollableSection } from './ToolScrollableSection';
import { CommandOutput } from './CommandOutput';
import { ToolScrollableTextOutput } from './ToolScrollableTextOutput';
import { renderPathLikeGitChanges } from './toolPathRendering';
import { DiffPreview } from './DiffPreview';

const RawAnswerToggle: React.FC<{ label: string; onToggle: () => void }> = ({ label, onToggle }) => (
    <QuietAction icon="code-box" label={label} onClick={onToggle} />
);

interface ToolExpandedContentProps {
    part: ToolPartType;
    state: ToolStateUnion;
    currentDirectory: string;
    isExpanded: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    presentation: GuestToolRule | null;
    headerActionsSlot: HTMLElement | null;
}

export const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    currentDirectory,
    isExpanded,
    onShowPopup,
    presentation,
    headerActionsSlot,
}) => {
    const { t } = useI18n();
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const defaultDiffViewMode = useDefaultDiffViewMode();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>(defaultDiffViewMode);
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
    const isMobile = useUIStore((store) => store.isMobile);
    const openChamberEnvelope = React.useMemo(
        () => (state.status === 'completed' && openChamberCallSummary(part.tool, input) ? parseOpenChamberEnvelope(rawOutputString) : null),
        [input, part.tool, rawOutputString, state.status],
    );
    const opencodeResult = React.useMemo(() => {
        const verb = opencodeToolVerb(part.tool);
        return verb && opencodeCallSucceeded(part) ? parseOpencodeToolResult(verb.tool, rawOutputString) : null;
    }, [part, rawOutputString]);
    const [showRawToolAnswer, setShowRawToolAnswer] = React.useState(false);
    const attachments = stateWithData.attachments;
    const diffContent = getToolFallbackDiff(metadata) ?? null;
    const diffEntries = React.useMemo(
        () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
        [currentDirectory, diffContent, metadata]
    );
    const todoItems = React.useMemo(
        () => (isTodoWriteTool(part.tool) && state.status === 'completed' ? todoWriteItems(input) : null),
        [input, part.tool, state.status],
    );
    const showTodoList = todoItems !== null && todoItems.length > 0;
    const hideToolInputPreview = isOpenChamberTool(part.tool)
        || showTodoList
        || (opencodeResult !== null && !showRawToolAnswer)
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
        setDiffViewMode(defaultDiffViewMode);
    }, [defaultDiffViewMode, part.id]);

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
                    className="tool-output-surface rounded-xl p-2 space-y-2"
                    style={{
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
                                <div key={`${diagnosticSection.displayPath}:${diagnostic.line}:${diagnostic.character}:${index}`} className="oc-tile-inset rounded-md px-2 py-1">
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

        if (presentation?.output && presentation.output !== 'auto' && hasStringOutput && outputString.trim()) {
            return renderScrollableBlock(
                <ToolScrollableTextOutput
                    output={coerceToText(outputString)}
                    part={part}
                    metadata={metadata}
                    input={input}
                    presentation={presentation}
                    onShowPopup={onShowPopup}
                />
            );
        }

        if (isQuestionTool(part.tool)) {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="space-y-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="space-y-0.5">
                                    <FormMarkdown content={qa.question} size="micro" className="text-muted-foreground" />
                                    <div dir="auto" className="typography-meta text-foreground whitespace-pre-wrap">{qa.answer}</div>
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
                        <div className="typography-meta p-2 rounded-xl" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                        }}>
                            {coerceToText(state.error)}
                        </div>
                    </div>
                );
            }

            const questionInput = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label: string; description: string }>; multiple?: boolean }> } | undefined;
            if (questionInput?.questions && Array.isArray(questionInput.questions) && questionInput.questions.length > 0) {
                return renderScrollableBlock(
                    <div className="space-y-2">
                        {questionInput.questions.map((q, index) => (
                            <div key={index} className="space-y-0.5">
                                {q.header ? (
                                    <div dir="auto" className="typography-micro text-muted-foreground">{coerceToText(q.header)}</div>
                                ) : null}
                                <FormMarkdown content={coerceToText(q.question)} size="meta" className="text-foreground" />
                                {Array.isArray(q.options) && q.options.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {q.options.map((opt) => (
                                            <span key={coerceToText(opt.label)} dir="auto" className="typography-micro px-1.5 py-0.5 rounded oc-tile-inset text-muted-foreground">
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
                    <SimpleMarkdownRenderer content={fenceUiBlocks(prepareTaskToolOutput(outputString))} singleTilde={false} variant="tool" onShowPopup={onShowPopup} uiBlocks />
                </div>
            );
        }

        if (isFileChangeTool(part.tool) && (diffEntries.length > 0 || !!diagnosticSection)) {
            const renderEntryActions = (entry: DiffPatchEntry) => (
                <>
                                {entry.renderMode === 'diff' ? (
                                    <DiffViewToggle
                                        mode={diffViewMode}
                                        onModeChange={setDiffViewMode}
                                        iconClassName="size-3.5"
                                    />
                                ) : null}
                                <HoverTooltip label={t('chat.toolPart.openFileAtFirstChange')}>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                        onClick={(event) => openEntryFile(entry, event)}
                                        aria-label={t('chat.toolPart.openFileAtFirstChange')}
                                    >
                                        <Icon name="file-edit" className="size-3.5" />
                                    </Button>
                                </HoverTooltip>
                                <HoverTooltip label={t('chat.toolPart.openFileDiff')}>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                        onClick={(event) => openEntryDiff(entry, event)}
                                        aria-label={t('chat.toolPart.openFileDiff')}
                                    >
                                        <Icon name="git-pull-request" className="size-3.5" />
                                    </Button>
                                </HoverTooltip>
                </>
            );
            const singleEntry = diffEntries.length === 1 && headerActionsSlot ? diffEntries[0] : null;
            return renderScrollableBlock(
                <div className="space-y-3">
                    {singleEntry && isExpanded && headerActionsSlot ? createPortal(renderEntryActions(singleEntry), headerActionsSlot) : null}
                    {diffEntries.map((entry) => (
                        <div key={entry.id} className="w-full min-w-0">
                            {singleEntry ? null : (
                                <div className="mb-1 flex min-w-0 items-center gap-1 py-1">
                                    <div className="min-w-0 flex-1 typography-meta font-medium text-muted-foreground">
                                        {renderPathLikeGitChanges(entry.title)}
                                    </div>
                                    {renderEntryActions(entry)}
                                </div>
                            )}
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
                { outerClassName: 'w-[calc(100%+0.375rem)]' },
            );
        }

        if (part.tool === 'write' && diagnosticSection) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {renderDiagnosticsSection()}
                </div>
            );
        }

        if (isWriteLikeTool) {
            return null;
        }

        if (showTodoList && todoItems) {
            return renderScrollableBlock(<TodoWriteList items={todoItems} />, { maxHeightClass: 'max-h-[40vh]', disableHorizontal: true });
        }

        if (webSearchOutput) {
            return renderScrollableBlock(
                <WebSearchResults output={webSearchOutput} providerId={webSearchProviderOf(metadata)} />,
                { maxHeightClass: 'max-h-[50vh]' }
            );
        }

        if (opencodeResult && !showRawToolAnswer) {
            return renderScrollableBlock(
                <div className="space-y-2">
                    <OpencodeToolOutput
                        result={opencodeResult}
                        rawToggle={<RawAnswerToggle label={t('chat.toolPart.openchamber.raw.show')} onToggle={() => setShowRawToolAnswer(true)} />}
                    />
                </div>
            );
        }

        const secret = !showRawToolAnswer ? secretRowView(openChamberEnvelope) : null;
        if (secret) {
            const ran = openChamberEnvelope?.action === 'secret.run';
            return renderScrollableBlock(
                <div className="space-y-2">
                    {secret.output
                        ? <CommandOutput output={secret.output} language="text" />
                        : secret.file
                            ? <Field label={t('chat.toolPart.openchamber.field.file')}>{secret.file}</Field>
                            : ran ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.noOutputProduced')}</div> : null}
                    <RawAnswerToggle label={t('chat.toolPart.openchamber.raw.show')} onToggle={() => setShowRawToolAnswer(true)} />
                </div>,
                { maxHeightClass: ran ? 'max-h-[46vh]' : 'max-h-60' },
            );
        }

        if (openChamberEnvelope && !showRawToolAnswer) {
            const showRaw = (
                <RawAnswerToggle label={t('chat.toolPart.openchamber.raw.show')} onToggle={() => setShowRawToolAnswer(true)} />
            );
            if (!openChamberEnvelope.ok && openChamberEnvelope.errorMessage) {
                return renderScrollableBlock(
                    <div className="space-y-1.5">
                        <div className="typography-meta whitespace-pre-wrap break-words" style={{ color: 'var(--status-error)' }}>
                            {openChamberEnvelope.errorMessage}
                        </div>
                        {showRaw}
                    </div>
                );
            }
            if (hasOpenChamberView(openChamberEnvelope)) {
                return renderScrollableBlock(
                    <div className="space-y-2">
                        <OpenChamberToolOutput envelope={openChamberEnvelope} part={part} input={input} directory={currentDirectory} isMobile={isMobile} onShowPopup={onShowPopup} rawToggle={showRaw} />
                    </div>
                );
            }
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
                (openChamberEnvelope || opencodeResult) && showRawToolAnswer ? (
                    <div className="space-y-2">
                        <RawAnswerToggle label={t('chat.toolPart.openchamber.raw.hide')} onToggle={() => setShowRawToolAnswer(false)} />
                        {output}
                    </div>
                ) : output,
                {
                    maxHeightClass: isShellTool(part.tool) ? 'max-h-[46vh]' : undefined,
                    followKey: isStreamingBash ? outputString : undefined,
                }
            );
        }

        return renderScrollableBlock(
            <div className="typography-meta text-muted-foreground">{t('chat.toolPart.noOutputProduced')}</div>,
            { maxHeightClass: 'max-h-60' }
        );
    };

    const hasVisibleOutput = outputString.trim().length > 0;
    const shouldRenderResult = (state.status === 'completed' && 'output' in state)
        || (isShellTool(part.tool) && hasVisibleOutput);

    return (
        <div className="relative space-y-2">
            {isQuestionTool(part.tool) ? (
                renderResultContent()
            ) : (
                <>
                    {isExecute ? (
                        <div className="space-y-2">
                            {executeCode ? renderScrollableBlock(
                                <HighlightedCode
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
                                    <div className="typography-meta font-medium text-muted-foreground mb-1">
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
                                                    <span className="typography-micro flex-shrink-0 text-muted-foreground">
                                                        {call.status}
                                                    </span>
                                                ) : null}
                                                {call.input ? (
                                                    <span className="typography-meta truncate text-muted-foreground">
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

                    {hasInputText ? renderScrollableBlock(
                        isWriteLikeTool && writeLikeInputPatch ? (
                            <DiffPreview
                                diff={writeLikeInputPatch}
                                diffViewMode={diffViewMode}
                            />
                        ) : isSubagentTool(part.tool) ? (
                            <div className="tool-input-text tool-prose-text whitespace-pre-wrap break-words text-muted-foreground">
                                {inputTextContent}
                            </div>
                        ) : (
                            <pre
                                className="tool-input-text whitespace-pre-wrap break-words text-muted-foreground m-0"
                                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                            >
                                {inputTextContent}
                            </pre>
                        ),
                        {
                            maxHeightClass: isWriteLikeTool && writeLikeInputPatch && isExpanded ? 'max-h-[50vh]' : 'max-h-60',
                            className: 'tool-input-surface',
                        }
                    ) : null}

                    {shouldRenderResult && (
                        <div>
                            {renderResultContent()}
                            {executeTruncation ? (
                                <div className="typography-meta mt-1 text-muted-foreground">
                                    {t('chat.toolPart.outputTruncated')}
                                    {executeTruncation.outputPath ? ` \u2014 ${executeTruncation.outputPath}` : ''}
                                </div>
                            ) : null}
                        </div>
                    )}

                    {state.status === 'error' && 'error' in state && (
                        <div>
                            <div className="typography-meta font-medium text-muted-foreground mb-1">{t('chat.toolPart.error')}</div>
                            <div className="typography-meta p-2 rounded-xl" style={{
                                backgroundColor: 'var(--status-error-background)',
                                color: 'var(--status-error)',
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
