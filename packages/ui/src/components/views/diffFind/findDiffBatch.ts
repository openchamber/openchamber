import type { GetGitDiffsOptions, GitPathDiffBatchEntry } from '@/lib/api/types';

export type FindDiffBatchPeer = { filePath: string; revision: string };

export type FindDiffBatchRead = {
  directory: string;
  filePath: string;
  revision: string;
  staged: boolean;
  contextLines: number;
  peers: readonly FindDiffBatchPeer[];
  getGitDiffs: (directory: string, options: GetGitDiffsOptions) => Promise<GitPathDiffBatchEntry[]>;
};

export function createFindDiffBatchReader() {
  const cache = new Map<string, { directory: string; revision: string; read: Promise<GitPathDiffBatchEntry | null> }>();

  return ({ directory, filePath, revision, staged, contextLines, peers, getGitDiffs }: FindDiffBatchRead): Promise<GitPathDiffBatchEntry | null> => {
    const isCurrent = (path: string, pathRevision: string) => {
      const entry = cache.get(path);
      return entry !== undefined && entry.directory === directory && entry.revision === pathRevision;
    };
    const cached = cache.get(filePath);
    if (cached && isCurrent(filePath, revision)) return cached.read;

    const pending = new Map<string, string>([[filePath, revision]]);
    for (const peer of peers) {
      if (!pending.has(peer.filePath) && !isCurrent(peer.filePath, peer.revision)) pending.set(peer.filePath, peer.revision);
    }
    const request = getGitDiffs(directory, { paths: [...pending.keys()], staged, contextLines })
      .then((entries) => new Map(entries.map((entry) => [entry.path, entry])));
    for (const [path, pathRevision] of pending) {
      const read: Promise<GitPathDiffBatchEntry | null> = request.then((entries) => entries.get(path) ?? null, () => {
        if (cache.get(path)?.read === read) cache.delete(path);
        return null;
      });
      cache.set(path, { directory, revision: pathRevision, read });
    }
    return cache.get(filePath)?.read ?? Promise.resolve(null);
  };
}
