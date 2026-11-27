import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildDiffFileFingerprint,
  buildWalkthroughFileFingerprints,
  reviewedFilesScopeFromWalkthrough,
  reviewedFilesScopeKey,
} from '@/lib/reviewedFiles';
import { sessionEvents } from '@/lib/sessionEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WalkthroughHunk } from '@/lib/walkthrough/types';
import { useReviewedFilesStore } from './useReviewedFilesStore';

const makeHunk = (overrides: Partial<WalkthroughHunk> = {}): WalkthroughHunk => ({
  id: 'h1',
  path: 'src/app.ts',
  oldPath: null,
  status: 'modified',
  scope: 'all',
  header: '@@ -1,2 +1,2 @@',
  newStart: 1,
  added: 1,
  deleted: 1,
  patch: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n',
  ...overrides,
});

describe('useReviewedFilesStore', () => {
  beforeEach(() => {
    useReviewedFilesStore.setState({ scopes: {} });
  });

  test('produces identical scope keys for walkthrough and changes scopes', () => {
    const wtWorking = reviewedFilesScopeKey('rt', '/repo/', reviewedFilesScopeFromWalkthrough({ kind: 'working-tree', scope: 'working' }));
    const diffWorking = reviewedFilesScopeKey('rt', '/repo', { kind: 'working-tree', scope: 'working' });
    expect(wtWorking).toBe(diffWorking);

    const wtPr = reviewedFilesScopeKey('rt', '/repo', reviewedFilesScopeFromWalkthrough({
      kind: 'pr',
      number: 42,
      sourceRepo: { owner: 'acme', repo: 'app' },
      revision: 'sha-1',
    }));
    const wtPrUpdated = reviewedFilesScopeKey('rt', '/repo', reviewedFilesScopeFromWalkthrough({
      kind: 'pr',
      number: 42,
      sourceRepo: { owner: 'acme', repo: 'app' },
      revision: 'sha-2',
    }));
    const diffPr = reviewedFilesScopeKey('rt', '/repo', {
      kind: 'pr',
      number: 42,
      sourceRepo: { owner: 'acme', repo: 'app' },
    });
    expect(wtPr).toBe(diffPr);
    expect(wtPrUpdated).toBe(diffPr);
  });

  test('shares reviewed state across walkthrough and changes and invalidates when content changes', () => {
    const scopeKey = reviewedFilesScopeKey('rt', '/repo', { kind: 'working-tree', scope: 'working' });
    const wtFingerprints = buildWalkthroughFileFingerprints([makeHunk()]);
    const store = useReviewedFilesStore.getState();

    // Marked in Walkthrough
    store.markReviewed(scopeKey, 'src/app.ts', wtFingerprints.get('src/app.ts')!);

    // Opened in Changes (different fingerprint lane: meta + patchHash) -> stays reviewed and backfills
    const diffFp1 = buildDiffFileFingerprint(
      { path: 'src/app.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 1 },
      { patch: 'diff --git a/src/app.ts b/src/app.ts\n-old\n+new\n' },
    );
    const invalidated1 = store.reconcileScope(scopeKey, new Map([['src/app.ts', diffFp1]]));
    expect(invalidated1).toEqual([]);
    expect(useReviewedFilesStore.getState().scopes[scopeKey]?.files['src/app.ts']).toEqual({
      walkthroughHash: wtFingerprints.get('src/app.ts')!.walkthroughHash,
      meta: diffFp1.meta,
      patchHash: diffFp1.patchHash,
    });

    // File changes in Changes -> auto-unreviewed and returned in invalidated list
    const diffFp2 = buildDiffFileFingerprint(
      { path: 'src/app.ts', index: ' ', working_dir: 'M', insertions: 2, deletions: 1 },
      { patch: 'diff --git a/src/app.ts b/src/app.ts\n-old\n+new\n+more\n' },
    );
    const invalidated2 = store.reconcileScope(scopeKey, new Map([['src/app.ts', diffFp2]]));
    expect(invalidated2).toEqual(['src/app.ts']);
    expect(useReviewedFilesStore.getState().scopes[scopeKey]).toBeUndefined();
  });

  test('invalidates reviewed file when walkthrough hunk patch changes', () => {
    const scopeKey = reviewedFilesScopeKey('rt', '/repo', { kind: 'branch', baseRef: 'main', headRef: 'feat' });
    const fp1 = buildWalkthroughFileFingerprints([makeHunk()]);
    useReviewedFilesStore.getState().markReviewed(scopeKey, 'src/app.ts', fp1.get('src/app.ts')!);

    const fp2 = buildWalkthroughFileFingerprints([makeHunk({ patch: 'diff --git a/src/app.ts b/src/app.ts\n-old\n+changed\n' })]);
    const invalidated = useReviewedFilesStore.getState().reconcileScope(scopeKey, fp2);
    expect(invalidated).toEqual(['src/app.ts']);
    expect(useReviewedFilesStore.getState().scopes[scopeKey]).toBeUndefined();
  });

  test('prunes reviewed files that leave the scope when pruneMissing is set', () => {
    const scopeKey = reviewedFilesScopeKey('rt', '/repo', { kind: 'working-tree', scope: 'working' });
    const fpA = buildDiffFileFingerprint({ path: 'a.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0 });
    const fpB = buildDiffFileFingerprint({ path: 'b.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0 });
    useReviewedFilesStore.getState().markReviewed(scopeKey, 'a.ts', fpA);
    useReviewedFilesStore.getState().markReviewed(scopeKey, 'b.ts', fpB);

    const invalidated = useReviewedFilesStore.getState().reconcileScope(
      scopeKey,
      new Map([['b.ts', fpB]]),
      { pruneMissing: true },
    );
    expect(invalidated).toEqual([]);
    expect(Object.keys(useReviewedFilesStore.getState().scopes[scopeKey]?.files ?? {})).toEqual(['b.ts']);
  });

  test('targeted git refresh hint invalidates only matching working-tree paths', () => {
    const runtimeKey = getRuntimeKey();
    const workingKey = reviewedFilesScopeKey(runtimeKey, '/repo', { kind: 'working-tree', scope: 'working' });
    const branchKey = reviewedFilesScopeKey(runtimeKey, '/repo', { kind: 'branch', baseRef: 'main', headRef: 'feat' });
    const fp = buildDiffFileFingerprint({ path: 'src/a.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0 });

    useReviewedFilesStore.getState().markReviewed(workingKey, 'src/a.ts', fp);
    useReviewedFilesStore.getState().markReviewed(workingKey, 'src/b.ts', fp);
    useReviewedFilesStore.getState().markReviewed(branchKey, 'src/a.ts', fp);

    sessionEvents.requestGitRefresh({ directory: '/repo', paths: ['src/a.ts'] });

    expect(Object.keys(useReviewedFilesStore.getState().scopes[workingKey]?.files ?? {})).toEqual(['src/b.ts']);
    // Branch scope is unaffected by working-tree refresh hints
    expect(Object.keys(useReviewedFilesStore.getState().scopes[branchKey]?.files ?? {})).toEqual(['src/a.ts']);
  });

  test('unscoped git refresh hint does not clear reviewed files', () => {
    const runtimeKey = getRuntimeKey();
    const workingKey = reviewedFilesScopeKey(runtimeKey, '/repo', { kind: 'working-tree', scope: 'working' });
    const fp = buildDiffFileFingerprint({ path: 'src/a.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0 });
    useReviewedFilesStore.getState().markReviewed(workingKey, 'src/a.ts', fp);

    sessionEvents.requestGitRefresh({ directory: '/repo' });

    expect(Object.keys(useReviewedFilesStore.getState().scopes[workingKey]?.files ?? {})).toEqual(['src/a.ts']);
  });
});
