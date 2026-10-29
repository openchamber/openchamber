import React from 'react';

import { opencodeClient } from '@/lib/opencode/client';
import type { Part, ToolPart } from '@/lib/opencode/model';
import { toolContentShellChars } from '@/lib/opencode/toolContentShells';
import { getSyncSessionDirectory } from '@/sync/sync-refs';

type ToolContentCompletion =
  // `part` is the call this row renders: the stored one when it is whole, or
  // the one just read by id when the page left the result out.
  | { status: 'whole'; part: ToolPart }
  // `showProgress` turns true once the request is slow enough to be worth
  // saying so; a quick completion would only flash the message.
  | { status: 'loading'; showProgress: boolean }
  | { status: 'failed'; retry: () => void };

const PROGRESS_DELAY_MS = 500;

/** The call to render from a message read by id, matched by the part id. */
const resolveToolPart = (parts: Part[], part: ToolPart): ToolPart | null => {
  const match = parts.find((candidate) => candidate.type === 'tool' && candidate.id === part.id);
  return match ?? null;
};

/**
 * Completes a call whose result arrived as a shell (`toolContentShells.ts`)
 * once its row needs the result: the message is read by id, and the call that
 * comes back is rendered by this row. Nothing is written to the store — a
 * message the store no longer holds still shows its result, and a session page
 * never grows by the results a reader opened. Expand again to read again.
 * A request that fails, or answers without the whole call, is reported as
 * `failed`, never as an empty result.
 */
export const useToolContentCompletion = (part: ToolPart, needed: boolean): ToolContentCompletion => {
  const shelled = toolContentShellChars(part) !== null;
  const [attempt, setAttempt] = React.useState(0);
  const [resolved, setResolved] = React.useState<{ attempt: number; part: ToolPart } | null>(null);
  const [failedAttempt, setFailedAttempt] = React.useState<number | null>(null);
  const [slowAttempt, setSlowAttempt] = React.useState<number | null>(null);
  const { sessionID, messageID } = part;
  // The effect keys on ids, not the object: a row re-renders often while its
  // call streams, and a new object identity must not restart the read.
  const partRef = React.useRef(part);
  partRef.current = part;

  React.useEffect(() => {
    if (!needed || !shelled) return;
    let active = true;
    const directory = getSyncSessionDirectory(sessionID);
    if (!directory) {
      setFailedAttempt(attempt);
      return;
    }
    const slow = setTimeout(() => setSlowAttempt(attempt), PROGRESS_DELAY_MS);
    opencodeClient.getSessionMessage(sessionID, messageID, directory).then(
      (record) => {
        if (!active) return;
        const whole = resolveToolPart(record.parts, partRef.current);
        if (!whole || toolContentShellChars(whole) !== null) {
          setFailedAttempt(attempt);
          return;
        }
        setResolved({ attempt, part: whole });
      },
      () => {
        if (active) setFailedAttempt(attempt);
      },
    );
    return () => {
      active = false;
      clearTimeout(slow);
    };
  }, [attempt, messageID, needed, sessionID, shelled]);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  if (!shelled) return { status: 'whole', part };
  if (failedAttempt === attempt) return { status: 'failed', retry };
  if (resolved?.attempt === attempt) return { status: 'whole', part: resolved.part };
  return { status: 'loading', showProgress: slowAttempt === attempt };
};
