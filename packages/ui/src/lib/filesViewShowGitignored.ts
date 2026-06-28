import React from 'react';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import { updateDesktopSettings } from '@/lib/persistence';

const SHOW_GITIGNORED_STORAGE_KEY = 'filesViewShowGitignored';
const SHOW_GITIGNORED_EVENT = 'files-view-show-gitignored-change';

const readStoredShowGitignored = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const stored = getSafeStorage().getItem(SHOW_GITIGNORED_STORAGE_KEY);
    return stored === 'true';
  } catch {
    return false;
  }
};

const notifyFilesViewShowGitignoredChanged = () => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(SHOW_GITIGNORED_EVENT));
};

export const setFilesViewShowGitignored = (
  value: boolean,
  options: { persist?: boolean } = {}
) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    getSafeStorage().setItem(SHOW_GITIGNORED_STORAGE_KEY, value ? 'true' : 'false');
    notifyFilesViewShowGitignoredChanged();
  } catch {
    // ignore storage errors
  }

  if (options.persist !== false) {
    void updateDesktopSettings({ filesViewShowGitignored: value });
  }
};

export const useFilesViewShowGitignored = (): boolean => {
  const [showGitignored, setShowGitignored] = React.useState(readStoredShowGitignored);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleChange = () => {
      setShowGitignored(readStoredShowGitignored());
    };

    window.addEventListener('storage', handleChange);
    window.addEventListener(SHOW_GITIGNORED_EVENT, handleChange);
    return () => {
      window.removeEventListener('storage', handleChange);
      window.removeEventListener(SHOW_GITIGNORED_EVENT, handleChange);
    };
  }, []);

  return showGitignored;
};
