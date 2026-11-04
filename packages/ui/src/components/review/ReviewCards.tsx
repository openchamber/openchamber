import * as React from 'react';

import { MarkdownSuggestionContext } from '@/components/chat/markdown/markdownSuggestion';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { InlineCommentInput } from '@/components/comments/InlineCommentInput';
import { Icon } from '@/components/icon/Icon';
import { relativeTimeOf } from '@/components/references/referencePickerItems';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import type { ReviewCommentExcerpt } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import type { ReviewDraftComment, ReviewPerson, ReviewThread } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

import type { ChangeRequestReview } from './useChangeRequestReview';

const CARD_CLASS = 'w-full max-w-[min(100%,calc(var(--oc-context-panel-width,100vw)-var(--oc-editor-gutter-width,0px)))] overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] font-sans shadow-none';
const HEADER_ACTION_CLASS = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground';

export const ReviewAvatar: React.FC<{ person: ReviewPerson | null }> = ({ person }) => {
    const { broken, onError } = useAvatarImage(person?.avatarUrl ?? null);
    return (
        <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-surface-elevated typography-micro text-muted-foreground">
            {person?.avatarUrl && !broken ? (
                <img src={person.avatarUrl} alt="" className="size-full object-cover" loading="lazy" onError={onError} />
            ) : (
                <span>{(person?.login ?? '?').slice(0, 1).toUpperCase()}</span>
            )}
        </span>
    );
};

/** Comment text; a ```suggestion fence draws as a diff of the lines it replaces. */
const ReviewCommentBody: React.FC<{ body: string; excerpt: ReviewCommentExcerpt | null }> = ({ body, excerpt }) => {
    const suggestion = React.useMemo(() => ({ excerpt }), [excerpt]);
    return (
        <MarkdownSuggestionContext.Provider value={suggestion}>
            <SimpleMarkdownRenderer
                content={body}
                className="[&_img]:h-auto [&_img]:max-w-full"
                enableFileReferences={false}
                singleTilde
            />
        </MarkdownSuggestionContext.Provider>
    );
};

/** An unpublished comment of the viewer's, under its lines. */
export const ReviewDraftCard: React.FC<{
    comment: ReviewDraftComment;
    review: ChangeRequestReview;
    excerpt: ReviewCommentExcerpt | null;
    fileLabel: string;
    maxWidth?: number;
}> = ({ comment, review, excerpt, fileLabel, maxWidth }) => {
    const { t } = useI18n();
    const [editing, setEditing] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    const save = async (text: string) => {
        setBusy(true);
        const saved = await review.updateComment(comment.id, text);
        setBusy(false);
        if (saved) setEditing(false);
    };
    const remove = async () => {
        setBusy(true);
        await review.deleteComment(comment.id);
        setBusy(false);
    };

    if (editing) {
        return (
            <InlineCommentInput
                initialText={comment.body}
                fileLabel={fileLabel}
                lineRange={comment.line === null ? undefined : { start: comment.startLine ?? comment.line, end: comment.line }}
                wholeFile={comment.line === null}
                isEditing
                band={false}
                saveLabel={t('inlineComment.actions.save')}
                saving={busy}
                onSave={(text) => void save(text)}
                onCancel={() => setEditing(false)}
                maxWidth={maxWidth}
            />
        );
    }
    return (
        <div className={CARD_CLASS} style={maxWidth ? { maxWidth: `${Math.max(200, Math.floor(maxWidth))}px` } : undefined} data-comment-card="true">
            <div className="flex items-center gap-1.5 px-3 pt-2">
                <ReviewAvatar person={comment.author} />
                <span className="text-xs font-medium text-foreground">{t('review.card.you')}</span>
                <span className="me-auto rounded-full bg-[var(--status-warning-background)] px-1.5 text-xs text-[var(--status-warning)]">{t('review.card.pending')}</span>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex shrink-0">
                            <button type="button" className={HEADER_ACTION_CLASS} style={{ minHeight: 0, minWidth: 0 }} disabled={busy} onClick={() => setEditing(true)} aria-label={t('inlineComment.actions.editComment')}>
                                <Icon name="pencil" className="h-3 w-3" />
                            </button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('inlineComment.actions.editComment')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex shrink-0">
                            <button type="button" className={HEADER_ACTION_CLASS} style={{ minHeight: 0, minWidth: 0 }} disabled={busy} onClick={() => void remove()} aria-label={t('inlineComment.actions.deleteComment')}>
                                {busy ? <Spinner className="size-3" /> : <Icon name="close" className="h-3 w-3" />}
                            </button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('inlineComment.actions.deleteComment')}</TooltipContent>
                </Tooltip>
            </div>
            <div className="px-3 pb-2 pt-1 text-sm leading-relaxed text-foreground">
                <ReviewCommentBody body={comment.body} excerpt={excerpt} />
            </div>
        </div>
    );
};

const CommentByline: React.FC<{ person: ReviewPerson | null; createdAt: string; now: number }> = ({ person, createdAt, now }) => {
    const { t } = useI18n();
    const relative = relativeTimeOf(createdAt, now);
    return (
        <>
            <ReviewAvatar person={person} />
            <span className="text-xs font-medium text-foreground">{person?.login ?? '—'}</span>
            {relative ? (
                <span className="truncate text-xs text-muted-foreground">
                    {relative.key === 'common.relative.justNow' ? t(relative.key) : t(relative.key, { count: relative.count })}
                </span>
            ) : null}
        </>
    );
};

