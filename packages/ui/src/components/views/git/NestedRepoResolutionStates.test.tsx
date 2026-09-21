import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import { NestedRepoResolutionStates } from './NestedRepoResolutionStates';

const render = (props: React.ComponentProps<typeof NestedRepoResolutionStates>): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <NestedRepoResolutionStates {...props} />
    </I18nProvider>,
  );

const baseProps = {
  onRetryDiscovery: () => {},
};

describe('NestedRepoResolutionStates', () => {
  test('renders nothing while the root has not probed as a non-repository', () => {
    for (const rootIsGitRepo of [null, true] as const) {
      const markup = render({ ...baseProps, rootIsGitRepo, resolvedIsGitRepo: null, nestedRepos: undefined });
      expect(markup).toBe('');
    }
  });

  test('renders nothing once the operating directory resolved as a repository', () => {
    const markup = render({
      ...baseProps,
      rootIsGitRepo: false,
      resolvedIsGitRepo: true,
      nestedRepos: ['/root/one'],
    });
    expect(markup).toBe('');
  });

  test('shows the discovering state before discovery has run', () => {
    const markup = render({ ...baseProps, rootIsGitRepo: false, resolvedIsGitRepo: null, nestedRepos: undefined });
    expect(markup).toContain('Looking for Git repositories...');
  });

  test('shows the failure state with a retry when discovery failed', () => {
    const markup = render({ ...baseProps, rootIsGitRepo: false, resolvedIsGitRepo: null, nestedRepos: null });
    expect(markup).toContain('Could not scan for Git repositories');
    expect(markup).toContain('Retry');
  });

  test('shows the plain not-a-repository state with no retry when unsupported', () => {
    const markup = render({ ...baseProps, rootIsGitRepo: false, resolvedIsGitRepo: null, nestedRepos: 'unsupported' });
    expect(markup).toContain('This directory is not a Git repository');
    expect(markup).not.toContain('Retry');
  });

  test('treats an empty discovery like the not-a-repository state', () => {
    const markup = render({ ...baseProps, rootIsGitRepo: false, resolvedIsGitRepo: null, nestedRepos: [] });
    expect(markup).toContain('This directory is not a Git repository');
  });

  test('holds a checking state while repositories are found but unresolved', () => {
    const markup = render({
      ...baseProps,
      rootIsGitRepo: false,
      resolvedIsGitRepo: null,
      nestedRepos: ['/root/one', '/root/two'],
    });
    expect(markup).toContain('Checking repository...');
  });
});
