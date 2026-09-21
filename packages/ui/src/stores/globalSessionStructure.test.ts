import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { mergeSessionDirectoryMetadata } from './globalSessionStructure';

type SessionWithProjectMetadata = Session & {
  project?: { id?: string; worktree?: string } | null;
};

const sessionWithProjectMetadata = (
  projectID: string,
  project: SessionWithProjectMetadata['project'],
): SessionWithProjectMetadata => ({
  id: 'session',
  slug: 'session',
  projectID,
  directory: '/workspace',
  title: 'Session',
  version: '1',
  time: { created: 1, updated: 1 },
  project,
});

describe('mergeSessionDirectoryMetadata', () => {
  test('retains project identity when a lighter record omits it', () => {
    const existing = sessionWithProjectMetadata('opencode-project', { id: 'opencode-project', worktree: '/workspace' });
    const incoming = sessionWithProjectMetadata('opencode-project', { worktree: '/workspace' });

    expect(mergeSessionDirectoryMetadata(incoming, existing)).toEqual({
      ...incoming,
      project: { id: 'opencode-project', worktree: '/workspace' },
    });
  });

  test('does not pair an incoming project worktree with a conflicting previous ID', () => {
    const existing = sessionWithProjectMetadata('old-project', { id: 'old-project', worktree: '/workspace/old' });
    const incoming = sessionWithProjectMetadata('new-project', { id: 'new-project', worktree: '/workspace/new' });

    expect(mergeSessionDirectoryMetadata(incoming, existing)).toEqual({
      ...incoming,
    });
  });
});
