import type { GetGitDiffsOptions, GitPathDiffBatchEntry } from '@/lib/api/types';

/** A file the batch may read along with the requested one. */
export type FindDiffBatchPeer = { filePath: string; revision: string };

export type FindDiffBatchRead = {
  directory: string;
  filePath: string;
  /** What the file's diff depends on; an entry answers only for this revision. */
  revision: string;
  staged: boolean;
  contextLines: number;
  /** Other files of the same side and context, as the bar's sources list them. */
  peers: readonly FindDiffBatchPeer[];
  getGitDiffs: (directory: string, options: GetGitDiffsOptions) => Promise<GitPathDiffBatchEntry[]>;
};

/**
 * The find bar reads a changeset one file at a time. This reader turns the
 * first of those reads into one request for every peer whose entry is missing
 * or was read at another revision, and answers the following reads from it.
 * It resolves to null when the batch has no answer (the request failed, or the
 * path was not in it), so the caller falls back to the file's own read and a
 * batch failure never becomes the file's error. A failed request is forgotten,
 * so the next read asks again.
 */
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
