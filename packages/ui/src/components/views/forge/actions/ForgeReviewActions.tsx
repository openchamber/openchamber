import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider, ForgeReviewEvent } from '@/lib/forge/provider';
import { ForgeMentionTextarea } from './ForgeMentionTextarea';

interface ForgeReviewActionsProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  onReviewed?: () => void;
}

const EVENT_LABEL_KEYS: Record<ForgeReviewEvent, I18nKey> = {
  approve: 'forge.actions.approve',
  'request-changes': 'forge.actions.requestChanges',
  comment: 'forge.actions.reviewComment',
};

/**
 * Review submission controls for a pull request. Renders nothing unless the
 * provider exposes reviews (`capabilities.reviews !== 'none'`) and a
 * `submitReview` method. `approve-only` providers (GitLab) get a single direct
 * Approve button; `submit` providers (GitHub/Gitea) get Approve / Request
 * changes / Comment, each opening a small dialog with an optional body.
 */
export const ForgeReviewActions: React.FC<ForgeReviewActionsProps> = ({ provider, directory, ref, onReviewed }) => {
  const { t } = useI18n();
  const [pendingEvent, setPendingEvent] = useState<ForgeReviewEvent | null>(null);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submitReview = provider.submitReview;
  if (!submitReview || provider.capabilities.reviews === 'none') return null;

  const canRequestChanges = provider.capabilities.reviews === 'submit';

  const openDialog = (event: ForgeReviewEvent): void => {
    setBody('');
    setPendingEvent(event);
  };

  const submit = async (): Promise<void> => {
    if (!pendingEvent || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitReview(directory, ref, {
        event: pendingEvent,
        ...(body.trim() ? { body: body.trim() } : {}),
      });
      if (!result.ok) {
        toast.error(t('forge.actions.error'));
        return;
      }
      toast.success(t('forge.actions.reviewed'));
      setPendingEvent(null);
      setBody('');
      onReviewed?.();
    } finally {
      setSubmitting(false);
    }
  };

  const renderEventButton = (event: ForgeReviewEvent): React.ReactElement => (
    <Button variant="outline" size="sm" onClick={() => openDialog(event)} disabled={submitting}>
      {event === 'approve' ? <Icon name="checkbox-circle" className="size-4" /> : <Icon name="chat-1" className="size-4" />}
      {t(EVENT_LABEL_KEYS[event])}
    </Button>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {renderEventButton('approve')}
        {canRequestChanges ? (
          <>
            {renderEventButton('request-changes')}
            {renderEventButton('comment')}
          </>
        ) : null}
      </div>

      <Dialog
        open={pendingEvent !== null}
        onOpenChange={(open) => {
          if (!open) setPendingEvent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('forge.actions.reviewDialogTitle')}</DialogTitle>
          </DialogHeader>
          <ForgeMentionTextarea
            provider={provider}
            directory={directory}
            value={body}
            onChange={setBody}
            placeholder={t('forge.actions.reviewBodyPlaceholder')}
            disabled={submitting}
            ariaLabel={t('forge.actions.reviewBodyPlaceholder')}
            className="min-h-[96px]"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingEvent(null)} disabled={submitting}>
              {t('forge.actions.cancel')}
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={submitting}>
              {submitting ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="check" className="size-4" />
              )}
              {pendingEvent ? t(EVENT_LABEL_KEYS[pendingEvent]) : t('forge.actions.reviewDialogTitle')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
