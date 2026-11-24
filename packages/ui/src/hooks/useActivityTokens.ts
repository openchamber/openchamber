import React from 'react';

import { bucketWindowKey } from '@/components/views/usage/usageStatsModel';
import {
  usageTokenKey,
  useUsageStatsStore,
  type UsageTokenBucket,
  type UsageTokenEntry,
} from '@/components/views/usage/usageStatsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

const EMPTY_TOKEN_ENTRY: UsageTokenEntry = { tokens: null, loading: false, error: null };

export function useActivityTokens(
  buckets: readonly UsageTokenBucket[],
  projectDirectory: string | null,
  enabled: boolean,
) {
  const loadTokens = useUsageStatsStore((store) => store.loadTokens);
  const tokenEntries = useUsageStatsStore((store) => store.tokenEntries);
  const tokenVersion = useUsageStatsStore((store) => store.tokenVersion);
  const byBucket = React.useMemo(() => {
    const runtime = getRuntimeKey();
    const entries = new Map<string, UsageTokenEntry>();
    for (const bucket of buckets) {
      entries.set(
        bucketWindowKey(bucket.from, bucket.to),
        tokenEntries[usageTokenKey(runtime, projectDirectory, bucket)] ?? EMPTY_TOKEN_ENTRY,
      );
    }
    return entries;
  }, [buckets, projectDirectory, tokenEntries]);

  React.useEffect(() => {
    if (!enabled) return;
    void loadTokens(buckets, projectDirectory);
  }, [buckets, enabled, loadTokens, projectDirectory, tokenVersion]);

  const values = [...byBucket.values()];
  const loaded = values.filter((entry) => entry.tokens !== null).length;
  const failed = values.filter((entry) => entry.error !== null).length;
  const loading = enabled && values.some((entry) => entry.loading || (entry.tokens === null && entry.error === null));
  const error = values.find((entry) => entry.error)?.error ?? null;
  const retry = React.useCallback(() => {
    const failedBuckets = buckets.filter((bucket) => byBucket.get(bucketWindowKey(bucket.from, bucket.to))?.error);
    void loadTokens(failedBuckets.length > 0 ? failedBuckets : buckets, projectDirectory, { force: true });
  }, [buckets, byBucket, loadTokens, projectDirectory]);

  return { entries: byBucket, loaded, failed, total: buckets.length, loading, error, retry };
}
