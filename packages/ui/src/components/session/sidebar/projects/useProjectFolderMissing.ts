import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';

/**
 * True only when the server confirms the project folder is gone (an unplugged
 * drive, a deleted checkout). A failed or unsupported probe stays false, so a
 * network hiccup never marks a project missing. Re-checked when the window
 * regains focus, which is when a drive usually comes back.
 */
export const useProjectFolderMissing = (directory: string | undefined): boolean => {
  const [missing, setMissing] = React.useState(false);

  React.useEffect(() => {
    if (!directory) {
      setMissing(false);
      return;
    }
    let current = true;
    const probe = () => {
      void opencodeClient.getDirectoryAvailability(directory).then((availability) => {
        if (current && availability !== 'unknown') setMissing(availability === 'missing');
      });
    };
    probe();
    window.addEventListener('focus', probe);
    return () => {
      current = false;
      window.removeEventListener('focus', probe);
    };
  }, [directory]);

  return missing;
};
