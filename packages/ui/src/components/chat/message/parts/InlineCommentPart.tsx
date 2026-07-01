import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

type Props = {
    comment: string;
    path: string;
    startLine: number;
    endLine: number;
    preview?: string;
};

const InlineCommentPart: React.FC<Props> = ({
    comment,
    path,
    startLine,
    endLine,
    preview,
}) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);

    const filename = path.split('/').pop() ?? path;
    const isSingleLine = startLine === endLine || endLine === 0;
    const hasFilename = Boolean(filename) && filename !== path;

    let subtitle: string;
    if (hasFilename) {
        subtitle = isSingleLine
            ? t('chat.message.inlineComment.lineSingleOfFile', { line: startLine, file: filename })
            : t('chat.message.inlineComment.lineRangeOfFile', { start: startLine, end: endLine, file: filename });
    } else {
        subtitle = isSingleLine
            ? t('chat.message.inlineComment.lineSingle', { line: startLine })
            : t('chat.message.inlineComment.lineRange', { start: startLine, end: endLine });
    }

    const hasPreview = Boolean(preview && preview.trim());

    return (
        <div
            data-component="inline-comment-part"
            style={{
                backgroundColor: 'var(--surface-elevated)',
                borderLeft: '3px solid var(--status-warning)',
                borderRadius: '6px',
            }}
            className="my-2 px-3 py-2 overflow-hidden"
        >
            <p
                className="text-sm leading-snug whitespace-pre-wrap break-words"
                style={{ color: 'var(--surface-foreground)' }}
            >
                {comment}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
                <p
                    className="text-xs"
                    style={{ color: 'var(--surface-muted-foreground)' }}
                >
                    {subtitle}
                </p>
                {hasPreview && (
                    <button
                        type="button"
                        onClick={() => setExpanded((prev) => !prev)}
                        className="inline-flex items-center gap-0.5 rounded text-xs hover:opacity-80"
                        style={{ color: 'var(--surface-muted-foreground)' }}
                        aria-expanded={expanded}
                        aria-label={
                            expanded
                                ? t('chat.message.inlineComment.collapse')
                                : t('chat.message.inlineComment.expand')
                        }
                    >
                        <Icon
                            name={expanded ? 'arrow-up-s' : 'arrow-down-s'}
                            className="h-3.5 w-3.5"
                        />
                        <span>
                            {expanded
                                ? t('chat.message.inlineComment.collapse')
                                : t('chat.message.inlineComment.expand')}
                        </span>
                    </button>
                )}
            </div>
            {hasPreview && (
                expanded ? (
                    <pre
                        className="mt-1.5 max-h-64 overflow-auto rounded-md px-2 py-1.5 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words"
                        style={{
                            backgroundColor: 'var(--surface-muted)',
                            color: 'var(--surface-muted-foreground)',
                        }}
                    >
                        {preview}
                    </pre>
                ) : (
                    <p
                        className="mt-1.5 text-xs font-mono truncate"
                        style={{ color: 'var(--surface-muted-foreground)' }}
                    >
                        {preview}
                    </p>
                )
            )}
        </div>
    );
};

export default React.memo(InlineCommentPart);
