import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import { useEmojiShortcodes } from '@/lib/emoji/shortcodes';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';

import { MarkdownSuggestionContext } from '@/components/chat/markdown/markdownSuggestion';
import { useOpenChatLink } from '@/components/chat/useOpenChatLink';
import { ReferenceMarkdownRewriteContext } from './projectUploads';
import { ReferenceLinksContext } from './referenceLinks';
import { REFERENCE_META_TEXT, relativeTimeOf } from './referencePickerItems';
import type { ReferenceCommentItem, ReferenceCommentThread, ReferenceCommitGroup, ReferenceTimelineEntry } from './referenceTimeline';

/** Writes to a PR's review threads or a discussion's comments; each settles once the host answered. */
export type ReferenceThreadActions = {
    /** True when the reply was posted, so the box can empty. */
    reply: (threadId: string, body: string) => Promise<boolean>;
    /** True when the host has the change; the thread is read again after it. */
    setResolved: (threadId: string, resolved: boolean) => Promise<boolean>;
    /** A discussion's: choose the comment that opens the thread as its answer, or unchoose it. */
    setAnswer?: (threadId: string, answer: boolean) => Promise<boolean>;
};

// Text actions under a thread: a colour change on hover, no fill.
const THREAD_ACTION_CLASS = cn('h-6 px-1.5 hover:bg-transparent hover:text-foreground', REFERENCE_META_TEXT);

const Avatar: React.FC<{ comment: ReferenceCommentItem; className: string }> = ({ comment, className }) => {
    const { broken, onError } = useAvatarImage(comment.avatarUrl);
    return (
        <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-surface-elevated typography-micro text-muted-foreground', className)}>
            {comment.avatarUrl && !broken ? (
                <img src={comment.avatarUrl} alt="" className="size-full object-cover" loading="lazy" onError={onError} />
            ) : (
                <span>{(comment.author ?? '?').slice(0, 1).toUpperCase()}</span>
            )}
        </div>
    );
};

/** A comment's text; on a review line, its ```suggestion fences draw as diffs of that line. */
const CommentBody: React.FC<{ comment: ReferenceCommentItem }> = ({ comment }) => {
    const { body, location, excerpt } = comment;
    const rewrite = React.useContext(ReferenceMarkdownRewriteContext);
    const links = React.useContext(ReferenceLinksContext);
    const shown = React.useMemo(() => (rewrite ? rewrite(body) : body), [body, rewrite]);
    const emojiShortcodes = useEmojiShortcodes(shown);
    const suggestionBase = React.useMemo(() => (location ? { excerpt: excerpt ?? null } : null), [excerpt, location]);
    return shown.trim() ? (
        <MarkdownSuggestionContext.Provider value={suggestionBase}>
            <SimpleMarkdownRenderer
                content={shown}
                className="mt-1 [&_img]:h-auto [&_img]:max-w-full"
                enableFileReferences={false}
                allowRawHtml
                singleTilde
                repositoryLinks={links.repository}
                emojiShortcodes={emojiShortcodes}
                directory={links.directory}
            />
        </MarkdownSuggestionContext.Provider>
    ) : null;
};

/**
 * What follows a thread's first comment: its answers, and a way to answer or
 * resolve it. A resolved thread folds to one line until opened.
 */
