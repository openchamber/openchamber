import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { toolContentShellChars } from '@/lib/opencode/toolContentShells';
import { getSyncSessionDirectory } from '@/sync/sync-refs';
import { completeToolContent } from '@/sync/tool-content-completion';

type ToolContentCompletion =
  | { status: 'whole' }
  | { status: 'loading'; showProgress: boolean }
  | { status: 'failed'; retry: () => void };

const PROGRESS_DELAY_MS = 500;

export const useToolContentCompletion = (
  part: ToolPart,
  needed: boolean,
  storeDirectory?: string,
): ToolContentCompletion => {
  const isShell = toolContentShellChars(part) !== null;
  const [attempt, setAttempt] = React.useState(0);
  const [failedAttempt, setFailedAttempt] = React.useState<number | null>(null);
  const [slowAttempt, setSlowAttempt] = React.useState<number | null>(null);
  const { sessionID, messageID } = part;

  React.useEffect(() => {
    if (!needed || !isShell) return;
    let active = true;
    const directory = getSyncSessionDirectory(sessionID);
    if (!directory) {
      setFailedAttempt(attempt);
      return;
    }
    const slow = setTimeout(() => setSlowAttempt(attempt), PROGRESS_DELAY_MS);
    completeToolContent({ directory, storeDirectory, sessionID }, messageID).then(
      () => { if (active) setFailedAttempt(attempt); },
      () => { if (active) setFailedAttempt(attempt); },
    );
    return () => {
      active = false;
      clearTimeout(slow);
    };
  }, [attempt, isShell, messageID, needed, sessionID, storeDirectory]);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  if (!isShell) return { status: 'whole' };
  if (failedAttempt === attempt) return { status: 'failed', retry };
  return { status: 'loading', showProgress: slowAttempt === attempt };
};
