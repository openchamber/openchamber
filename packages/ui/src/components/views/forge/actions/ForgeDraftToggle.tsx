import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider } from '@/lib/forge/provider';

interface ForgeDraftToggleProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  draft: boolean;
  onChanged?: (draft: boolean) => void;
}

/**
 * Draft <-> ready toggle for a pull request. Renders nothing unless the
 * provider supports drafts (`capabilities.draft`) and implements
 * `toggleDraft`. Marks the PR ready when it is a draft, and back to draft
 * otherwise.
 */
export const ForgeDraftToggle: React.FC<ForgeDraftToggleProps> = ({ provider, directory, ref, draft, onChanged }) => {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  const toggleDraft = provider.toggleDraft;
  if (!toggleDraft || !provider.capabilities.draft) return null;

  const nextDraft = !draft;

  const run = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await toggleDraft(directory, ref, nextDraft);
      if (!result.ok) {
        toast.error(t('forge.actions.error'));
        return;
      }
      toast.success(t('forge.actions.draftChanged'));
      onChanged?.(nextDraft);
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
      aria-label={t(draft ? 'forge.actions.markReady' : 'forge.actions.markDraft')}
    >
      {submitting ? (
        <Icon name="loader-4" className="size-4 animate-spin" />
      ) : (
        <Icon name={draft ? 'checkbox-circle' : 'git-pr-draft'} className="size-4" />
      )}
      {t(draft ? 'forge.actions.markReady' : 'forge.actions.markDraft')}
    </Button>
  );
};