const ThreadRest: React.FC<{
    comment: ReferenceCommentItem;
    thread: ReferenceCommentThread;
    now: number;
    actions?: ReferenceThreadActions;
    onAttachComment?: (comment: ReferenceCommentItem) => void;
}> = ({ comment, thread, now, actions, onAttachComment }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(!thread.resolved);
    const [replying, setReplying] = React.useState(false);
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState<'reply' | 'resolve' | 'answer' | null>(null);
    // Resolving folds the thread, reopening unfolds it, as the host shows it.
    const [shownResolved, setShownResolved] = React.useState(thread.resolved);
    if (shownResolved !== thread.resolved) {
        setShownResolved(thread.resolved);
        setOpen(!thread.resolved);
    }
    // After a change is written, the thread as it was read stays until the
    // preview reads it again; until then a second click would act on stale state.
    const [writtenOn, setWrittenOn] = React.useState<ReferenceCommentThread | null>(null);
    const settling = writtenOn === thread;

    const count = thread.replies.length;
    const summary = count === 0
        ? t('references.picker.thread.resolved')
        : count === 1 ? t('references.picker.thread.resolvedOneReply') : t('references.picker.thread.resolvedReplies', { count });

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn('mt-1 inline-flex items-center gap-1 typography-meta hover:text-foreground', REFERENCE_META_TEXT)}
                aria-expanded={false}
            >
                <Icon name="check" className="size-3.5 text-[var(--status-success)]" />
                {summary}
                <Icon name="arrow-right-s" className="size-3.5 opacity-70" />
            </button>
        );
    }

    const sendReply = async () => {
        const body = text.trim() ? text : null;
        if (!actions || !body || busy) return;
        setBusy('reply');
        try {
            if (await actions.reply(thread.id, body)) {
                setText('');
                setReplying(false);
            }
        } finally {
            setBusy(null);
        }
    };
    const toggleResolved = async () => {
        if (!actions || busy || settling) return;
        setBusy('resolve');
        try {
            if (await actions.setResolved(thread.id, !thread.resolved)) setWrittenOn(thread);
        } finally {
            setBusy(null);
        }
    };
    const answer = comment.answer;
    const setAnswer = actions?.setAnswer;
    const toggleAnswer = async () => {
        if (!setAnswer || !answer || busy || settling) return;
        setBusy('answer');
        try {
            if (await setAnswer(thread.id, !answer.chosen)) setWrittenOn(thread);
        } finally {
            setBusy(null);
        }
    };

    return (
        <>
            <CommentBody comment={comment} />
            {count > 0 ? (
                <ul className="mt-2 flex flex-col gap-3 border-s border-edge ps-3">
                    {thread.replies.map((reply) => (
                        <li key={reply.key} className="group/reply min-w-0">
                            <div className={cn('flex min-w-0 items-center gap-1.5 typography-meta', REFERENCE_META_TEXT)}>
                                <Avatar comment={reply} className="size-4" />
                                <span className="font-medium text-muted-foreground">{reply.author ?? '—'}</span>
                                {relativeLabel(t, reply.createdAt, now) ? <span>{relativeLabel(t, reply.createdAt, now)}</span> : null}
                                {onAttachComment ? (
                                    <button
                                        type="button"
                                        onClick={() => onAttachComment(reply)}
                                        className="ms-auto inline-flex items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/reply:opacity-100"
                                    >
                                        <Icon name="attachment-2" className="size-3.5" />
                                        {t('gitView.pr.actions.sendToAgent')}
                                    </button>
                                ) : null}
                            </div>
                            <CommentBody comment={reply} />
                        </li>
                    ))}
                </ul>
            ) : null}
            {replying ? (
                <div className="mt-2 flex flex-col gap-2">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (isIMECompositionEvent(event)) return;
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void sendReply();
                            } else if (event.key === 'Escape' && !text) {
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
                        <Button size="sm" variant="ghost" onClick={() => setReplying(false)} disabled={busy !== null}>
                            {t('references.picker.thread.cancel')}
                        </Button>
                        <Button size="sm" onClick={() => void sendReply()} disabled={busy !== null || !text.trim()}>
                            {busy === 'reply' ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                            {t('references.picker.thread.reply')}
                        </Button>
                    </div>
                </div>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-1 -ms-1.5">
                {actions && thread.canReply && !replying ? (
                    <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => setReplying(true)} disabled={busy !== null}>
                        <Icon name="chat-1" className="size-3.5" />
                        {t('references.picker.thread.reply')}
                    </Button>
                ) : null}
                {actions && thread.canResolve ? (
                    <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => void toggleResolved()} disabled={busy !== null || settling}>
                        {busy === 'resolve' || settling
                            ? <Icon name="loader-4" className="size-3.5 animate-spin" />
                            : <Icon name={thread.resolved ? 'arrow-go-back' : 'check'} className="size-3.5" />}
                        {t(thread.resolved ? 'references.picker.thread.unresolve' : 'references.picker.thread.resolve')}
                    </Button>
                ) : null}
                {setAnswer && answer?.canChange ? (
                    <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => void toggleAnswer()} disabled={busy !== null || settling}>
                        {busy === 'answer' || settling
                            ? <Icon name="loader-4" className="size-3.5 animate-spin" />
                            : <Icon name={answer.chosen ? 'arrow-go-back' : 'checkbox-circle'} className="size-3.5" />}
                        {t(answer.chosen ? 'references.picker.discussion.unmarkAnswer' : 'references.picker.discussion.markAnswer')}
                    </Button>
                ) : null}
                {thread.resolved ? (
                    <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => setOpen(false)}>
                        <Icon name="arrow-up-s" className="size-3.5" />
                        {t('references.picker.thread.collapse')}
                    </Button>
                ) : null}
            </div>
        </>
    );
};

const CommitAuthorAvatar: React.FC<{ name: string; avatarUrl: string }> = ({ name, avatarUrl }) => {
    const { broken, onError } = useAvatarImage(avatarUrl);
    return broken ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-surface-muted leading-none">{name.slice(0, 1).toUpperCase()}</span>
    ) : (
        <img src={avatarUrl} alt="" className="size-3.5 shrink-0 rounded-full" loading="lazy" onError={onError} />
    );
};

const relativeLabel = (t: ReturnType<typeof useI18n>['t'], iso: string | null, now: number) => {
    const relative = relativeTimeOf(iso, now);
    if (!relative) return null;
    return relative.key === 'common.relative.justNow' ? t(relative.key) : t(relative.key, { count: relative.count });
};

