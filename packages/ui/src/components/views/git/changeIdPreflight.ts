import React from 'react';

import type { GitLogEntry } from '@/lib/api/types';
import { getGitLog } from '@/lib/gitApi';

const CHANGE_ID_TRAILER = /^Change-Id:\s*I[0-9a-f]{40}$/;
const MAX_COMMITS = 50;

export const hasChangeIdTrailer = (body: string): boolean => {
  const paragraphs = body.replace(/\r\n/g, '\n').trim().split(/\n[ \t]*\n/);
  const trailers = paragraphs.at(-1) ?? '';
  return trailers.split('\n').some((line) => CHANGE_ID_TRAILER.test(line.trim()));
};

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
