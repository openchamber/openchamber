import { describe, expect, test } from 'bun:test';
import type { ChangeRequest, SourceControlReadContext } from '@/lib/api/types';
import { resolvePrWorktreeConfig } from './prWorktreeConfig';

const HEAD_SHA = '1111111111111111111111111111111111111111';
const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo_one',
  accountId: 'github.com#7', bindingRevision: 3, primaryRemote: 'origin',
};
const changeRequest = (overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  provider: 'github', instance: 'github.com', id: 'acme/app#42', number: 42,
  project: { provider: 'github', instance: 'github.com', id: 'acme/app', owner: 'acme', name: 'app', url: 'https://github.com/acme/app' },
  title: 'Fix the worktree flow', url: 'https://github.com/acme/app/pull/42', state: 'open',
  draft: false, base: 'main', head: 'feature/worktree', headSha: HEAD_SHA, ...overrides,
});

describe('PR worktree source request', () => {
  test('carries exact read authority without a client endpoint or classification', () => {
    const result = resolvePrWorktreeConfig(changeRequest({
      headProject: { provider: 'github', instance: 'github.com', id: 'spoof/fork', owner: 'spoof', name: 'fork', url: 'https://attacker.example/fork', cloneUrl: 'https://attacker.example/fork.git' },
    }), context, {});
    expect(result).toEqual({
      existingBranch: 'remotes/pr-spoof/feature/worktree',
      expectedRevision: HEAD_SHA,
      changeRequestSource: {
        context,
        project: { id: 'acme/app', owner: 'acme', name: 'app' },
        number: 42,
        expectedHeadSha: HEAD_SHA,
        requestedRemoteName: 'pr-spoof',
      },
      sourceLabel: 'feature/worktree',
    });
    expect('ensureRemoteUrl' in result).toBe(false);
    expect('contributorFork' in result).toBe(false);
  });

  test('uses an exact local head only as a checkout hint', () => {
    const result = resolvePrWorktreeConfig(changeRequest(), context, {
      'feature/worktree': { current: false, name: 'feature/worktree', commit: HEAD_SHA, label: '' },
    });
    expect(result.existingBranch).toBe('feature/worktree');
    expect(result.changeRequestSource.expectedHeadSha).toBe(HEAD_SHA);
  });

  test('fails closed without the expected head revision', () => {
    expect(() => resolvePrWorktreeConfig(changeRequest({ headSha: undefined }), context, {}))
      .toThrow('PR head revision is missing');
  });
});
