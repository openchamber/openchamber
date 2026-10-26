import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { reviewLabelsOf } from '@/lib/source-control/reviewLabels';
import type { ChangeRequestVoteLabel, ReviewChangeRequestInput, ReviewVerdict } from '@/lib/source-control/types';
import { newMutationKey } from './mutationKey';
import { SourceBoardVotes } from './SourceBoardVotes';

type Busy = 'comment' | 'thread' | 'vote' | ReviewVerdict | null;

/**
 * Below an issue's, discussion's or pull request's activity: write a comment, or on an
 * open pull request review it with the text as the review's body. A verdict
 * host approves or requests changes; a votes host votes on the labels the
 * change names (`SourceBoardVotes`), and only on its latest revision. The
 * text stays in the box until the host has it.
 */
export const SourceBoardReply: React.FC<{
    reference: RepositoryReference;
    context: SourceControlReadContext;
    /**
     * The item's feed and the list read again: after a write so it shows, and
     * after a refused review, which is most often a push since the preview
     * was read.
     */
    onRefresh: () => void;
    /** A votes host's labels, from the change's latest context; absent until it is read. */
    voteLabels?: ChangeRequestVoteLabel[];
    /** False while an older revision is shown: hosts take votes on the latest one only. */
    onLatestRevision?: boolean;
    /**
     * The latest revision's SHA, from the same context as `voteLabels`: the
     * votes go on it rather than on `reference`'s head, which a listed item
     * may have read before the latest upload.
     */
    latestRevision?: string;
}> = ({ reference, context, onRefresh, voteLabels, onLatestRevision = true, latestRevision }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState<Busy>(null);
    const [votes, setVotes] = React.useState<Record<string, number>>({});

    const descriptor = useSourceControlProvider(reference.provider);
    const review = reviewLabelsOf(descriptor, { voteLabels });
    const label = referenceNumberLabel(reference, descriptor);
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    const openPull = reference.kind === 'pull' && reference.state === 'open' ? reference : null;
    // Some hosts thread any change request comment (GitLab); others start a
    // thread only from a line in a review (GitHub).
    const canStartThread = reference.kind === 'pull' && descriptor.features.startThread;
    const body = text.trim() ? text : null;
    const shortcut = formatShortcutForDisplay('mod+enter');

    const comment = async () => {
        if (!body || busy) return;
        setBusy('comment');
        try {
            const payload = { ...context, idempotencyKey: newMutationKey(), target: { project, number: reference.number }, body };
            if (reference.kind === 'pull') await sourceControl.changeRequestComment(payload);
            else if (reference.kind === 'discussion') await sourceControl.discussionComment(payload);
            else await sourceControl.issueComment(payload);
            setText('');
            toast.success(t('sourceBoard.reply.toast.commented', { reference: label }));
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.reply.toast.commentFailed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(null);
        }
    };

    const startThread = async () => {
        if (!body || busy || !canStartThread) return;
        setBusy('thread');
        try {
            await sourceControl.changeRequestStartThread({ ...context, idempotencyKey: newMutationKey(), target: { project, number: reference.number }, body });
            setText('');
            toast.success(t('sourceBoard.reply.toast.threadStarted', { reference: label }));
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.reply.toast.commentFailed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(null);
        }
    };

    const sendVerdict = async (verdict: ReviewVerdict) => {
        const option = review.model === 'verdict' ? review.labels[0].options.find((entry) => entry.verdict === verdict) : null;
        if (!openPull || busy || !option || (option.requiresBody && !body)) return;
        setBusy(verdict);
        try {
            const input: ReviewChangeRequestInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                // The verdict is for the commit shown; a push since refuses it.
                target: { project, number: openPull.number, headSha: openPull.headSha },
                verdict,
            };
            if (body) input.body = body;
            const receipt = await sourceControl.changeRequestReview(input);
            const doneKey = verdict === 'approve' ? 'sourceBoard.reply.toast.approved' : 'sourceBoard.reply.toast.changesRequested';
            if (body && !receipt.result.commented) {
                // GitLab posts the verdict and its text separately: the verdict
                // stands, the text stays here to post again.
                toast.warning(t(doneKey, { reference: label }), { description: t('sourceBoard.reply.toast.textNotPosted') });
            } else {
                setText('');
                toast.success(t(doneKey, { reference: label }));
            }
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.reply.toast.reviewFailed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
            onRefresh();
        } finally {
            setBusy(null);
        }
    };

    const sendVotes = async () => {
        if (!openPull || busy || review.model !== 'votes' || Object.keys(votes).length === 0) return;
        setBusy('vote');
        try {
            const input: ReviewChangeRequestInput = {
                ...context,
                idempotencyKey: newMutationKey(),
                // Votes are for the revision shown, the latest; an upload since refuses them.
                target: { project, number: openPull.number, headSha: latestRevision ?? openPull.headSha },
                votes,
            };
            if (body) input.body = body;
            const receipt = await sourceControl.changeRequestReview(input);
            setVotes({});
            if (body && !receipt.result.commented) {
                toast.warning(t('sourceBoard.vote.toast.voted', { reference: label }), { description: t('sourceBoard.reply.toast.textNotPosted') });
            } else {
                setText('');
                toast.success(t('sourceBoard.vote.toast.voted', { reference: label }));
            }
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.vote.toast.failed', { reference: label }), { description: error instanceof Error ? error.message : String(error) });
            onRefresh();
        } finally {
            setBusy(null);
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void comment();
        }
    };

    const busyIcon = (kind: Busy) => (busy === kind ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null);

    return (
        <section className="flex flex-col gap-2 border-t border-border/60 pt-4" aria-label={t('sourceBoard.reply.label')}>
            <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('sourceBoard.reply.placeholder')}
                aria-label={t('sourceBoard.reply.label')}
                disabled={busy !== null}
                rows={3}
            />
            {openPull && review.model === 'votes' ? (
                onLatestRevision ? (
                    <SourceBoardVotes labels={review.labels} votes={votes} onChange={setVotes} disabled={busy !== null} />
                ) : (
                    <p className="typography-meta text-muted-foreground">{t('sourceBoard.vote.olderRevision')}</p>
                )
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
                {openPull && review.model === 'votes' && onLatestRevision && review.labels.some((entry) => entry.permitted.length > 0) ? (
                    <Button size="sm" variant="outline" onClick={() => void sendVotes()} disabled={busy !== null || Object.keys(votes).length === 0}>
                        {busyIcon('vote') ?? <Icon name="check" className="size-3.5" />}
                        {t('sourceBoard.vote.send')}
                    </Button>
                ) : null}
                {openPull && review.model === 'verdict' ? (
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void sendVerdict('request-changes')}
                            disabled={busy !== null || !body}
                            // Disabled buttons show no tooltip; the hint is for the enabled one too.
                            title={t('sourceBoard.reply.requestChangesHint')}
                        >
                            {busyIcon('request-changes') ?? <Icon name="file-edit" className="size-3.5" />}
                            {t('sourceBoard.reply.requestChanges')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void sendVerdict('approve')} disabled={busy !== null}>
                            {busyIcon('approve') ?? <Icon name="check" className="size-3.5" />}
                            {t('sourceBoard.reply.approve')}
                        </Button>
                    </>
                ) : null}
                {canStartThread ? (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void startThread()}
                        disabled={busy !== null || !body}
                        title={t('sourceBoard.reply.startThreadHint')}
                    >
                        {busyIcon('thread') ?? <Icon name="chat-thread" className="size-3.5" />}
                        {t('sourceBoard.reply.startThread')}
                    </Button>
                ) : null}
                <Button
                    size="sm"
                    onClick={() => void comment()}
                    disabled={busy !== null || !body}
                    title={t('sourceBoard.reply.commentShortcut', { shortcut })}
                >
                    {busyIcon('comment') ?? <Icon name="chat-1" className="size-3.5" />}
                    {t('sourceBoard.reply.comment')}
                </Button>
            </div>
        </section>
    );
};