const CommitGroup: React.FC<{ group: ReferenceCommitGroup; now: number }> = ({ group, now }) => {
    const { t } = useI18n();
    const { directory } = React.useContext(ReferenceLinksContext);
    // A commit the folder's repository has opens in the Diff view; any other on its host.
    const openLink = useOpenChatLink(directory ?? '');
    const count = group.commits.length;
    return (
        <>
            <div className="absolute inset-s-0 top-0 flex size-6 items-center justify-center rounded-full border border-edge bg-surface-elevated text-muted-foreground">
                <Icon name="git-commit" className="size-3.5" />
            </div>
            <div className={cn('flex h-6 items-center typography-meta', REFERENCE_META_TEXT)}>
                {count === 1 ? t('references.picker.preview.commitsSingle') : t('references.picker.preview.commitsPlural', { count })}
            </div>
            <ul className="mt-0.5 flex flex-col gap-0.5">
                {group.commits.map((commit) => {
                    const when = relativeLabel(t, commit.committedAt, now);
                    const sha = commit.sha.slice(0, 7);
                    return (
                        <li key={commit.sha} className="flex min-w-0 items-baseline gap-2 typography-meta">
                            {commit.url ? (
                                <a
                                    href={commit.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn('shrink-0 font-mono typography-micro hover:text-foreground', REFERENCE_META_TEXT)}
                                    onClick={(event) => {
                                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !commit.url) return;
                                        event.preventDefault();
                                        openLink(commit.url);
                                    }}
                                >
                                    {sha}
                                </a>
                            ) : (
                                <span className={cn('shrink-0 font-mono typography-micro', REFERENCE_META_TEXT)}>{sha}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate text-foreground" title={commit.headline}>{commit.headline}</span>
                            {commit.author ? (
                                <span className={cn('inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 self-center typography-micro', REFERENCE_META_TEXT)}>
                                    {commit.avatarUrl ? (
                                        <CommitAuthorAvatar name={commit.author} avatarUrl={commit.avatarUrl} />
                                    ) : null}
                                    <span className="truncate">{commit.author}</span>
                                </span>
                            ) : null}
                            {when ? <span className={cn('shrink-0 typography-micro', REFERENCE_META_TEXT)}>{when}</span> : null}
                        </li>
                    );
                })}
            </ul>
        </>
    );
};

/**
 * The thread under a preview, drawn like the PR view's comments: avatar on a
 * line, then the comment. Bodies render images and the HTML GitHub allows.
 * A PR's commits sit on the same line, grouped between the comments.
 */
export const ReferenceComments: React.FC<{
    entries: ReferenceTimelineEntry[];
    now: number;
    /** Pins one comment above the composer; shown on hover beside its author. */
    onAttachComment?: (comment: ReferenceCommentItem) => void;
    /** Answer and resolve review threads; without it they are read only. */
    threadActions?: ReferenceThreadActions;
}> = ({ entries, now, onAttachComment, threadActions }) => {
    const { t } = useI18n();
    return (
        <div className="flex flex-col">
            {entries.map((entry, index) => {
                const isLast = index === entries.length - 1;
                return (
                    <div key={entry.key} className="group relative pb-4 ps-9 last:pb-0">
                        {!isLast ? <div className="absolute bottom-1 inset-s-3 top-8 w-px bg-edge" /> : null}
                        {entry.kind === 'commits' ? <CommitGroup group={entry} now={now} /> : (
                            <>
                                <Avatar comment={entry} className="absolute inset-s-0 top-0 size-6" />
                                <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 typography-meta', REFERENCE_META_TEXT)}>
                                    <span className="font-medium text-muted-foreground">{entry.author ?? '—'}</span>
                                    {relativeLabel(t, entry.createdAt, now) ? <span>{relativeLabel(t, entry.createdAt, now)}</span> : null}
                                    {entry.context ? <span className="min-w-0 truncate font-mono typography-micro">{entry.context}</span> : null}
                                    {entry.answer?.chosen ? (
                                        <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--status-success-background)] px-1.5 typography-micro font-medium text-[var(--status-success-text)]">
                                            <Icon name="checkbox-circle" className="size-3" />
                                            {t('references.picker.discussion.answerBadge')}
                                        </span>
                                    ) : null}
                                    {onAttachComment ? (
                                        <button
                                            type="button"
                                            onClick={() => onAttachComment(entry)}
                                            className="ms-auto inline-flex items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                        >
                                            <Icon name="attachment-2" className="size-3.5" />
                                            {t('gitView.pr.actions.sendToAgent')}
                                        </button>
                                    ) : null}
                                </div>
                                {entry.thread ? (
                                    <ThreadRest comment={entry} thread={entry.thread} now={now} actions={threadActions} onAttachComment={onAttachComment} />
                                ) : <CommentBody comment={entry} />}
                            </>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
