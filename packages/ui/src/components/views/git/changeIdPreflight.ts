import React from 'react';

import type { GitLogEntry } from '@/lib/api/types';
import { getGitLog } from '@/lib/gitApi';

const CHANGE_ID_TRAILER = /^Change-Id:\s*I[0-9a-f]{40}$/;
// A review host reads at most this many commits of a push; more is not ours to fix here.
const MAX_COMMITS = 50;

/** Whether a commit body ends with a trailer block that names a Change-Id; one in the body text does not count. */
export const hasChangeIdTrailer = (body: string): boolean => {
  const paragraphs = body.replace(/\r\n/g, '\n').trim().split(/\n[ \t]*\n/);
  const trailers = paragraphs.at(-1) ?? '';
  return trailers.split('\n').some((line) => CHANGE_ID_TRAILER.test(line.trim()));
};

/**
 * What a push for review would send, read before it is sent: the commits
 * between the target and HEAD, newest first, and which lack a Change-Id.
 * `missing: 'tip'` is the one case the panel can fix (amend the checked-out
 * commit); `many` covers any older commit without one, which only a rebase
 * can fix, so the push is held back.
 */
export type ChangeIdPreflight =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; commits: number; subject: string | null; tip: string | null; missing: 'none' | 'tip' | 'many'; missingCount: number };

export const classifyChangeIds = (entries: GitLogEntry[]): Extract<ChangeIdPreflight, { status: 'ready' }> => {
  const tip = entries[0] ?? null;
  const missing = entries.filter((entry) => !hasChangeIdTrailer(entry.body));
  return {
    status: 'ready',
    commits: entries.length,
    subject: tip?.message.trim() || null,
    tip: tip?.hash ?? null,
    missing: missing.length === 0 ? 'none' : missing.length === 1 && missing[0] === tip ? 'tip' : 'many',
    missingCount: missing.length,
  };
};

/**
 * Reads the commits a push for review of `branch` onto `base` (a remote ref
 * such as `origin/main`) would send. Read again when `revision` changes, such
 * as after an amend. Idle (`null`) while `enabled` is off.
 */
export function useChangeIdPreflight(directory: string, base: string, branch: string, enabled: boolean, revision: number): ChangeIdPreflight | null {
  const [state, setState] = React.useState<{ key: string; value: ChangeIdPreflight } | null>(null);
  const key = JSON.stringify([directory, base, branch, revision]);
  React.useEffect(() => {
    if (!enabled || !directory || !base || !branch) return;
    let cancelled = false;
    setState({ key, value: { status: 'loading' } });
    void getGitLog(directory, { from: base, to: branch, maxCount: MAX_COMMITS })
      .then((log) => { if (!cancelled) setState({ key, value: classifyChangeIds(log.all) }); })
      .catch(() => { if (!cancelled) setState({ key, value: { status: 'error' } }); });
    return () => { cancelled = true; };
  }, [base, branch, directory, enabled, key]);
  if (!enabled) return null;
  return state?.key === key ? state.value : { status: 'loading' };
}
