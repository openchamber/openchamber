import React from 'react';

import type { ToolPart, ToolState } from '@/lib/opencode/model';
import { toolContentShellChars } from '@/lib/opencode/toolContentShells';
import { getSyncSessionDirectory } from '@/sync/sync-refs';
import { completeToolContent } from '@/sync/tool-content-completion';

type ToolContentCompletion =
  | { status: 'whole'; state?: ToolState }
  // `showProgress` turns true once the request is slow enough to be worth
  // saying so; a quick completion would only flash the message.
  | { status: 'loading'; showProgress: boolean }
  | { status: 'failed'; retry: () => void };

const PROGRESS_DELAY_MS = 500;

/**
 * Completes a call whose result arrived as a shell (`toolContentShells.ts`)
 * once its row needs the result. When the store still holds the message, the
 * store is completed and the part this row renders stops being a shell. A
 * message the store no longer holds (revert, cache eviction) is rendered from
 * the read itself, without bringing it back. A request that fails, or answers
 * without the call, is reported as `failed`, never as an empty result.
 */
export const useToolContentCompletion = (part: ToolPart, needed: boolean): ToolContentCompletion => {
  const isShell = toolContentShellChars(part) !== null;
  const [attempt, setAttempt] = React.useState(0);
  const [failedAttempt, setFailedAttempt] = React.useState<number | null>(null);
  const [slowAttempt, setSlowAttempt] = React.useState<number | null>(null);
  const [fetched, setFetched] = React.useState<{ attempt: number; partID: string; state: ToolState } | null>(null);
  const { sessionID, messageID, id: partID } = part;

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
      (record) => {
        if (!active) return;
        const whole = record?.parts.find(
          (candidate): candidate is ToolPart => candidate.type === 'tool' && candidate.id === partID,
        );
        if (whole) {
          setFetched({ attempt, partID, state: whole.state });
          return;
        }
        setFailedAttempt(attempt);
      },
      () => { if (active) setFailedAttempt(attempt); },
    );
    return () => {
      active = false;
      clearTimeout(slow);
    };
  }, [attempt, isShell, messageID, needed, partID, sessionID]);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  if (!isShell) return { status: 'whole' };
  if (fetched && fetched.attempt === attempt && fetched.partID === partID) {
    return { status: 'whole', state: fetched.state };
  }
  if (failedAttempt === attempt) return { status: 'failed', retry };
  return { status: 'loading', showProgress: slowAttempt === attempt };
};
