import { Popover } from '@base-ui/react/popover';
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { reviewLabelsOf } from '@/lib/source-control/reviewLabels';
import type { ChangeRequestVoteLabel, ReviewVerdict, SourceControlProvider } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';
import { SourceBoardVotes } from '@/components/sourceBoard/SourceBoardVotes';

import { reviewDraftCount, type ChangeRequestReview } from './useChangeRequestReview';

/** The form that sends the review: its text and the verdict or votes it goes out with. */
export const ReviewSubmitForm: React.FC<{
    review: ChangeRequestReview;
    provider: SourceControlProvider;
    voteLabels?: ChangeRequestVoteLabel[];
    onDone: () => void;
}> = ({ review, provider, voteLabels, onDone }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const buttonClass = isMobile ? 'min-w-0 px-1.5' : undefined;
    const descriptor = useSourceControlProvider(provider);
    const confirmation = useConfirmDialog();
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState<ReviewVerdict | 'votes' | 'discard' | null>(null);
    const [votes, setVotes] = React.useState<Record<string, number>>({});
    const count = reviewDraftCount(review);
    const body = text.trim() ? text : undefined;
    const labels = reviewLabelsOf(descriptor, { voteLabels });
    // A host that refuses a verdict on your own change still takes your comments.
    const canJudge = !review.state?.viewerIsAuthor || descriptor.features.authorCanReview;

    const send = async (kind: ReviewVerdict | 'votes') => {
        if (busy) return;
        setBusy(kind);
        const sent = await review.submit(kind === 'votes' ? { votes, publishDrafts: true, body } : { verdict: kind, body });
        setBusy(null);
        if (sent) onDone();
    };
    const discard = async () => {
        if (busy) return;
        const confirmed = await confirmation.confirm({
            title: t('review.discard.title'),
            message: t(count === 1 ? 'review.discard.message.one' : 'review.discard.message.other', { count }),
            action: t('review.discard.action'),
            destructive: true,
        });
        if (!confirmed) return;
        setBusy('discard');
        const discarded = await review.discard();
        setBusy(null);
        if (discarded) onDone();
    };
    // With a draft the button names what it sends; without one it sends the text alone.
    const sendLabel = count > 1 ? t('review.submit.send.other', { count }) : t('review.submit.send.one');
    const busyIcon = (kind: typeof busy) => (busy === kind ? <Spinner className="size-3.5" /> : null);

    return (
        <div className="flex flex-col gap-2">
            <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('review.submit.placeholder')}
                aria-label={t('review.submit.placeholder')}
                disabled={busy !== null}
                rows={3}
                autoFocus
            />
            {labels.model === 'votes' && canJudge ? (
                <SourceBoardVotes labels={labels.labels} votes={votes} onChange={setVotes} disabled={busy !== null} />
            ) : null}
            {count > 0 ? (
                <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 typography-meta text-muted-foreground">{t(count === 1 ? 'review.submit.hint.one' : 'review.submit.hint.other')}</p>
                    {/* A phone has no room for four buttons in a row, so this rare one folds to its icon. */}
                    {isMobile ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex shrink-0">
                                    <Button size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground" disabled={busy !== null} aria-label={t('review.discard.button')} onClick={() => void discard()}>
                                        {busy === 'discard' ? <Spinner className="size-4" /> : <Icon name="delete-bin" className="size-4" />}
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('review.discard.button')}</TooltipContent>
                        </Tooltip>
                    ) : null}
                </div>
            ) : null}
            {review.readFailed ? <p className="typography-meta text-[var(--status-warning)]">{t('review.submit.readFailed')}</p> : null}
            {review.state?.truncated ? <p className="typography-meta text-muted-foreground">{t('review.submit.truncated')}</p> : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
                {count > 0 && !isMobile ? (
                    <Button size="sm" variant="ghost" className="me-auto text-muted-foreground" disabled={busy !== null} onClick={() => void discard()}>
                        {busyIcon('discard')}
                        {t('review.discard.button')}
                    </Button>
                ) : null}
                {labels.model === 'verdict' && canJudge ? (
                    <>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="inline-flex min-w-0">
                                    <Button size="sm" variant="outline" className={buttonClass} disabled={busy !== null || !body} onClick={() => void send('request-changes')}>
                                        {busyIcon('request-changes')}
                                        {t('sourceBoard.reply.requestChanges')}
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('sourceBoard.reply.requestChangesHint')}</TooltipContent>
                        </Tooltip>
                        <Button size="sm" variant="outline" className={buttonClass} disabled={busy !== null} onClick={() => void send('approve')}>
                            {busyIcon('approve')}
                            {t('sourceBoard.reply.approve')}
                        </Button>
                    </>
                ) : null}
                {labels.model === 'votes' ? (
                    <Button size="sm" disabled={busy !== null || (Object.keys(votes).length === 0 && !body && count === 0)} onClick={() => void send('votes')}>
                        {busyIcon('votes')}
                        {sendLabel}
                    </Button>
                ) : (
                    <Button size="sm" className={buttonClass} disabled={busy !== null || (!body && count === 0)} onClick={() => void send('comment')}>
                        {busyIcon('comment')}
                        {sendLabel}
                    </Button>
                )}
            </div>
            {confirmation.dialog}
        </div>
    );
};

/**
 * The review button of a change request's diff: shows how many comments wait
 * in the draft and opens the form that sends them. A popover beside the diff
 * on a desktop, a bottom panel on a phone.
 */
export const ReviewSubmitButton: React.FC<{
    review: ChangeRequestReview;
    provider: SourceControlProvider;
    voteLabels?: ChangeRequestVoteLabel[];
    className?: string;
    labelClassName?: string;
}> = ({ review, provider, voteLabels, className, labelClassName }) => {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const [open, setOpen] = React.useState(false);
    const count = reviewDraftCount(review);
    const label = count > 0 ? t('review.submit.buttonWithCount', { count }) : t('review.submit.button');
    const form = <ReviewSubmitForm review={review} provider={provider} voteLabels={voteLabels} onDone={() => setOpen(false)} />;
    const content = (
        <>
            <Icon name="search-eye" className="size-4" />
            {/* A narrow toolbar folds the label, never the count of comments waiting. */}
            <span className={cn('typography-ui-label', count === 0 && labelClassName)}>{label}</span>
        </>
    );

    if (isMobile) {
        return (
            <>
                <Button variant="outline" className={cn('flex-shrink-0', className)} aria-label={label} onClick={() => setOpen(true)}>
                    <Icon name="search-eye" className="size-4" />
                    {label}
                </Button>
                <MobileOverlayPanel open={open} onClose={() => setOpen(false)} title={t('review.submit.button')}>
                    <div className="p-3">{form}</div>
                </MobileOverlayPanel>
            </>
        );
    }
    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex flex-shrink-0">
                        <Popover.Trigger render={<Button size="sm" className={cn('h-7 flex-shrink-0 gap-1.5 px-2', className)} aria-label={label} />}>
                            {content}
                        </Popover.Trigger>
                    </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.diff.reviewSubmit')}</TooltipContent>
            </Tooltip>
            <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
                    <Popover.Popup aria-label={t('review.submit.button')} className={cn(dropdownMenuPopupClass, 'w-[34rem] max-w-[calc(100vw-2rem)] p-3')}>
                        {form}
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
};
