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


const QUOTE_BAR_CLASS = 'border-s-3 border-primary/45 ps-3';

const ContextCard: React.FC<{
    icon: IconName;
    summary: string;
    title?: string;
    body: string;
    text: string;
    mono?: boolean;
    captionless?: boolean;
    collapsed?: boolean;
    onExpand?: () => void;
    reveal?: { label: string; onReveal: () => void };
    attachmentFilenames: readonly string[];
}> = ({ icon, summary, title, body, text, mono, captionless, collapsed, onExpand, reveal, attachmentFilenames }) => {
    const [expanded, setExpanded] = React.useState(false);
    const hasBody = body.trim().length > 0;
    const hasText = text.trim().length > 0;
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
    collapsed?: boolean;
    onExpand?: () => void;
    attachmentFilenames: readonly string[];
}> = ({ payload, collapsed, onExpand, attachmentFilenames }) => {
    const { t } = useI18n();
    const quoteHighlights = useChatQuoteHighlightApi();
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
            return null;
        case 'shared-page':
            return <ReceivedPageCard payload={payload} />;
    }
};

export default React.memo(UserContextPart);
