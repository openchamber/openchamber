import type { GitLabThreadRef } from '@/lib/linkedIssues';
import type { TrackedLinearIssue, TrackedThread } from './model';

// The items behind a session's links, in the shape the server follows.

export const githubThread = <Kind extends 'pull' | 'issue'>(kind: Kind, ref: { owner: string; repo: string; number: number }): TrackedThread<Kind> => (
  { provider: 'github', kind, owner: ref.owner, repo: ref.repo, number: ref.number }
);

export const gitlabThread = <Kind extends 'pull' | 'issue'>(kind: Kind, ref: GitLabThreadRef): TrackedThread<Kind> => (
  { provider: 'gitlab', instance: ref.instance, kind, owner: ref.owner, repo: ref.repo, number: ref.number }
);

export const linearIssue = (identifier: string): TrackedLinearIssue => ({ provider: 'linear', identifier: identifier.toUpperCase() });
