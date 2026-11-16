import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { newMutationKey } from '@/components/sourceBoard/mutationKey';
import { toast } from '@/components/ui';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RepositoryReference } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

import { REFERENCE_META_TEXT, referenceNumberLabel } from './referencePickerItems';
import type { ConversationActionState } from './conversationActions';

const BUTTON_CLASS = 'inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none';

const ConversationLockButton: React.FC<{
  reference: RepositoryReference;
  context: SourceControlReadContext;
  locked: boolean;
  onRefresh?: () => Promise<void>;
}> = ({ reference, context, locked, onRefresh }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const descriptor = useSourceControlProvider(reference.provider);
  const [saving, setSaving] = React.useState(false);
  const label = locked ? t('sourceBoard.lock.unlock') : t('sourceBoard.lock.lock');
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    const payload = {
      ...context,
      idempotencyKey: newMutationKey(),
      target: { project: { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo }, number: reference.number },
      locked: !locked,
    };
    try {
      if (reference.kind === 'issue') await sourceControl.issueSetLock(payload);
      else await sourceControl.changeRequestSetLock(payload);
    } catch (error) {
      toast.error(t('sourceBoard.lock.failed', { reference: referenceNumberLabel(reference, descriptor) }), {
        description: error instanceof Error ? error.message : String(error),
      });
      setSaving(false);
      return;
    }
    if (onRefresh) await onRefresh().catch(() => undefined);
    setSaving(false);
  };
  return (
    <ButtonTooltip label={label} side="bottom">
      <button
        type="button"
        className={cn(BUTTON_CLASS, REFERENCE_META_TEXT)}
        aria-label={label}
        disabled={saving}
        onClick={() => void toggle()}
      >
        <Icon name={locked ? 'lock-unlock' : 'lock'} className="size-3.5" />
      </button>
    </ButtonTooltip>
  );
};

const ConversationSubscriptionButton: React.FC<{
  reference: RepositoryReference;
  context: SourceControlReadContext;
  subscribed: boolean;
  onRefresh?: () => Promise<void>;
}> = ({ reference, context, subscribed, onRefresh }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const descriptor = useSourceControlProvider(reference.provider);
  const [saving, setSaving] = React.useState(false);
  const label = subscribed ? t('sourceBoard.subscribe.unfollow') : t('sourceBoard.subscribe.follow');
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    const payload = {
      ...context,
      idempotencyKey: newMutationKey(),
      target: { project: { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo }, number: reference.number },
      subscribed: !subscribed,
    };
    try {
      if (reference.kind === 'issue') await sourceControl.issueSetSubscription(payload);
      else await sourceControl.changeRequestSetSubscription(payload);
    } catch (error) {
      toast.error(t('sourceBoard.subscribe.failed', { reference: referenceNumberLabel(reference, descriptor) }), {
        description: error instanceof Error ? error.message : String(error),
      });
      setSaving(false);
      return;
    }
    if (onRefresh) await onRefresh().catch(() => undefined);
    setSaving(false);
  };
  return (
    <ButtonTooltip label={label} side="bottom">
      <button
        type="button"
        className={cn(BUTTON_CLASS, REFERENCE_META_TEXT)}
        aria-label={label}
        disabled={saving}
        onClick={() => void toggle()}
      >
        <Icon name={subscribed ? 'check' : 'notification-3'} className={cn('size-3.5', subscribed && 'text-primary')} />
      </button>
    </ButtonTooltip>
  );
};

export const ReferenceConversationActions: React.FC<{
  reference: RepositoryReference;
  context: SourceControlReadContext;
  state: ConversationActionState;
  onRefresh?: () => Promise<void>;
  className?: string;
}> = ({ reference, context, state, onRefresh, className }) => {
  if (!state.showLock && !state.showSubscription) return null;
  return (
    <div className={cn('flex items-center', className)}>
      {state.showLock ? (
        <ConversationLockButton reference={reference} context={context} locked={state.locked} onRefresh={onRefresh} />
      ) : null}
      {state.showSubscription ? (
        <ConversationSubscriptionButton reference={reference} context={context} subscribed={state.subscribed} onRefresh={onRefresh} />
      ) : null}
    </div>
  );
};
