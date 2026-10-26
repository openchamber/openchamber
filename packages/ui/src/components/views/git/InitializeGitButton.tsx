import React from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore } from '@/stores/useGitStore';

import { canOfferGitInitialization } from './gitInitialization';

// OpenCode before 2.0.23 has no `vcs.init` route and answers an untagged 404.
const isMissingRoute = (error: OpencodeApiError): boolean => error.status === 404 && error.tag === undefined;

type InitializeGitButtonProps = {
  directory: string;
};

export const InitializeGitButton: React.FC<InitializeGitButtonProps> = ({ directory }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const recheckRepository = useGitStore((state) => state.recheckRepository);
  const [busy, setBusy] = React.useState(false);

  if (!canOfferGitInitialization(directory, homeDirectory)) return null;

  const initialize = async () => {
    setBusy(true);
    try {
      await opencodeClient.initializeGit(directory);
    } catch (error) {
      setBusy(false);
      // opencodeClient normalizes every failure into an OpencodeApiError.
      const failure = error instanceof OpencodeApiError ? error : null;
      if (failure && isMissingRoute(failure)) {
        toast.error(t('gitView.toast.initializeGitNeedsNewerOpenCode'));
        return;
      }
      toast.error(t('gitView.toast.initializeGitFailed'), { description: failure?.detail || undefined });
      return;
    }
    // On success this empty state unmounts as the Git surface takes over.
    const isRepository = await recheckRepository(directory, git);
    if (!isRepository) {
      setBusy(false);
      toast.error(t('gitView.toast.initializeGitNotDetected'));
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3 gap-1.5"
      disabled={busy}
      onClick={() => void initialize()}
    >
      {busy ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
      {t('gitView.empty.initializeGit')}
    </Button>
  );
};
