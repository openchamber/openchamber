import { processFile } from '@pierre/diffs';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { WalkthroughSource } from '@/lib/walkthrough/types';

export type PullRequestSource = Extract<WalkthroughSource, { kind: 'pr' }>;

/** Keep each file's original patch bytes, including binary and metadata-only changes. */
export function parsePullRequestDiff(patch: string) {
  if (!patch.trim()) return [];
  if (!patch.startsWith('diff --git ')) throw new Error('Invalid pull request diff');
  return patch.split(/(?=^diff --git )/m).filter(Boolean).map((filePatch) => {
    const file = processFile(filePatch);
    if (!file) throw new Error('Invalid pull request file diff');
    return {
      path: file.name,
      previousPath: file.prevName,
      status: /^new file mode /m.test(filePatch) ? 'A'
        : /^deleted file mode /m.test(filePatch) ? 'D'
        : /^rename from /m.test(filePatch) ? 'R'
        : /^copy from /m.test(filePatch) ? 'C' : 'M',
      insertions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      patch: filePatch,
    };
  });
}

export async function fetchPullRequestDiff(directory: string, source: PullRequestSource) {
  const response = await runtimeFetch('/api/walkthrough/pr-diff', {
    query: { directory, source: JSON.stringify(source) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
    throw new Error(error.success ? error.data.error : `Failed to load pull request diff (${response.status})`);
  }
  if (!response.headers.get('content-type')?.includes('text/plain')) throw new Error('Pull request comparison is unavailable on this server');
  return parsePullRequestDiff(await response.text());
}
