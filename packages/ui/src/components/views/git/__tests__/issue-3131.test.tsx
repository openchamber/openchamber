import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { create } from 'zustand';
import type { GitHubPullRequestStatus, RuntimeAPIs } from '@/lib/api/types';

// Issue 3131: the PR merge flow used to pre-select `squash` without any user
// choice, so the merge button next to the method selector merged on a single
// click. The fix makes the method start unselected (`undefined`, never
// `squash`) and adds a defensive guard in mergePr so an accidental click
// without a chosen method does nothing. These tests pin that behavior.

const DIRECTORY = '/tmp/repro-repo';
const BRANCH = 'feature-branch';

// The PR status store is mocked so the seeded mergeable PR is visible to the
// server render. renderToString reads zustand's initial state snapshot, which
// the real persisted store can never reflect after seeding; the mock shares
// the entry map by reference so the snapshot sees the seeded entries. See the
// issue-2039 reproduction for the same technique.
type MockPrStatusEntry = {
  status: GitHubPullRequestStatus | null;
  isLoading: boolean;
  error: string | null;
  isInitialStatusResolved: boolean;
  lastRefreshAt: number;
  lastDiscoveryPollAt: number;
  watchers: number;
  params: null;
  identity: null;
  resolvedRemoteName: string | null;
  paramsRevision: number;
};

const mockEntryState: Record<string, MockPrStatusEntry> = {};

mock.module('@/stores/useGitHubPrStatusStore', () => {
  const createEntry = (): MockPrStatusEntry => ({
    status: null,
    isLoading: false,
    error: null,
    isInitialStatusResolved: false,
    lastRefreshAt: 0,
    lastDiscoveryPollAt: 0,
    watchers: 0,
    params: null,
    identity: null,
    resolvedRemoteName: null,
    paramsRevision: 0,
  });

  const useGitHubPrStatusStore = create<{
    entries: Record<string, MockPrStatusEntry>;
    ensureEntry: (key: string) => void;
    updateStatus: (key: string, updater: (prev: GitHubPullRequestStatus | null) => GitHubPullRequestStatus | null) => void;
    resetForRuntimeSwitch: () => void;
  }>()(() => ({
    entries: mockEntryState,
    ensureEntry: (key) => {
      if (!mockEntryState[key]) {
        mockEntryState[key] = createEntry();
      }
    },
    updateStatus: (key, updater) => {
      const current = mockEntryState[key] ?? createEntry();
      mockEntryState[key] = { ...current, status: updater(current.status) };
    },
    resetForRuntimeSwitch: () => {
      for (const key of Object.keys(mockEntryState)) {
        mockEntryState[key] = { ...mockEntryState[key], watchers: 0, isLoading: false, params: null };
      }
    },
  }));

  return {
    getGitHubPrStatusKey: (directory: string, branch: string, remoteName?: string | null): string =>
      JSON.stringify(['url:default', directory, branch, remoteName ?? 'auto']),
    useGitHubPrStatusStore,
  };
});

const { PullRequestSection } = await import('../PullRequestSection');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { getGitHubPrStatusKey, useGitHubPrStatusStore } = await import('@/stores/useGitHubPrStatusStore');

// Stub RuntimeAPIs. The component only calls github.* and the other APIs from
// effects and callbacks, which never run under renderToString, so the stubs
// are never invoked here.
// SAFETY: every property access on the stub returns a resolving async function,
// so the invariant the test relies on is that renderToString never reaches any
// API method; if it did, the call would still resolve instead of throwing.
const createApiStub = <T,>(): T => new Proxy({}, { get: () => async () => undefined }) as T;

const stubApis: RuntimeAPIs = {
  runtime: { platform: 'desktop', isDesktop: true, isVSCode: false },
  terminal: createApiStub(),
  git: createApiStub(),
  files: createApiStub(),
  settings: createApiStub(),
  permissions: createApiStub(),
  notifications: createApiStub(),
  github: createApiStub(),
  tools: createApiStub(),
};

const mergeableStatus = (): GitHubPullRequestStatus => ({
  connected: true,
  canMerge: true,
  repo: { owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets' },
  branch: BRANCH,
  defaultBranch: 'main',
  resolvedRemoteName: 'origin',
  pr: {
    number: 42,
    title: 'Add the frobnicator',
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'open',
    draft: false,
    base: 'main',
    head: BRANCH,
    mergeable: true,
    mergeableState: 'clean',
  },
});

const seedMergeableStatus = () => {
  const key = getGitHubPrStatusKey(DIRECTORY, BRANCH, null);
  const store = useGitHubPrStatusStore.getState();
  store.ensureEntry(key);
  store.updateStatus(key, () => mergeableStatus());
};

const renderPanel = () =>
  renderToString(
    <I18nProvider>
      <RuntimeAPIProvider apis={stubApis}>
        <PullRequestSection directory={DIRECTORY} branch={BRANCH} baseBranch="main" />
      </RuntimeAPIProvider>
    </I18nProvider>
  );

const uiSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const pullRequestSectionSource = readFileSync(
  path.join(uiSrc, 'components/views/git/PullRequestSection.tsx'),
  'utf8'
);
const webServerRoot = path.resolve(uiSrc, '../..');
const routesSource = readFileSync(
  path.join(webServerRoot, 'web/server/lib/github/routes.js'),
  'utf8'
);

describe('issue 3131 regression: PR merge requires an explicit method choice', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockEntryState)) {
      delete mockEntryState[key];
    }
  });

  test('opens the panel with no merge method pre-selected', () => {
    seedMergeableStatus();

    const html = renderPanel();

    // The method selector is not pre-filled with squash (or any other value)
    // before the user has touched anything.
    expect(html).not.toContain('value="squash"');
    expect(html).not.toContain('value="merge"');
    expect(html).not.toContain('value="rebase"');
  });

  test('traces the source: mergeMethod defaults to undefined, not squash', () => {
    expect(pullRequestSectionSource).toContain(
      "const [mergeMethod, setMergeMethod] = React.useState<MergeMethod | undefined>(undefined);"
    );
    expect(pullRequestSectionSource).not.toContain(
      "const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>('squash');"
    );
  });

  test('traces the source: mergePr refuses to merge without a chosen method', () => {
    // An accidental click with no method selected returns before any API call
    // and without any user-visible feedback.
    expect(pullRequestSectionSource).toContain('if (!mergeMethod) {');
  });

  test('traces the source: the client never sends squash without an explicit choice', () => {
    // The client no longer hard-codes squash. The server still falls back to
    // merge when the method is absent, but the UI now guarantees the method is
    // present whenever a merge request is sent.
    expect(routesSource).toContain(
      "const method = typeof req.body?.method === 'string' ? req.body.method : 'merge';"
    );
    expect(pullRequestSectionSource).toContain(
      'const result = await github.prMerge({ directory, number: pr.number, method: mergeMethod });'
    );
  });
});
