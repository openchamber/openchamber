import type { TrackedThread, TrackedThreadKind, TrackedWorkItem } from './model';

// The items behind a session's links, in the shape the server follows.

/** A linked issue, discussion or change request on any source-control provider, as the item the server follows. */
export const repositoryThread = <Kind extends TrackedThreadKind>(
  kind: Kind,
  ref: { provider: string; instance: string; owner: string; repo: string; number: number },
): TrackedThread<Kind> => (
  { provider: ref.provider, instance: ref.instance, kind, owner: ref.owner, repo: ref.repo, number: ref.number }
);

/** A tracker's work item, as the item the server follows. */
export const workItem = (provider: string, identifier: string): TrackedWorkItem => (
  { provider, kind: 'work-item', identifier: identifier.toUpperCase() }
);
