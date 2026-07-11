import React from 'react';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { updateDesktopSettings } from '@/lib/persistence';

const SHOW_HIDDEN_STORAGE_KEY = 'directoryTreeShowHidden';
const SHOW_HIDDEN_EVENT = 'directory-show-hidden-change';

const readStoredShowHidden = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }
  try {
    const stored = getDeferredSafeStorage().getItem(SHOW_HIDDEN_STORAGE_KEY);
    if (stored === null) {
      return true;
    }
    return stored === 'true';
  } catch {
    return true;
  }
};

const notifyDirectoryShowHiddenChanged = () => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new Event(SHOW_HIDDEN_EVENT));
};

export const setDirectoryShowHidden = (
  value: boolean,
  options: { persist?: boolean } = {}
) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    getDeferredSafeStorage().setItem(SHOW_HIDDEN_STORAGE_KEY, value ? 'true' : 'false');
    notifyDirectoryShowHiddenChanged();
  } catch {
    // ignore storage errors
  }

  if (options.persist !== false) {
    void updateDesktopSettings({ directoryShowHidden: value });
  }
};

export const useDirectoryShowHidden = (): boolean => {
  const [showHidden, setShowHidden] = React.useState(readStoredShowHidden);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleChange = () => {
      setShowHidden(readStoredShowHidden());
    };

    window.addEventListener('storage', handleChange);
    window.addEventListener(SHOW_HIDDEN_EVENT, handleChange);
    return () => {
      window.removeEventListener('storage', handleChange);
      window.removeEventListener(SHOW_HIDDEN_EVENT, handleChange);
    };
  }, []);

  return showHidden;
};
