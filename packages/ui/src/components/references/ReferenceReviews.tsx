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
import { reviewDismissMode, reviewUndismiss } from '@/lib/source-control/reviewDismissal';
import { useSourceControlAuthEntry } from '@/stores/useSourceControlAuthStore';
import { MetaRow } from './ReferenceMetaEditors';
import { dismissibleReviews, type ReviewDismissMode } from './reviewDismissal';
import { ReviewerState } from './ReviewerChip';
import { mergeReviewerEntries, type ReviewerEntry } from './reviewerEntries';

export type ReviewActionsTarget = { context: SourceControlReadContext; onChanged: () => void };

const REVIEW_DECISION_KEYS = {
    approved: 'references.picker.preview.review.approved',
    changes_requested: 'references.picker.preview.review.changesRequested',
    review_required: 'references.picker.preview.review.required',
} as const;

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

export const ReviewerRows: React.FC<{
    entries: ReviewerEntry[];
    mode: ReviewDismissMode | null;
    canUndismiss: boolean;
    viewerLogin: string | null;
    target?: ReviewActionsTarget;
    reference: RepositoryReference;
    trailing?: React.ReactNode;
}> = ({ entries, mode, canUndismiss, viewerLogin, target, reference, trailing }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const canAct = target !== undefined && viewerLogin !== null;
    const dismissible = React.useMemo(() => {
        const byLogin = new Map<string, RepositoryReferenceReview>();
        if (!canAct) return byLogin;
        for (const review of dismissibleReviews(entries.flatMap((entry) => entry.reviews), mode, viewerLogin)) {
            const login = review.author?.login;
            if (login && !byLogin.has(login)) byLogin.set(login, review);
        }
        return byLogin;
    }, [canAct, entries, mode, viewerLogin]);
    const [dismissing, setDismissing] = React.useState<RepositoryReferenceReview | null>(null);
    const [busy, setBusy] = React.useState(false);

    const write = async (intent: { reviewId?: string; message?: string; dismissed?: boolean }, failure: I18nKey) => {
        if (!target || busy) return;
        setBusy(true);
        try {
            await sourceControl.changeRequestDismissReview({
                ...target.context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo }, number: reference.number },
                ...intent,
            });
            setDismissing(null);
            target.onChanged();
        } catch (error) {
            toast.error(t(failure), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {entries.map((entry) => {
                const dismissibleReview = dismissible.get(entry.person.login);
                const action = dismissibleReview?.state === entry.state ? dismissibleReview : undefined;
                const restoring = canAct && canUndismiss && entry.state === 'dismissed'
                    ? entry.reviews.find((review) => review.state === 'dismissed')
                    : undefined;
                return (
                    <span key={entry.key} className="inline-flex min-w-0 items-center gap-1">
                        <ReviewerState person={entry.person} state={entry.state} />
                        {action || restoring ? (
                            <DropdownMenu>
                                <HoverTooltip label={t('references.picker.preview.review.actions')}>
                                    <span className="inline-flex">
                                        <DropdownMenuTrigger asChild>
                                            <button type="button" aria-label={t('references.picker.preview.review.actions')} className={REVIEW_ACTIONS_CLASS}>
                                                <Icon name="more" className="size-3.5" />
                                            </button>
                                        </DropdownMenuTrigger>
                                    </span>
                                </HoverTooltip>
                                <DropdownMenuContent align="end" className="w-44">
                                    {action ? (
                                        <DropdownMenuItem
                                            disabled={busy}
                                            onSelect={() => {
                                                if (mode === 'own') void write({}, 'references.picker.preview.review.withdrawFailed');
                                                else setDismissing(action);
                                            }}
                                        >
                                            <Icon name="close-circle" className="me-1 size-3.5" />
                                            {t(mode === 'own' ? 'references.picker.preview.review.withdraw' : 'references.picker.preview.review.dismiss')}
                                        </DropdownMenuItem>
                                    ) : null}
                                    {restoring ? (
                                        <DropdownMenuItem
                                            disabled={busy}
                                            onSelect={() => void write({ reviewId: restoring.id, dismissed: false }, 'references.picker.preview.review.restoreFailed')}
                                        >
                                            <Icon name="refresh" className="me-1 size-3.5" />
                                            {t('references.picker.preview.review.restore')}
                                        </DropdownMenuItem>
                                    ) : null}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : null}
                    </span>
                );
            })}
            {trailing}
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
    pull: NonNullable<RepositoryReferenceDetail['pull']> | null;
    reference: RepositoryReference;
    reviewersControl?: React.ReactNode;
    actions?: ReviewActionsTarget;
}> = ({ pull, reference, reviewersControl, actions }) => {
    const { t } = useI18n();
    const descriptor = useSourceControlProvider(reference.provider);
    const target = actions && reference.linked !== true && pull?.canDismissReviews === true ? actions : undefined;
    const context = target?.context;
    const entry = useSourceControlAuthEntry(context ?? { provider: reference.provider, instance: '' });
    const viewerLogin = React.useMemo(() => {
        const status = entry?.status;
        if (!context || status?.status !== 'connected') return null;
        const account = status.accounts.find((item) => item.id === context.accountId) ?? status.accounts.find((item) => item.current);
        return account?.user.username ?? null;
    }, [context, entry]);
    const entries = React.useMemo(() => (pull ? mergeReviewerEntries(pull) : []), [pull]);
    const confirmedEmpty = pull !== null && entries.length === 0 && (pull.reviews?.length === 0 || pull.reviewerStates?.length === 0);

    return (
        <>
            {pull?.reviewDecision ? (
                <MetaRow label={t('references.picker.preview.review')}>{t(REVIEW_DECISION_KEYS[pull.reviewDecision])}</MetaRow>
            ) : null}
            {entries.length > 0 || reviewersControl ? (
                <MetaRow label={t('references.picker.preview.reviews')}>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        {confirmedEmpty ? (
                            <span className="text-muted-foreground">{t('sourceBoard.meta.none')}</span>
                        ) : null}
                        <ReviewerRows
                            entries={entries}
                            mode={reviewDismissMode(descriptor)}
                            canUndismiss={reviewUndismiss(descriptor)}
                            viewerLogin={viewerLogin}
                            target={target}
                            reference={reference}
                            trailing={reviewersControl}
                        />
                    </span>
                </MetaRow>
            ) : null}
        </>
    );
};
