import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider, ForgeWriteState } from '@/lib/forge/provider';
import type { ForgeEntityState } from '@/lib/forge/types';

interface ForgeStateActionsProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  state: ForgeEntityState;
  onChanged?: (state: ForgeEntityState) => void;
}

/**
 * Close/reopen control for an issue or pull request. Renders nothing when the
 * provider has no `updateEntity` method, or when the entity is merged (a
 * terminal, non-writable state). Closing asks for confirmation first.
 */
export const ForgeStateActions: React.FC<ForgeStateActionsProps> = ({ provider, directory, ref, state, onChanged }) => {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  const updateEntity = provider.updateEntity;
  if (!updateEntity || state === 'merged') return null;

  const isOpen = state === 'open';
  const nextState: ForgeWriteState = isOpen ? 'closed' : 'open';

  const run = async (): Promise<void> => {
    if (submitting) return;
    if (isOpen && !window.confirm(t('forge.actions.closeConfirm'))) return;
    setSubmitting(true);
    try {
      const result = await updateEntity(directory, ref, { state: nextState });
      if (!result.ok) {
        toast.error(t('forge.actions.error'));
        return;
      }
      toast.success(t('forge.actions.stateChanged'));
      onChanged?.(nextState);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void run()}
      disabled={submitting}
      aria-label={t(isOpen ? 'forge.actions.close' : 'forge.actions.reopen')}
    >
      {submitting ? (
        <Icon name="loader-4" className="size-4 animate-spin" />
      ) : (
        <Icon name={isOpen ? 'git-close-pull-request' : 'git-pull-request'} className="size-4" />
      )}
      {t(isOpen ? 'forge.actions.close' : 'forge.actions.reopen')}
    </Button>
  );
};