/** A published thread under its lines; a resolved one folds to one row until opened. */
export const ReviewThreadCard: React.FC<{
    thread: ReviewThread;
    review: ChangeRequestReview;
    excerpt: ReviewCommentExcerpt | null;
    maxWidth?: number;
}> = ({ thread, review, excerpt, maxWidth }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(!thread.resolved);
    const [shownResolved, setShownResolved] = React.useState(thread.resolved);
    if (shownResolved !== thread.resolved) {
        setShownResolved(thread.resolved);
        setOpen(!thread.resolved);
    }
    const [replying, setReplying] = React.useState(false);
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState<'reply' | 'resolve' | null>(null);
    const [now] = React.useState(() => Date.now());
    const style = maxWidth ? { maxWidth: `${Math.max(200, Math.floor(maxWidth))}px` } : undefined;
    const [first, ...replies] = thread.comments;
    if (!first) return null;

    if (!open) {
        return (
            <button
                type="button"
                className={cn(CARD_CLASS, 'flex items-center gap-1.5 px-3 py-1.5 text-start text-xs text-muted-foreground hover:text-foreground')}
                style={style}
                aria-expanded={false}
                onClick={() => setOpen(true)}
            >
                <Icon name="check" className="size-3.5 shrink-0 text-[var(--status-success)]" />
                <span className="shrink-0">{t('review.card.resolved')}</span>
                <span className="min-w-0 flex-1 truncate">{first.author?.login ?? '—'}: {first.body}</span>
                {replies.length > 0 ? <span className="shrink-0">{t(replies.length === 1 ? 'review.card.replies.one' : 'review.card.replies.other', { count: replies.length })}</span> : null}
                <Icon name="arrow-right-s" className="size-3.5 shrink-0 rtl:rotate-180" />
            </button>
        );
    }

    const sendReply = async () => {
        if (!text.trim() || busy) return;
        setBusy('reply');
        const sent = await review.reply(thread.id, text);
        setBusy(null);
        if (sent) {
            setText('');
            setReplying(false);
        }
    };
    const toggleResolved = async () => {
        if (busy) return;
        setBusy('resolve');
        await review.setResolved(thread.id, !thread.resolved);
        setBusy(null);
    };

    return (
        <div className={CARD_CLASS} style={style} data-comment-card="true">
            <div className="flex items-center gap-1.5 px-3 pt-2">
                <CommentByline person={first.author} createdAt={first.createdAt} now={now} />
            </div>
            <div className="px-3 pb-2 pt-1 text-sm leading-relaxed text-foreground">
                <ReviewCommentBody body={first.body} excerpt={excerpt} />
            </div>
            {replies.map((reply) => (
                <div key={reply.id} className="border-t border-[var(--interactive-border)] px-3 py-2">
                    <div className="flex items-center gap-1.5">
                        <CommentByline person={reply.author} createdAt={reply.createdAt} now={now} />
                    </div>
                    <div className="mt-1 ps-[1.375rem] text-sm leading-relaxed text-foreground">
                        <ReviewCommentBody body={reply.body} excerpt={excerpt} />
                    </div>
                </div>
            ))}
            {replying ? (
                <div className="flex flex-col gap-2 border-t border-[var(--interactive-border)] p-2">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (isIMECompositionEvent(event)) return;
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void sendReply();
                            } else if (event.key === 'Escape') {
                                event.stopPropagation();
                                setReplying(false);
                            }
                        }}
                        placeholder={t('references.picker.thread.replyPlaceholder')}
                        aria-label={t('references.picker.thread.replyPlaceholder')}
                        disabled={busy !== null}
                        rows={2}
                        autoFocus
                    />
                    <div className="flex items-center justify-end gap-2">
                        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => setReplying(false)}>{t('references.picker.thread.cancel')}</Button>
                        <Button size="xs" disabled={busy !== null || !text.trim()} onClick={() => void sendReply()}>
                            {busy === 'reply' ? <Spinner className="size-3.5" /> : null}
                            {t('references.picker.thread.reply')}
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-1 border-t border-[var(--interactive-border)] px-1.5 py-1">
                    {thread.canReply ? (
                        <button type="button" className="min-w-0 flex-1 truncate px-1.5 text-start text-sm text-muted-foreground hover:text-foreground" onClick={() => setReplying(true)}>
                            {t('references.picker.thread.replyPlaceholder')}
                        </button>
                    ) : <span className="flex-1" />}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button size="xs" variant="outline" onClick={() => review.attachThread(thread)}>
                                <Icon name="attachment-2" className="size-3.5" />
                                {t('review.action.attach')}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('contextTooltips.diff.attachThread')}</TooltipContent>
                    </Tooltip>
                    {thread.canResolve ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex">
                                    <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void toggleResolved()}>
                                        {busy === 'resolve'
                                            ? <Spinner className="size-3.5" />
                                            : <Icon name={thread.resolved ? 'arrow-go-back' : 'check'} className="size-3.5" />}
                                        {t(thread.resolved ? 'references.picker.thread.unresolve' : 'references.picker.thread.resolve')}
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>
                                {t(thread.resolved ? 'contextTooltips.diff.unresolveThread' : 'contextTooltips.diff.resolveThread')}
                            </TooltipContent>
                        </Tooltip>
                    ) : null}
                </div>
            )}
        </div>
    );
};
