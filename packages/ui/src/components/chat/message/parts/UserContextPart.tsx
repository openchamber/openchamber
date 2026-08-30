import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import type { ContextPartPayload } from '@/lib/messages/contextParts';
import { cn } from '@/lib/utils';

/**
 * A context item attached to a user message: an inline code comment, a
 * terminal selection, a browser annotation, or GitHub PR context.
 *
 * The quoted material renders as a messenger-style reply: a source caption and
 * the quote behind a plain left bar, in muted text, clamped to a few lines
 * (click toggles the full quote). The user's comment follows below as regular
 * message text, so the pair reads as "a reply to this quote" instead of a
 * boxed widget inside the bubble.
 */

const ContextCard: React.FC<{
    icon: IconName;
    summary: string;
    /** Full untruncated context, shown on hover. */
    title?: string;
    body: string;
    text: string;
    /** Render the quote in the code font (code, terminal output, CI logs). */
    mono?: boolean;
    /**
     * Message-level collapse: with collapsible messages on, the whole user
     * message (text parts and cards alike) shares one expanded state, so a
     * collapsed card is a two-line preview and a click asks the message to
     * expand instead of toggling anything of its own.
     */
    collapsed?: boolean;
    onExpand?: () => void;
}> = ({ icon, summary, title, body, text, mono, collapsed, onExpand }) => {
    const [expanded, setExpanded] = React.useState(false);
    const hasBody = body.trim().length > 0;
    const hasText = text.trim().length > 0;

    if (collapsed) {
        // One line per attachment: the source caption, and the user's comment
        // after it when there is one ("Quoted from an earlier message: thanks,
        // that settles it"). Attachments without a comment (terminal output
        // and the like) collapse to the caption alone.
        const comment = text.trim();
        return (
            <div
                className="my-1 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 border-l-2 border-[var(--interactive-border)] pl-3 text-xs text-[var(--surface-mutedForeground)]"
                onClick={onExpand}
                title={title}
            >
                <Icon name={icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                    {comment.length > 0 ? `${summary}: ` : summary}
                    {comment.length > 0 ? (
                        <span className="text-sm text-[var(--surface-foreground)]">{comment}</span>
                    ) : null}
                </span>
            </div>
        );
    }

    return (
        <div className="my-1.5 min-w-0 max-w-full">
            <div
                className={cn('min-w-0 border-l-2 border-[var(--interactive-border)] pl-3', hasBody && 'cursor-pointer')}
                onClick={hasBody ? () => setExpanded((value) => !value) : undefined}
                title={title}
            >
                <div className="flex items-center gap-1.5 text-xs text-[var(--surface-mutedForeground)]">
                    <Icon name={icon} className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{summary}</span>
                </div>
                {hasBody ? (
                    <div
                        className={cn(
                            'mt-1 whitespace-pre-wrap break-words text-[var(--surface-mutedForeground)]',
                            mono ? 'font-mono text-xs leading-5' : 'text-sm',
                            !expanded && 'line-clamp-4'
                        )}
                    >
                        {body}
                    </div>
                ) : null}
            </div>
            {hasText ? (
                <div className="mt-1.5 whitespace-pre-wrap break-words font-sans text-sm text-[var(--surface-foreground)]">{text}</div>
            ) : null}
        </div>
    );
};

const basename = (path: string): string => {
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? path;
};

const UserContextPart: React.FC<{
    payload: ContextPartPayload;
    /** Message-level collapse state, shared with the text parts. */
    collapsed?: boolean;
    onExpand?: () => void;
}> = ({ payload, collapsed, onExpand }) => {
    const { t } = useI18n();
    const shared = { collapsed, onExpand };

    switch (payload.kind) {
        case 'code-comment': {
            const file = basename(payload.fileLabel);
            const summary = payload.startLine === payload.endLine
                ? t('chat.message.context.codeCommentLine', { file, line: payload.startLine })
                : t('chat.message.context.codeComment', { file, start: payload.startLine, end: payload.endLine });
            const fullTitle = payload.startLine === payload.endLine
                ? t('chat.message.context.codeCommentLine', { file: payload.fileLabel, line: payload.startLine })
                : t('chat.message.context.codeComment', { file: payload.fileLabel, start: payload.startLine, end: payload.endLine });
            return <ContextCard icon="chat-1" summary={summary} title={fullTitle} body={payload.code} text={payload.text} mono {...shared} />;
        }
        case 'terminal':
            return (
                <ContextCard
                    icon="terminal"
                    summary={t('chat.message.terminalContext', {
                        terminal: payload.terminalLabel,
                        start: payload.startLine,
                        end: payload.endLine,
                    })}
                    body={payload.output}
                    text=""
                    mono
                    {...shared}
                />
            );
        case 'browser-annotation':
            return (
                <ContextCard
                    icon="global"
                    summary={t('chat.message.context.browserAnnotation', { page: payload.pageUrl })}
                    title={payload.pageUrl}
                    body={payload.prompt}
                    text={payload.text}
                    {...shared}
                />
            );
        case 'pr-comment':
            return (
                <ContextCard
                    icon="git-pull-request"
                    summary={t('chat.message.context.prComment', { label: payload.label })}
                    body={payload.body}
                    text={payload.text}
                    {...shared}
                />
            );
        case 'pr-check':
            return (
                <ContextCard
                    icon="close-circle"
                    summary={t('chat.message.context.prCheck', { label: payload.label })}
                    body={payload.output}
                    text={payload.text}
                    mono
                    {...shared}
                />
            );
        case 'file-quote': {
            const file = basename(payload.fileLabel);
            const summary = payload.startLine != null && payload.endLine != null
                ? (payload.startLine === payload.endLine
                    ? t('chat.message.context.codeCommentLine', { file, line: payload.startLine })
                    : t('chat.message.context.codeComment', { file, start: payload.startLine, end: payload.endLine }))
                : t('chat.message.context.fileQuote', { file });
            return <ContextCard icon="chat-1" summary={summary} title={payload.fileLabel} body={payload.quote} text={payload.text} {...shared} />;
        }
        case 'chat-quote':
            return (
                <ContextCard
                    icon="chat-1"
                    summary={t('chat.message.context.chatQuote')}
                    body={payload.quote}
                    text={payload.text}
                    {...shared}
                />
            );
        case 'github-issue':
        case 'github-pr':
        case 'linear-issue':
            // Rendered as link attachments by normalizeUserDisplayParts.
            return null;
    }
};

export default React.memo(UserContextPart);
