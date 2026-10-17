import React from 'react';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
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

// The server refuses a `git init` that would hide nested repositories, or that
// could not check for them, until the request carries the confirmation header.
const isConfirmationRequired = (error: OpencodeApiError | null): boolean =>
  error?.tag === 'VcsInitConfirmationRequiredError';

type InitializeGitButtonProps = {
  directory: string;
};

export const InitializeGitButton: React.FC<InitializeGitButtonProps> = ({ directory }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const recheckRepository = useGitStore((state) => state.recheckRepository);
  const [busy, setBusy] = React.useState(false);
  const { confirm, dialog } = useConfirmDialog();

  if (!canOfferGitInitialization(directory, homeDirectory)) return null;

  const askToInitializeAnyway = () => confirm({
    title: t('gitView.initializeGit.confirmTitle'),
    message: t('gitView.initializeGit.confirmDescription'),
    action: t('gitView.initializeGit.confirmAction'),
  });

  const initialize = async (confirmShadowing: boolean) => {
    setBusy(true);
    try {
      await opencodeClient.initializeGit(directory, confirmShadowing ? { confirmShadowing: true } : undefined);
    } catch (error) {
      setBusy(false);
      // opencodeClient normalizes every failure into an OpencodeApiError.
      const failure = error instanceof OpencodeApiError ? error : null;
      if (failure && isMissingRoute(failure)) {
        toast.error(t('gitView.toast.initializeGitNeedsNewerOpenCode'));
        return;
      }
      // The server refuses once so the client can ask; the retry carries the
      // confirmation and is never asked again. A declined confirmation is not
      // a failure, so it returns without a toast.
      if (!confirmShadowing && isConfirmationRequired(failure)) {
        if (await askToInitializeAnyway()) {
          await initialize(true);
        }
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

  // Discovery already knows this directory has nested repositories below it,
  // or could not check all of it: ask before the server has to refuse.
  const requestInitialize = async () => {
    const discovery = useGitStore.getState().nestedReposByRoot.get(directory);
    const knownToNeedConfirmation = discovery !== undefined && discovery !== null && discovery !== 'unsupported'
      && (discovery.repositories.length > 0 || !discovery.complete);
    if (knownToNeedConfirmation && !await askToInitializeAnyway()) return;
    await initialize(knownToNeedConfirmation);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 gap-1.5"
        disabled={busy}
        onClick={() => void requestInitialize()}
      >
        {busy ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
        {t('gitView.empty.initializeGit')}
      </Button>
      {dialog}
    </>
  );
};
