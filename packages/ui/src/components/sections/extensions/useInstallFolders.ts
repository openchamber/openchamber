import React from 'react';

import { toast } from '@/components/ui';
import { withPendingFolder } from '@/lib/guests/folders';
import { useI18n } from '@/lib/i18n';

export const useInstallFolders = () => {
  const { t } = useI18n();
  const [folders, setFolders] = React.useState<string[]>([]);
  const [draft, setDraft] = React.useState('');
  const [storedOffered, setStoredOffered] = React.useState(false);
  const [inherited, setInherited] = React.useState<string[] | null>(null);
  return {
    field: { folders, draft, onChange: setFolders, onDraftChange: setDraft },
    reset: () => {
      setFolders([]);
      setDraft('');
      setStoredOffered(false);
      setInherited(null);
    },
    offerStored: (stored: readonly string[] | undefined) => {
      if (!storedOffered && folders.length === 0 && !draft.trim() && stored?.length) {
        const next = [...stored];
        setFolders(next);
        setInherited(next);
      }
      setStoredOffered(true);
    },
    dropStored: () => {
      if (inherited && folders === inherited) setFolders([]);
      setInherited(null);
      setStoredOffered(false);
    },
    forRequest: (): string[] | null => {
      const next = withPendingFolder(folders, draft);
      if (!next) toast.error(t('settings.extensions.folders.toast.invalid'));
      return next;
    },
  };
};
