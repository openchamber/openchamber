import type { GitLabThreadRef } from '@/lib/linkedIssues';
import type { SourceControlProvider } from '@/lib/source-control/types';
import type { TrackedLinearIssue, TrackedThread } from './model';

// The items behind a session's links, in the shape the server follows.

export const githubThread = <Kind extends 'pull' | 'issue'>(kind: Kind, ref: { owner: string; repo: string; number: number }): TrackedThread<Kind> => (
  { provider: 'github', kind, owner: ref.owner, repo: ref.repo, number: ref.number }
);

export const gitlabThread = <Kind extends 'pull' | 'issue'>(
  kind: Kind,
  ref: Pick<GitLabThreadRef, 'instance' | 'owner' | 'repo' | 'number'>,
): TrackedThread<Kind> => (
  { provider: 'gitlab', instance: ref.instance, kind, owner: ref.owner, repo: ref.repo, number: ref.number }
);

export const linearIssue = (identifier: string): TrackedLinearIssue => ({ provider: 'linear', identifier: identifier.toUpperCase() });

type RepositoryItemReference = {
  kind: 'pull' | 'issue';
  number: number;
  sourceRepo: { owner: string; repo: string };
  provider?: SourceControlProvider;
};

type RepositoryItemContext = {
  provider: SourceControlProvider;
  instance: string;
};

/**
 * The tracked item behind a repository issue or change request the Tracker
 * shows. GitLab items are keyed by the instance the panel read them through;
 * one whose context is missing cannot name the key the sidebar declared, so it
 * is not sent.
 */
export const trackedItemForReference = (
  reference: RepositoryItemReference,
  context: RepositoryItemContext | null,
): TrackedThread | null => {
  const { kind, number, sourceRepo } = reference;
  if (reference.provider === 'gitlab') {
    if (!context || context.provider !== 'gitlab' || !context.instance) return null;
    return gitlabThread(kind, {
      instance: context.instance.toLowerCase(),
      owner: sourceRepo.owner,
      repo: sourceRepo.repo,
      number,
    });
  }
  return githubThread(kind, { owner: sourceRepo.owner, repo: sourceRepo.repo, number });
};
