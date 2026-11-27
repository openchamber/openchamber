import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForDirectory } from '@/lib/projectResolution';
import { checkoutHoldsDirectory } from './worktreePaths';

export type ReadOnlySessionAssociation = { projectId: string; projectRoot: string; directory: string };
export type NestedSessionOwnerCandidate = ReadOnlySessionAssociation & { id: string; repository: string };
type RootRecord = { id: string; directory?: string | null; projectID: string; parentID?: string | null; time?: { archived?: number } };
type Listing = (directory: string) => Promise<readonly { path?: string; prunable?: boolean }[]>;

export function findNestedSessionCandidates(
  sessions: Iterable<RootRecord>, projects: Parameters<typeof resolveProjectForDirectory>[0],
  nativeProjects: readonly { id: string; worktree: string; vcs?: string }[],
  knownDirectories: ReadonlySet<string>,
): NestedSessionOwnerCandidate[] {
  const repositories = new Map<string, string | null>();
  for (const project of nativeProjects) {
    if (project.id === 'global' || project.vcs !== 'git') continue;
    const path = normalizePath(project.worktree);
    repositories.set(project.id, repositories.has(project.id) && repositories.get(project.id) !== path ? null : path);
  }
  const eligible = new Map<string, { repository: string; projectId: string; projectRoot: string }>();
  for (const [id, repository] of repositories) {
    if (!repository) continue;
    const owner = resolveProjectForDirectory(projects, repository);
    const projectRoot = normalizePath(owner?.path);
    if (owner && projectRoot && projectRoot !== repository) {
      eligible.set(id, { repository, projectId: owner.id, projectRoot });
    }
  }
  const result: NestedSessionOwnerCandidate[] = [];
  if (!eligible.size) return result;
  const roots = [...knownDirectories];
  for (const session of sessions) {
    const repo = eligible.get(session.projectID);
    if (!repo || session.parentID || session.time?.archived) continue;
    const directory = normalizePath(session.directory);
    if (!directory || resolveProjectForDirectory(projects, directory) || roots.some((root) => checkoutHoldsDirectory(root, directory))) continue;
    result.push({ id: session.id, directory, ...repo });
  }
  return result;
}

export async function readNestedWorktreePaths(repository: string, list: Listing): Promise<ReadonlySet<string>> {
  return listedLinkedWorktrees(repository, await list(repository));
}

export function listedLinkedWorktrees(repository: string, rows: readonly { path?: string; prunable?: boolean }[]): ReadonlySet<string> {
  if (rows[0]?.prunable || normalizePath(rows[0]?.path) !== repository) return new Set();
  return new Set(rows.slice(1).flatMap((entry) => !entry.prunable ? normalizePath(entry.path) ?? [] : []));
}

const linkedHolds = (linked: ReadonlySet<string> | undefined, directory: string): boolean => (
  linked ? [...linked].some((checkout) => checkoutHoldsDirectory(checkout, directory)) : false
);

type RepositoryLookup = {
  status: 'pending' | 'success' | 'failed';
  checked: ReadonlySet<string>;
  linked?: ReadonlySet<string>;
  prior?: ReadonlyMap<string, ReadOnlySessionAssociation>;
  pendingCandidates?: readonly NestedSessionOwnerCandidate[];
};

export class NestedSessionOwnerDiscovery {
  private readonly repositories = new Map<string, RepositoryLookup>();

  constructor(
    private readonly list: (repository: string) => Promise<ReadonlySet<string> | null>,
    private readonly changed: () => void,
  ) {}

  reconcile(candidates: readonly NestedSessionOwnerCandidate[]): void {
    const byRepository = new Map<string, NestedSessionOwnerCandidate[]>();
    for (const candidate of candidates) {
      const entries = byRepository.get(candidate.repository) ?? [];
      entries.push(candidate);
      byRepository.set(candidate.repository, entries);
    }
    for (const repository of this.repositories.keys()) {
      if (byRepository.has(repository)) continue;
      this.repositories.delete(repository);
    }
    for (const [repository, entries] of byRepository) {
      const current = this.repositories.get(repository);
      if (current?.status === 'pending') { current.pendingCandidates = entries; continue; }
      if (current?.status === 'success' && entries.every((entry) => current.checked.has(entry.directory) || linkedHolds(current.linked, entry.directory))) continue;
      this.start(repository, entries);
    }
    this.changed();
  }

  invalidate(repositories: ReadonlySet<string>, candidates: readonly NestedSessionOwnerCandidate[]): void {
    for (const repository of repositories) {
      const entries = candidates.filter((entry) => entry.repository === repository);
      if (entries.length) this.start(repository, entries);
      else this.repositories.delete(repository);
    }
  }

  owners(candidates: readonly NestedSessionOwnerCandidate[]): ReadonlyMap<string, ReadOnlySessionAssociation> {
    const result = new Map<string, ReadOnlySessionAssociation>();
    for (const candidate of candidates) {
      const lookup = this.repositories.get(candidate.repository);
      const prior = lookup?.prior?.get(candidate.id);
      if (linkedHolds(lookup?.linked, candidate.directory)
        || (prior && prior.directory === candidate.directory && prior.projectRoot === candidate.projectRoot && prior.projectId === candidate.projectId)) result.set(candidate.id, {
        directory: candidate.directory, projectId: candidate.projectId, projectRoot: candidate.projectRoot,
      });
    }
    return result;
  }

  dispose(): void {
    this.repositories.clear();
  }

  private start(repository: string, candidates: readonly NestedSessionOwnerCandidate[]): void {
    const checked = new Set(candidates.map((entry) => entry.directory));
    const lookup: RepositoryLookup = { status: 'pending', prior: this.owners(candidates), checked };
    this.repositories.set(repository, lookup);
    void this.list(repository).then((linked) => {
      if (this.repositories.get(repository) !== lookup) return;
      this.repositories.set(repository, linked ? { status: 'success', linked, checked } : { status: 'failed', checked });
      this.changed();
      if (linked && lookup.pendingCandidates?.some((entry) => !checked.has(entry.directory) && !linkedHolds(linked, entry.directory))) {
        this.start(repository, lookup.pendingCandidates);
      }
    }, () => {
      if (this.repositories.get(repository) !== lookup) return;
      this.repositories.set(repository, { status: 'failed', checked });
      this.changed();
    });
  }
}
