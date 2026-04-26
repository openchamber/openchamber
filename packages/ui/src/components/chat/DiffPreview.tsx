import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { cn } from '@/lib/utils';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { parseDiffToUnified } from './message/toolRenderers';

const DIFF_CUSTOM_STYLE: React.CSSProperties = {
    margin: 0,
    padding: 0,
    fontSize: 'inherit',
    background: 'transparent',
    backgroundColor: 'transparent',
    borderRadius: 0,
    overflow: 'visible',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    overflowWrap: 'anywhere',
};

const DIFF_CODE_TAG_PROPS = {
    style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } as React.CSSProperties,
};

interface DiffPreviewProps {
    diff: string;
    syntaxTheme: { [key: string]: React.CSSProperties };
    filePath?: string;
}

export const DiffPreview: React.FC<DiffPreviewProps> = ({ diff, syntaxTheme, filePath }) => (
    <div className="typography-code px-1 pb-1 pt-0 space-y-0">
        {parseDiffToUnified(diff).map((hunk, hunkIdx) => (
            <div key={hunkIdx} className="-mx-1 px-1 border-b border-border/20 last:border-b-0">
                <div className="bg-muted/20 px-2 py-1 typography-meta font-medium text-muted-foreground border-b border-border/10 break-words -mx-1">
                    {`${hunk.file || filePath?.split('/').pop() || 'file'} (line ${hunk.oldStart})`}
                </div>

                <div>
                    {hunk.lines.map((line, lineIdx) => (
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
                                <SyntaxHighlighter
                                    style={syntaxTheme}
                                    language={getLanguageFromExtension(filePath || hunk.file) || 'text'}
                                    PreTag="div"
                                    wrapLines
                                    wrapLongLines
                                    customStyle={DIFF_CUSTOM_STYLE}
                                    codeTagProps={DIFF_CODE_TAG_PROPS}
                                >
                                    {line.content}
                                </SyntaxHighlighter>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        ))}
    </div>
);

interface WritePreviewProps {
    content: string;
    syntaxTheme: { [key: string]: React.CSSProperties };
    filePath?: string;
}

export const WritePreview: React.FC<WritePreviewProps> = ({ content, syntaxTheme, filePath }) => {
    const lines = content.split('\n');
    const language = getLanguageFromExtension(filePath ?? '') || 'text';
    const displayPath = filePath?.split('/').pop() || 'New file';
    const lineCount = Math.max(lines.length, 1);
    const headerLineLabel = lineCount === 1 ? 'line 1' : `lines 1-${lineCount}`;

    return (
        <div className="w-full min-w-0">
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
                            <SyntaxHighlighter
                                style={syntaxTheme}
                                language={language}
                                PreTag="div"
                                wrapLines
                                wrapLongLines
                                customStyle={DIFF_CUSTOM_STYLE}
                                codeTagProps={DIFF_CODE_TAG_PROPS}
                            >
                                {line || ' '}
                            </SyntaxHighlighter>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
