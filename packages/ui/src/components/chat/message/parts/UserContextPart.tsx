import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { useChangeRequestTerm } from '@/lib/source-control/providers/registry';
import type { ContextPartPayload } from '@/lib/messages/contextParts';
import { cn } from '@/lib/utils';
import { withAttachmentChips } from './attachmentCitationChips';
import { legacyChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { useChatQuoteHighlightApi } from '../../hooks/chatQuoteHighlightStore';
import { fileWithDiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { isWholeFileComment } from '@/components/comments/wholeFileComment';
import { ReceivedPageCard } from '../../sharePages/received/ReceivedPageCard';
import { readBrowserAnnotationPrompt } from '@/lib/browser/annotationPrompt';
import { quoteDisplayText } from '@/lib/messages/quoteDisplayText';

/**
 * A context item attached to a user message: an inline code comment, a
 * terminal selection, a browser annotation, or GitHub PR context.
 *
 * The quoted material renders as a messenger-style reply: the quote behind an
 * accent bar at the line's start, in muted text, clamped to a few lines (click
 * toggles the full quote), with a source caption above it when the source
 * says something (a file, a terminal, a page). The user's comment follows
 * below as regular message text, and pairs stand apart by space, so each
 * comment reads as the reply to the quote right above it.
 */

/** The bar every quote stands behind, collapsed and expanded alike. */
const QUOTE_BAR_CLASS = 'border-s-3 border-primary/45 ps-3';

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
     * The caption only repeats what the bar already says (a quote from this
     * chat): it is read to screen readers but not drawn, and the collapsed
     * row shows the quote itself.
     */
    captionless?: boolean;
    /**
     * Message-level collapse: with collapsible messages on, the whole user
     * message (text parts and cards alike) shares one expanded state, so a
     * collapsed card is a two-line preview and a click asks the message to
     * expand instead of toggling anything of its own.
     */
    collapsed?: boolean;
    onExpand?: () => void;
    /** Scroll to where the quote came from; a click on the quote does it, and the label is its tooltip. */
    reveal?: { label: string; onReveal: () => void };
    /** The message's file names: `[name]` in the user's comment renders as a file chip. */
    attachmentFilenames: readonly string[];
}> = ({ icon, summary, title, body, text, mono, captionless, collapsed, onExpand, reveal, attachmentFilenames }) => {
    const [expanded, setExpanded] = React.useState(false);
    const hasBody = body.trim().length > 0;
    const hasText = text.trim().length > 0;
    // A captionless card with no quote has nothing else to show.
    const showCaption = !captionless || !hasBody;
    const caption = (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name={icon} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{summary}</span>
        </div>
    );
    const comment = hasText ? (
        <div
            className={cn(
                'mt-1.5 break-words font-sans text-sm text-[var(--surface-foreground)]',
                collapsed ? 'truncate' : 'whitespace-pre-wrap'
            )}
        >
            {withAttachmentChips(text.trim(), attachmentFilenames, 'comment')}
        </div>
    ) : null;

    if (collapsed) {
        // Two lines at most: the quote's first line (or the source caption
        // where the source says more), and the user's comment under it.
        // contextPartsPastCollapse counts the same lines.
        const handleKeyDown = (event: React.KeyboardEvent): void => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onExpand?.();
        };
        return (
            <div
                className="my-3 min-w-0 max-w-full cursor-pointer"
                role="button"
                tabIndex={0}
                onClick={onExpand}
                onKeyDown={handleKeyDown}
                title={title}
            >
                <div className={QUOTE_BAR_CLASS}>
                    {showCaption ? caption : (
                        <div className="truncate text-sm text-muted-foreground">
                            <span className="sr-only">{summary}: </span>
                            {body.trim().split('\n')[0]}
                        </div>
                    )}
                </div>
                {comment}
            </div>
        );
    }

    // A quote from this chat leads to its source: the original shows it whole,
    // so a click goes there. Other quotes have nowhere to go and unfold instead.
    const activateQuote = reveal ? reveal.onReveal : () => setExpanded((value) => !value);
    const handleQuoteKeyDown = (event: React.KeyboardEvent): void => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateQuote();
    };

    return (
        <div className="my-3 min-w-0 max-w-full">
            <div
                className={cn(
                    'min-w-0',
                    QUOTE_BAR_CLASS,
                    hasBody && 'cursor-pointer',
                    reveal && hasBody && 'text-muted-foreground transition-colors hover:text-foreground',
                )}
                role={hasBody ? 'button' : undefined}
                tabIndex={hasBody ? 0 : undefined}
                onClick={hasBody ? activateQuote : undefined}
                onKeyDown={hasBody ? handleQuoteKeyDown : undefined}
                title={reveal?.label ?? title}
            >
                {showCaption ? caption : <span className="sr-only">{summary}</span>}
                {hasBody ? (
                    <div
                        className={cn(
                            'whitespace-pre-wrap break-words',
                            !reveal && 'text-muted-foreground',
                            mono ? 'font-mono text-xs leading-5' : 'text-sm',
                            showCaption && 'mt-1',
                            !expanded && 'line-clamp-4'
                        )}
                    >
                        {body}
                    </div>
                ) : null}
            </div>
            {comment}
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
    attachmentFilenames: readonly string[];
}> = ({ payload, collapsed, onExpand, attachmentFilenames }) => {
    const { t } = useI18n();
    const quoteHighlights = useChatQuoteHighlightApi();
    // A part without a provider was written before providers other than GitHub existed: a pull request.
    const changeRequestTerm = useChangeRequestTerm(payload.kind === 'pr-comment' || payload.kind === 'pr-check' ? payload.provider : null);
    const shared = { collapsed, onExpand, attachmentFilenames };

    switch (payload.kind) {
        case 'code-comment': {
            const file = fileWithDiffCommentOrigin(basename(payload.fileLabel), payload.origin);
            const fullFile = fileWithDiffCommentOrigin(payload.fileLabel, payload.origin);
            const wholeFile = isWholeFileComment(payload);
            const summary = wholeFile
                ? t('chat.message.context.codeCommentFile', { file })
                : payload.startLine === payload.endLine
                ? t('chat.message.context.codeCommentLine', { file, line: payload.startLine })
                : t('chat.message.context.codeComment', { file, start: payload.startLine, end: payload.endLine });
            const fullTitle = wholeFile
                ? t('chat.message.context.codeCommentFile', { file: fullFile })
                : payload.startLine === payload.endLine
                ? t('chat.message.context.codeCommentLine', { file: fullFile, line: payload.startLine })
                : t('chat.message.context.codeComment', { file: fullFile, start: payload.startLine, end: payload.endLine });
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
        case 'browser-annotation': {
            // The prompt is written for the model (selectors, bounds, styles);
            // the card shows what the user pointed at and what they said.
            const annotation = readBrowserAnnotationPrompt(payload.prompt);
            return (
                <ContextCard
                    icon="global"
                    summary={t('chat.message.context.browserAnnotation', { page: payload.pageUrl })}
                    title={payload.pageUrl}
                    body={annotation.texts.join('\n') || annotation.page || ''}
                    text={payload.text || annotation.comment || ''}
                    {...shared}
                />
            );
        }
        case 'pr-comment':
            return (
                <ContextCard
                    icon="git-pull-request"
                    summary={t(changeRequestCopy('chat.message.context.prComment', changeRequestTerm), { label: payload.label })}
                    body={payload.body}
                    text={payload.text}
                    {...shared}
                />
            );
        case 'pr-check':
            return (
                <ContextCard
                    icon="close-circle"
                    summary={t(changeRequestCopy('chat.message.context.prCheck', changeRequestTerm), { label: payload.label })}
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
        case 'chat-quote': {
            const sourceMessageId = payload.messageId;
            return (
                <ContextCard
                    icon="chat-1"
                    summary={t('chat.message.context.chatQuote')}
                    body={quoteDisplayText(payload.quote)}
                    text={payload.text}
                    captionless
                    reveal={quoteHighlights && sourceMessageId
                        ? {
                            label: t('chat.message.context.showQuoteSource'),
                            onReveal: () => quoteHighlights.reveal(sourceMessageId, payload.anchor ?? legacyChatQuoteAnchor(payload.quote)),
                        }
                        : undefined}
                    {...shared}
                />
            );
        }
        case 'repository-issue':
        case 'repository-discussion':
        case 'change-request':
        case 'tracker-item':
        case 'guest-issue':
        case 'guest-pr':
        case 'session':
        case 'session-message':
            // Rendered as link attachments by normalizeUserDisplayParts.
            return null;
        case 'shared-page':
            return <ReceivedPageCard payload={payload} />;
    }
};

export default React.memo(UserContextPart);
