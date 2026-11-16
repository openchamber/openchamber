import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';

type MissingFolder = { directory: string; from: 'probe' | 'send' };
type FolderProbe = (directory: string) => Promise<'available' | 'missing' | 'unknown'>;

const statFolder: FolderProbe = (directory) => opencodeClient.getDirectoryAvailability(directory);

export const useFolderMissing = (directory: string | undefined, probe: FolderProbe = statFolder) => {
  const [known, setKnown] = React.useState<MissingFolder | null>(null);
  const latestDirectory = React.useRef(directory);
  latestDirectory.current = directory;

  const recheck = React.useCallback(() => {
    if (!directory) return;
    void probe(directory).then((availability) => {
      if (availability === 'unknown' || latestDirectory.current !== directory) return;
      setKnown((current) => {
        if (availability === 'missing') return { directory, from: 'probe' };
        return current?.directory === directory ? null : current;
      });
    });
  }, [directory, probe]);

  React.useEffect(() => {
    recheck();
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [recheck]);

  const markMissing = React.useCallback(() => {
    if (directory) setKnown({ directory, from: 'send' });
  }, [directory]);

  const clearSendMark = React.useCallback(() => {
    setKnown((current) => (current?.from === 'send' ? null : current));
  }, []);

  const current = directory && known?.directory === directory ? known : null;
  return { tracked: Boolean(directory), missing: current !== null, confirmed: current?.from === 'probe', recheck, markMissing, clearSendMark };
};

export const useProjectFolderMissing = (directory: string | undefined): boolean => useFolderMissing(directory).missing;
