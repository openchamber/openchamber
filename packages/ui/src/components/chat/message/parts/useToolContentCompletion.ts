import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { toolContentShellChars } from '@/lib/opencode/toolContentShells';
import { getSyncSessionDirectory } from '@/sync/sync-refs';
import { completeToolContent } from '@/sync/tool-content-completion';

type ToolContentCompletion =
  | { status: 'whole' }
  // `showProgress` turns true once the request is slow enough to be worth
  // saying so; a quick completion would only flash the message.
  | { status: 'loading'; showProgress: boolean }
  | { status: 'failed'; retry: () => void };

const PROGRESS_DELAY_MS = 500;

/**
 * Completes a call whose result arrived as a shell (`toolContentShells.ts`)
 * once its row needs the result. The store then holds the whole call, so the
 * part this row renders stops being a shell. A request that fails, or answers
 * without the message, is reported as `failed`, never as an empty result.
 */
export const useToolContentCompletion = (part: ToolPart, needed: boolean): ToolContentCompletion => {
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
    completeToolContent({ directory, sessionID }, messageID).then(
      // Resolving with the call still a shell means the message was not
      // completed (dropped meanwhile, or the server sent a shell again).
      () => { if (active) setFailedAttempt(attempt); },
      () => { if (active) setFailedAttempt(attempt); },
    );
    return () => {
      active = false;
      clearTimeout(slow);
    };
  }, [attempt, isShell, messageID, needed, sessionID]);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  if (!isShell) return { status: 'whole' };
  if (failedAttempt === attempt) return { status: 'failed', retry };
  return { status: 'loading', showProgress: slowAttempt === attempt };
};
