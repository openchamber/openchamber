import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { referenceNumberLabel } from '@/components/references/referencePickerItems';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubReference, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import type { ReviewChangeRequestInput, ReviewVerdict } from '@/lib/source-control/types';
import { newMutationKey } from './mutationKey';

type Busy = 'comment' | ReviewVerdict | null;

/**
 * Below an issue's or pull request's activity: write a comment, or on an
 * open pull request approve it or request changes with the text as the
 * review's body. The text stays in the box until the host has it.
 */
export const SourceBoardReply: React.FC<{
    reference: GitHubReference;
    context: SourceControlReadContext;
    /**
     * The item's feed and the list read again: after a write so it shows, and
     * after a refused review, which is most often a push since the preview
     * was read.
     */
    onRefresh: () => void;
}> = ({ reference, context, onRefresh }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState<Busy>(null);

    const label = referenceNumberLabel(reference);
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    const openPull = reference.kind === 'pull' && reference.state === 'open' ? reference : null;
    const body = text.trim() ? text : null;
    const shortcut = formatShortcutForDisplay('mod+enter');

    const comment = async () => {
        if (!body || busy) return;
        setBusy('comment');
        try {
            const payload = { ...context, idempotencyKey: newMutationKey(), target: { project, number: reference.number }, body };
            if (reference.kind === 'pull') await sourceControl.changeRequestComment(payload);
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

    const review = async (verdict: ReviewVerdict) => {
        if (!openPull || busy || (verdict === 'request-changes' && !body)) return;
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
            <div className="flex flex-wrap items-center justify-end gap-2">
                {openPull ? (
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void review('request-changes')}
                            disabled={busy !== null || !body}
                            // Disabled buttons show no tooltip; the hint is for the enabled one too.
                            title={t('sourceBoard.reply.requestChangesHint')}
                        >
                            {busyIcon('request-changes') ?? <Icon name="file-edit" className="size-3.5" />}
                            {t('sourceBoard.reply.requestChanges')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void review('approve')} disabled={busy !== null}>
                            {busyIcon('approve') ?? <Icon name="check" className="size-3.5" />}
                            {t('sourceBoard.reply.approve')}
                        </Button>
                    </>
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
