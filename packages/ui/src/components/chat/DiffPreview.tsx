import React from 'react';
import { cn } from '@/lib/utils';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownTheme';
import { useWorkerHighlightedLines } from '@/components/code/useWorkerHighlightedLines';
import { parseDiffToUnified } from './message/toolRenderers';

// One highlighted line: swaps in worker-tokenized inner HTML when ready, falls
// back to plain text while loading or on failure.
const CodeLineContent: React.FC<{ content: string; html: string | undefined }> = ({ content, html }) =>
  html !== undefined ? (
    <span className="whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="whitespace-pre-wrap break-all">{content}</span>
  );

interface DiffPreviewProps {
    diff: string;
    filePath?: string;
}

export const DiffPreview: React.FC<DiffPreviewProps> = ({ diff, filePath }) => {
    const { currentTheme } = useThemeSystem();
    const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
    const hunks = React.useMemo(() => parseDiffToUnified(diff), [diff]);
    const language = getLanguageFromExtension(filePath || hunks[0]?.file) || 'text';

    // Flatten all rendered lines so the whole diff tokenizes in one worker call.
    const flatContent = React.useMemo(
        () => hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)).join('\n'),
        [hunks],
    );
    const highlighted = useWorkerHighlightedLines(flatContent, language);

    let lineCursor = 0;
    return (
        <div className="typography-code px-1 pb-1 pt-0 space-y-0" style={syntaxVars as React.CSSProperties}>
            {hunks.map((hunk, hunkIdx) => (
                <div key={hunkIdx} className="-mx-1 px-1 border-b border-border/20 last:border-b-0">
                    <div className="bg-muted/20 px-2 py-1 typography-meta font-medium text-muted-foreground border-b border-border/10 break-words -mx-1">
                        {`${hunk.file || filePath?.split('/').pop() || 'file'} (line ${hunk.oldStart})`}
                    </div>

                    <div>
                        {hunk.lines.map((line, lineIdx) => {
                            const html = highlighted?.[lineCursor];
                            lineCursor += 1;
                            return (
                                <div
                                    key={lineIdx}
                                    className={cn(
                                        'typography-code font-mono px-2 py-0.5 flex -mx-2',
                                        line.type === 'context' && 'bg-transparent',
                                        line.type === 'removed' && 'bg-transparent',
                                        line.type === 'added' && 'bg-transparent'
                                    )}
                                    style={
                                        line.type === 'removed'
                                            ? { backgroundColor: 'var(--tools-edit-removed-bg)' }
                                            : line.type === 'added'
                                                ? { backgroundColor: 'var(--tools-edit-added-bg)' }
                                                : {}
                                    }
                                >
                                    <span className="w-10 flex-shrink-0 text-right pr-3 select-none border-r mr-3 -my-0.5 py-0.5" style={{ color: 'var(--tools-edit-line-number)', borderColor: 'var(--tools-border)' }}>
                                        {line.lineNumber || ''}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <CodeLineContent content={line.content} html={html} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};

interface WritePreviewProps {
    content: string;
    filePath?: string;
}

export const WritePreview: React.FC<WritePreviewProps> = ({ content, filePath }) => {
    const { currentTheme } = useThemeSystem();
    const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
    const lines = React.useMemo(() => content.split('\n'), [content]);
    const language = getLanguageFromExtension(filePath ?? '') || 'text';
    const displayPath = filePath?.split('/').pop() || 'New file';
    const lineCount = Math.max(lines.length, 1);
    const headerLineLabel = lineCount === 1 ? 'line 1' : `lines 1-${lineCount}`;
    const highlighted = useWorkerHighlightedLines(content, language);

    return (
        <div className="w-full min-w-0" style={syntaxVars as React.CSSProperties}>
            <div className="bg-muted/20 px-2 py-1 typography-meta font-medium text-muted-foreground border border-border/10 rounded-lg mb-1">
                {`${displayPath} (${headerLineLabel})`}
            </div>
            <div className="space-y-0">
                {lines.map((line, lineIdx) => (
                    <div key={lineIdx} className="typography-code font-mono px-2 py-0.5 flex -mx-1">
                        <span className="w-10 flex-shrink-0 text-right pr-3 select-none border-r mr-3 -my-0.5 py-0.5" style={{ color: 'var(--tools-edit-line-number)', borderColor: 'var(--tools-border)' }}>
                            {lineIdx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                            <CodeLineContent content={line || ' '} html={highlighted?.[lineIdx]} />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
