import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReference, RepositoryReferenceDetail, RepositoryReferenceReview, SourceControlReadContext } from '@/lib/api/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { reviewDismissMode, reviewUndismiss } from '@/lib/source-control/reviewThreads';
import { useSourceControlAuthEntry } from '@/stores/useSourceControlAuthStore';
import { MetaRow } from './ReferenceMetaRow';
import { ReferenceLinksContext } from './referenceLinks';
import { dismissibleReviews, type ReviewDismissMode } from './reviewDismissal';
import { useRepositoryReadContext } from './referenceSources';

const REVIEW_DECISION_KEYS = {
    approved: 'references.picker.preview.review.approved',
    changes_requested: 'references.picker.preview.review.changesRequested',
    review_required: 'references.picker.preview.review.required',
} as const;

const REVIEW_STATE_KEYS = {
    approved: 'references.picker.preview.review.approved',
    changes_requested: 'references.picker.preview.review.changesRequested',
    commented: 'references.picker.preview.review.commented',
    pending: 'references.picker.preview.review.pending',
    dismissed: 'references.picker.preview.review.dismissed',
} as const satisfies Record<RepositoryReferenceReview['state'], I18nKey>;

const REVIEW_ACTIONS_CLASS = 'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const DismissReviewDialog: React.FC<{
    review: RepositoryReferenceReview;
    busy: boolean;
    onCancel: () => void;
    onConfirm: (message: string) => void;
}> = ({ review, busy, onCancel, onConfirm }) => {
    const { t } = useI18n();
    const [message, setMessage] = React.useState('');
    const ready = message.trim().length > 0 && !busy;
    const submit = () => {
        if (ready) onConfirm(message.trim());
    };
    return (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('references.picker.preview.review.dismiss')}</DialogTitle>
                    <DialogDescription>{t('references.picker.preview.review.dismissMessage', { reviewer: review.author?.login ?? '' })}</DialogDescription>
                </DialogHeader>
                <Textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                        if (isIMECompositionEvent(event)) return;
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                    placeholder={t('references.picker.preview.review.dismissPlaceholder')}
                    aria-label={t('references.picker.preview.review.dismissPlaceholder')}
                    disabled={busy}
                    rows={3}
                    autoFocus
                />
                {message.trim() ? null : (
                    <p className="typography-micro text-muted-foreground">{t('references.picker.preview.review.dismissRequired')}</p>
                )}
                <DialogFooter>
                    <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>{t('dialog.common.actions.cancel')}</Button>
                    <Button size="sm" onClick={submit} disabled={!ready}>{t('references.picker.preview.review.dismiss')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export const ReviewRows: React.FC<{
    reviews: RepositoryReferenceReview[];
    mode: ReviewDismissMode | null;
    canUndismiss: boolean;
    viewerLogin: string | null;
    context: SourceControlReadContext | null;
    reference: RepositoryReference;
    onChanged?: () => void;
}> = ({ reviews, mode, canUndismiss, viewerLogin, context, reference, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const dismissible = React.useMemo(
        () => new Set(dismissibleReviews(reviews, mode, viewerLogin).map((review) => review.id)),
        [mode, reviews, viewerLogin],
    );
    const [dismissing, setDismissing] = React.useState<RepositoryReferenceReview | null>(null);
    const [busy, setBusy] = React.useState(false);

    const write = async (intent: { reviewId?: string; message?: string; dismissed?: boolean }, failure: I18nKey) => {
        if (!context || busy) return;
        setBusy(true);
        try {
            await sourceControl.changeRequestDismissReview({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo }, number: reference.number },
                ...intent,
            });
            setDismissing(null);
            onChanged?.();
        } catch (error) {
            toast.error(t(failure), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <ul className="flex flex-col gap-1">
                {reviews.map((review) => {
                    const canDismiss = dismissible.has(review.id);
                    const canRestore = canUndismiss && review.state === 'dismissed';
                    return (
                        <li key={review.id} className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 truncate text-foreground">{review.author?.login ?? '—'}</span>
                            <span className="min-w-0 truncate">{t(REVIEW_STATE_KEYS[review.state])}</span>
                            {canDismiss && mode === 'own' ? (
                                <Button size="xs" variant="ghost" className="-me-1.5 ms-auto" disabled={busy} onClick={() => void write({}, 'references.picker.preview.review.withdrawFailed')}>
                                    {t('references.picker.preview.review.withdraw')}
                                </Button>
                            ) : null}
                            {(canDismiss && mode === 'others') || canRestore ? (
                                <DropdownMenu>
                                    <HoverTooltip label={t('references.picker.preview.review.actions')}>
                                        <span className="ms-auto inline-flex">
                                            <DropdownMenuTrigger asChild>
                                                <button type="button" aria-label={t('references.picker.preview.review.actions')} className={REVIEW_ACTIONS_CLASS}>
                                                    <Icon name="more" className="size-3.5" />
                                                </button>
                                            </DropdownMenuTrigger>
                                        </span>
                                    </HoverTooltip>
                                    <DropdownMenuContent align="end" className="w-44">
                                        {canDismiss && mode === 'others' ? (
                                            <DropdownMenuItem onSelect={() => setDismissing(review)}>
                                                <Icon name="close-circle" className="me-1 size-3.5" />
                                                {t('references.picker.preview.review.dismiss')}
                                            </DropdownMenuItem>
                                        ) : null}
                                        {canRestore ? (
                                            <DropdownMenuItem
                                                disabled={busy}
                                                onSelect={() => void write({ reviewId: review.id, dismissed: false }, 'references.picker.preview.review.restoreFailed')}
                                            >
                                                <Icon name="refresh" className="me-1 size-3.5" />
                                                {t('references.picker.preview.review.restore')}
                                            </DropdownMenuItem>
                                        ) : null}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
            {dismissing ? (
                <DismissReviewDialog
                    review={dismissing}
                    busy={busy}
                    onCancel={() => setDismissing(null)}
                    onConfirm={(message) => void write({ reviewId: dismissing.id, message }, 'references.picker.preview.review.dismissFailed')}
                />
            ) : null}
        </>
    );
};

export const ReferenceReviews: React.FC<{
    pull: NonNullable<RepositoryReferenceDetail['pull']>;
    reference: RepositoryReference;
    onChanged?: () => void;
}> = ({ pull, reference, onChanged }) => {
    const { t } = useI18n();
    const directory = React.useContext(ReferenceLinksContext).directory;
    const readContext = useRepositoryReadContext(directory);
    const context = readContext && readContext !== 'missing' ? readContext : null;
    const descriptor = useSourceControlProvider(reference.provider);
    const entry = useSourceControlAuthEntry(context ?? { provider: reference.provider, instance: '' });
    const viewerLogin = React.useMemo(() => {
        const status = entry?.status;
        if (status?.status !== 'connected') return null;
        const account = status.accounts.find((item) => item.id === context?.accountId) ?? status.accounts.find((item) => item.current);
        return account?.user.username ?? null;
    }, [context?.accountId, entry]);
    const reviews = pull.reviews ?? [];

    return (
        <>
            {pull.reviewDecision ? (
                <MetaRow label={t('references.picker.preview.review')}>{t(REVIEW_DECISION_KEYS[pull.reviewDecision])}</MetaRow>
            ) : null}
            {reviews.length > 0 ? (
                <MetaRow label={t('references.picker.preview.reviews')}>
                    <ReviewRows
                        reviews={reviews}
                        mode={reviewDismissMode(descriptor)}
                        canUndismiss={reviewUndismiss(descriptor)}
                        viewerLogin={viewerLogin}
                        context={context}
                        reference={reference}
                        onChanged={onChanged}
                    />
                </MetaRow>
            ) : null}
        </>
    );
};
