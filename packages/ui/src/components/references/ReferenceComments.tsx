import * as React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { Textarea } from '@/components/ui/textarea';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import { useEmojiShortcodes } from '@/lib/emoji/shortcodes';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { ReferenceMarkdownEditor } from './ReferenceMarkdownEditor';
import { cn } from '@/lib/utils';

import { MarkdownSuggestionContext } from '@/components/chat/markdown/markdownSuggestion';
import { useOpenChatLink } from '@/components/chat/useOpenChatLink';
import { ReferenceMarkdownRewriteContext } from './projectUploads';
import { ReferenceLinksContext } from './referenceLinks';
import { commentDraft, commentDraftKey, forgetCommentDraft, rememberCommentDraft } from './referenceCommentDrafts';
import { REFERENCE_META_TEXT, relativeTimeOf } from './referencePickerItems';
import type { ReferenceCommentItem, ReferenceCommentThread, ReferenceCommitGroup, ReferenceTimelineEntry } from './referenceTimeline';

export type ReferenceThreadActions = {
    reply: (threadId: string, body: string) => Promise<boolean>;
    setResolved: (threadId: string, resolved: boolean) => Promise<boolean>;
    setAnswer?: (threadId: string, answer: boolean) => Promise<boolean>;
};

export type ReferenceCommentActions = {
    update: (comment: ReferenceCommentItem, body: string) => Promise<void>;
    remove: (comment: ReferenceCommentItem) => Promise<void>;
};

export type ScopedCommentActions = ReferenceCommentActions & { draftScope: string };

const THREAD_ACTION_CLASS = cn('h-6 px-1.5 hover:bg-transparent hover:text-foreground', REFERENCE_META_TEXT);
const COMMENT_MENU_BUTTON_CLASS = 'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100';

const isConversationComment = (comment: ReferenceCommentItem): boolean => (
    comment.id !== undefined && !comment.location && !comment.context
);

