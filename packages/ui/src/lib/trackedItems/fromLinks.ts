import type { TrackedThread, TrackedThreadKind, TrackedWorkItem } from './model';


export const repositoryThread = <Kind extends TrackedThreadKind>(
  kind: Kind,
  ref: { provider: string; instance: string; owner: string; repo: string; number: number },
): TrackedThread<Kind> => (
  { provider: ref.provider, instance: ref.instance, kind, owner: ref.owner, repo: ref.repo, number: ref.number }
);

export const workItem = (provider: string, identifier: string): TrackedWorkItem => (
  { provider, kind: 'work-item', identifier: identifier.toUpperCase() }
);
