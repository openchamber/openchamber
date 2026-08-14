import React, { useCallback, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider } from '@/lib/forge/provider';
import type { ForgeEntityState, ForgeIssue, ForgePullRequest } from '@/lib/forge/types';
import { ForgeDraftToggle } from './ForgeDraftToggle';
import { ForgeEditForm } from './ForgeEditForm';
import { ForgeReviewActions } from './ForgeReviewActions';
import { ForgeStateActions } from './ForgeStateActions';

interface ForgeEntityActionsProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  pr?: ForgePullRequest | null;
  issue?: ForgeIssue | null;
  onChanged?: () => void;
}

/**
 * Header action bar for a forge issue or pull request: Edit (expands an inline
 * form), draft toggle + review actions (pulls only), and close/reopen. Each
 * affordance is capability- and method-gated; the bar renders nothing when no
 * write operation applies. Successes funnel through `onChanged` so the owning
 * view can refetch.
 */
export const ForgeEntityActions: React.FC<ForgeEntityActionsProps> = ({ provider, directory, ref, pr, issue, onChanged }) => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);

  const entity = pr ?? issue;
  const entityState: ForgeEntityState = entity?.state ?? 'open';
  const isPull = ref.kind === 'pull';

  const updateEntity = provider.updateEntity;
  const hasEdit = Boolean(updateEntity) && Boolean(entity);
  const hasDraft = isPull && provider.capabilities.draft && typeof provider.toggleDraft === 'function';
  const hasState = Boolean(updateEntity) && entityState !== 'merged';
  const hasReview = isPull && provider.capabilities.reviews !== 'none' && typeof provider.submitReview === 'function';

  const showOtherActions = !editing && (hasDraft || hasState || hasReview);

  const onSaved = useCallback(() => {
    setEditing(false);
    onChanged?.();
  }, [onChanged]);

  if (!hasEdit && !showOtherActions) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {hasEdit && !editing ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            aria-label={t('forge.actions.edit')}
          >
            <Icon name="edit" className="size-4" />
            {t('forge.actions.edit')}
          </Button>
        ) : null}

        {hasEdit && showOtherActions ? <div className="h-4 w-px shrink-0 bg-border/60" aria-hidden /> : null}

        {showOtherActions ? (
          <>
            {hasDraft && pr ? (
              <ForgeDraftToggle
                provider={provider}
                directory={directory}
                ref={ref}
                draft={pr.draft}
                onChanged={onChanged}
              />
            ) : null}
            {hasState ? (
              <ForgeStateActions
                provider={provider}
                directory={directory}
                ref={ref}
                state={entityState}
                onChanged={onChanged}
              />
            ) : null}
            {hasReview ? <ForgeReviewActions provider={provider} directory={directory} ref={ref} onReviewed={onChanged} /> : null}
          </>
        ) : null}
      </div>

      {editing && entity ? (
        <ForgeEditForm
          provider={provider}
          directory={directory}
          ref={ref}
          title={entity.title}
          body={entity.body}
          onSaved={onSaved}
          onCancel={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
};