const useCommentMenu = (comment: ReferenceCommentItem, actions: ScopedCommentActions | undefined, revealClass: string) => {
    const { t } = useI18n();
    const { confirm, dialog } = useConfirmDialog();
    const [editing, setEditing] = React.useState<{ key: string; text: string } | null>(null);
    const [busy, setBusy] = React.useState<'save' | 'delete' | null>(null);
    const writing = React.useRef(false);
    const trigger = React.useRef<HTMLButtonElement>(null);
    const draftKey = commentDraftKey(actions?.draftScope ?? '', comment.id);
    const draft = editing?.key === draftKey ? editing.text : null;
    const setDraft = (text: string | null) => setEditing(text === null ? null : { key: draftKey, text });
    const closeEditor = () => {
        forgetCommentDraft(draftKey);
        setDraft(null);
        requestAnimationFrame(() => trigger.current?.focus());
    };
    const conversation = actions !== undefined && isConversationComment(comment);
    const canUpdate = conversation && comment.canUpdate !== false;
    const canDelete = conversation && comment.canDelete !== false;
    const changed = draft !== null && draft.trim().length > 0 && draft !== comment.body;

    const save = async () => {
        if (!actions || !changed || draft === null || writing.current) return;
        writing.current = true;
        setBusy('save');
        try {
            await actions.update(comment, draft);
            forgetCommentDraft(draftKey);
            setDraft(null);
            requestAnimationFrame(() => trigger.current?.focus());
        } catch (error) {
            toast.error(t('sourceBoard.comment.saveFailed'), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            writing.current = false;
            setBusy(null);
        }
    };
    const remove = async () => {
        if (!actions || !canDelete || writing.current) return;
        const confirmed = await confirm({
            title: t('sourceBoard.comment.deleteTitle'),
            message: t('sourceBoard.comment.deleteMessage'),
            action: t('sourceBoard.comment.deleteAction'),
            destructive: true,
        });
        if (!confirmed) return;
        writing.current = true;
        setBusy('delete');
        try {
            await actions.remove(comment);
        } catch (error) {
            toast.error(t('sourceBoard.comment.deleteFailed'), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            writing.current = false;
            setBusy(null);
        }
    };
    const menu = canUpdate || canDelete ? (
        <DropdownMenu>
            <HoverTooltip label={t('sourceBoard.comment.actions')}>
                <span className="inline-flex">
                    <DropdownMenuTrigger asChild>
                        <button
                            ref={trigger}
                            type="button"
                            aria-label={t('sourceBoard.comment.actions')}
                            disabled={busy !== null}
                            className={cn(COMMENT_MENU_BUTTON_CLASS, revealClass)}
                        >
                            {busy === 'delete' ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="more" className="size-3.5" />}
                        </button>
                    </DropdownMenuTrigger>
                </span>
            </HoverTooltip>
            <DropdownMenuContent align="end" className="w-40">
                {canUpdate ? (
                    <DropdownMenuItem onSelect={() => setDraft(commentDraft(draftKey) ?? comment.body)}>
                        <Icon name="edit" className="me-1 size-3.5" />
                        {t('sourceBoard.comment.edit')}
                    </DropdownMenuItem>
                ) : null}
                {canDelete ? (
                    <DropdownMenuItem onSelect={() => void remove()}>
                        <Icon name="delete-bin" className="me-1 size-3.5" />
                        {t('sourceBoard.comment.delete')}
                    </DropdownMenuItem>
                ) : null}
            </DropdownMenuContent>
            {dialog}
        </DropdownMenu>
    ) : null;

    const editor = draft === null ? null : (
        <div className="mt-2 flex flex-col gap-2">
            <ReferenceMarkdownEditor
                value={draft}
                onChange={(text) => {
                    rememberCommentDraft(draftKey, text);
                    setDraft(text);
                }}
                onSubmit={() => void save()}
                onCancel={closeEditor}
                placeholder={t('sourceBoard.comment.edit')}
                disabled={busy !== null}
                autoFocus
                maxLines={4}
                aria-label={t('sourceBoard.comment.edit')}
            />
            <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={closeEditor} disabled={busy !== null}>
                    {t('sourceBoard.comment.cancel')}
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={!changed || busy !== null}>
                    {busy === 'save' ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                    {t('sourceBoard.comment.save')}
                </Button>
            </div>
        </div>
    );

    return { menu, editor };
};

const Avatar: React.FC<{ author: string | null; avatarUrl: string | null; className: string }> = ({ author, avatarUrl, className }) => {
    const { broken, onError } = useAvatarImage(avatarUrl);
    return (
        <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-surface-elevated typography-micro text-muted-foreground', className)}>
            {avatarUrl && !broken ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" loading="lazy" onError={onError} />
            ) : (
                <span>{(author ?? '?').slice(0, 1).toUpperCase()}</span>
            )}
        </div>
    );
};

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

const CommentRowActions: React.FC<{
    comment: ReferenceCommentItem;
    onAttachComment?: (comment: ReferenceCommentItem) => void;
    menu: React.ReactNode;
    revealClass: string;
}> = ({ comment, onAttachComment, menu, revealClass }) => {
    const { t } = useI18n();
    if (!onAttachComment && !menu) return null;
    return (
        <span className="ms-auto inline-flex items-center gap-1">
            {onAttachComment ? (
                <HoverTooltip label={t('contextTooltips.tracker.attachComment')}>
                    <span className="inline-flex">
                        <button
                            type="button"
                            onClick={() => onAttachComment(comment)}
                            className={cn('inline-flex items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100', revealClass)}
                        >
                            <Icon name="attachment-2" className="size-3.5" />
                            {t('gitView.pr.actions.sendToAgent')}
                        </button>
                    </span>
                </HoverTooltip>
            ) : null}
            {menu}
        </span>
    );
};

const ReplyEntry: React.FC<{
    reply: ReferenceCommentItem;
    now: number;
    onAttachComment?: (comment: ReferenceCommentItem) => void;
    commentActions?: ScopedCommentActions;
}> = ({ reply, now, onAttachComment, commentActions }) => {
    const { t } = useI18n();
    const { menu, editor } = useCommentMenu(reply, commentActions, 'group-hover/reply:opacity-100 pointer-coarse:opacity-100');
    const relative = relativeLabel(t, reply.createdAt, now);
    return (
        <li className="group/reply min-w-0">
            <div className={cn('flex min-w-0 items-center gap-1.5 typography-meta', REFERENCE_META_TEXT)}>
                <Avatar author={reply.author} avatarUrl={reply.avatarUrl} className="size-4" />
                <span className="font-medium text-muted-foreground">{reply.author ?? '—'}</span>
                {relative ? <span>{relative}</span> : null}
                <CommentRowActions comment={reply} onAttachComment={onAttachComment} menu={menu} revealClass="group-hover/reply:opacity-100 pointer-coarse:opacity-100" />
            </div>
            {editor ?? <CommentBody comment={reply} />}
        </li>
    );
};

const ThreadRest: React.FC<{
    comment: ReferenceCommentItem;
    thread: ReferenceCommentThread;
    now: number;
    body: React.ReactNode;
    editing: boolean;
    actions?: ReferenceThreadActions;
    onAttachComment?: (comment: ReferenceCommentItem) => void;
    commentActions?: ScopedCommentActions;
}> = ({ comment, thread, now, body, editing, actions, onAttachComment, commentActions }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(!thread.resolved);
    const [replying, setReplying] = React.useState(false);
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState<'reply' | 'resolve' | 'answer' | null>(null);
    const [shownResolved, setShownResolved] = React.useState(thread.resolved);
    if (shownResolved !== thread.resolved) {
        setShownResolved(thread.resolved);
        setOpen(!thread.resolved);
    }
    const [writtenOn, setWrittenOn] = React.useState<ReferenceCommentThread | null>(null);
    const settling = writtenOn === thread;

    const count = thread.replies.length;
    const summary = count === 0
        ? t('references.picker.thread.resolved')
        : count === 1 ? t('references.picker.thread.resolvedOneReply') : t('references.picker.thread.resolvedReplies', { count });

    if (!open) {
        if (editing) return <>{body}</>;
        return (
            <HoverTooltip label={t('contextTooltips.tracker.showThread')}>
                <span className="inline-flex">
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
                </span>
            </HoverTooltip>
        );
    }

    const sendReply = async () => {
        const replyBody = text.trim() ? text : null;
        if (!actions || !replyBody || busy) return;
        setBusy('reply');
        try {
            if (await actions.reply(thread.id, replyBody)) {
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
            {body}
            {count > 0 ? (
                <ul className="mt-2 flex flex-col gap-3 border-s border-edge ps-3">
                    {thread.replies.map((reply) => (
                        <ReplyEntry
                            key={reply.key}
                            reply={reply}
                            now={now}
                            onAttachComment={onAttachComment}
                            commentActions={commentActions}
                        />
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
                    <HoverTooltip label={t('contextTooltips.tracker.replyToThread')}>
                        <span className="inline-flex">
                            <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => setReplying(true)} disabled={busy !== null}>
                                <Icon name="chat-1" className="size-3.5" />
                                {t('references.picker.thread.reply')}
                            </Button>
                        </span>
                    </HoverTooltip>
                ) : null}
                {actions && thread.canResolve ? (
                    <HoverTooltip label={t(thread.resolved ? 'contextTooltips.tracker.reopenThread' : 'contextTooltips.tracker.resolveThread')}>
                        <span className="inline-flex">
                            <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => void toggleResolved()} disabled={busy !== null || settling}>
                                {busy === 'resolve' || settling
                                    ? <Icon name="loader-4" className="size-3.5 animate-spin" />
                                    : <Icon name={thread.resolved ? 'arrow-go-back' : 'check'} className="size-3.5" />}
                                {t(thread.resolved ? 'references.picker.thread.unresolve' : 'references.picker.thread.resolve')}
                            </Button>
                        </span>
                    </HoverTooltip>
                ) : null}
                {setAnswer && answer?.canChange ? (
                    <HoverTooltip label={t(answer.chosen ? 'contextTooltips.tracker.unmarkAnswer' : 'contextTooltips.tracker.markAnswer')}>
                        <span className="inline-flex">
                            <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => void toggleAnswer()} disabled={busy !== null || settling}>
                                {busy === 'answer' || settling
                                    ? <Icon name="loader-4" className="size-3.5 animate-spin" />
                                    : <Icon name={answer.chosen ? 'arrow-go-back' : 'checkbox-circle'} className="size-3.5" />}
                                {t(answer.chosen ? 'references.picker.discussion.unmarkAnswer' : 'references.picker.discussion.markAnswer')}
                            </Button>
                        </span>
                    </HoverTooltip>
                ) : null}
                {thread.resolved ? (
                    <HoverTooltip label={t('contextTooltips.tracker.hideThread')}>
                        <span className="inline-flex">
                            <Button size="xs" variant="ghost" className={THREAD_ACTION_CLASS} onClick={() => setOpen(false)}>
                                <Icon name="arrow-up-s" className="size-3.5" />
                                {t('references.picker.thread.collapse')}
                            </Button>
                        </span>
                    </HoverTooltip>
                ) : null}
            </div>
        </>
    );
};

const CommentEntry: React.FC<{
    comment: ReferenceCommentItem;
    now: number;
    onAttachComment?: (comment: ReferenceCommentItem) => void;
    threadActions?: ReferenceThreadActions;
    commentActions?: ScopedCommentActions;
}> = ({ comment, now, onAttachComment, threadActions, commentActions }) => {
    const { t } = useI18n();
    const { menu, editor } = useCommentMenu(comment, commentActions, 'group-hover:opacity-100');
    const relative = relativeLabel(t, comment.createdAt, now);
    return (
        <>
            <Avatar author={comment.author} avatarUrl={comment.avatarUrl} className="absolute inset-s-0 top-0 size-6" />
            <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 typography-meta', REFERENCE_META_TEXT)}>
                <span className="font-medium text-muted-foreground">{comment.author ?? '—'}</span>
                {relative ? <span>{relative}</span> : null}
                {comment.context ? <span className="min-w-0 truncate font-mono typography-micro">{comment.context}</span> : null}
                {comment.answer?.chosen ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--status-success-background)] px-1.5 typography-micro font-medium text-[var(--status-success-text)]">
                        <Icon name="checkbox-circle" className="size-3" />
                        {t('references.picker.discussion.answerBadge')}
                    </span>
                ) : null}
                <CommentRowActions comment={comment} onAttachComment={onAttachComment} menu={menu} revealClass="group-hover:opacity-100" />
            </div>
            {comment.thread ? (
                <ThreadRest
                    comment={comment}
                    thread={comment.thread}
                    now={now}
                    body={editor ?? <CommentBody comment={comment} />}
                    editing={editor !== null}
                    actions={threadActions}
                    onAttachComment={onAttachComment}
                    commentActions={commentActions}
                />
            ) : editor ?? <CommentBody comment={comment} />}
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
                            <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate text-foreground" title={commit.headline}>{commit.headline}</span>
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

export const ReferenceComments: React.FC<{
    entries: ReferenceTimelineEntry[];
    now: number;
    onAttachComment?: (comment: ReferenceCommentItem) => void;
    threadActions?: ReferenceThreadActions;
    commentActions?: ScopedCommentActions;
}> = ({ entries, now, onAttachComment, threadActions, commentActions }) => {
    return (
        <div className="flex flex-col">
            {entries.map((entry, index) => {
                const isLast = index === entries.length - 1;
                return (
                    <div key={entry.key} className="group relative pb-4 ps-9 last:pb-0">
                        {!isLast ? <div className="absolute bottom-1 inset-s-3 top-8 w-px bg-edge" /> : null}
                        {entry.kind === 'commits' ? <CommitGroup group={entry} now={now} /> : (
                            <CommentEntry
                                comment={entry}
                                now={now}
                                onAttachComment={onAttachComment}
                                threadActions={threadActions}
                                commentActions={commentActions}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
};
