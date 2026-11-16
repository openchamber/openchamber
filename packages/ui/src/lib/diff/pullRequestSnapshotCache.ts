import type { parsePullRequestDiff, PullRequestSource } from './pullRequestDiff';

type Snapshot = ReturnType<typeof parsePullRequestDiff>;
interface Entry {
  scope: string;
  pending: Promise<Snapshot>;
  files: Snapshot | null;
  bytes: number;
}

export class PullRequestSnapshotCache {
  private entries = new Map<string, Entry>();

  load(scope: string, source: PullRequestSource, fetch: () => Promise<Snapshot>, force = false, authority = ''): Promise<Snapshot> {
    const key = JSON.stringify([scope, source, authority]);
    const existing = this.entries.get(key);
    if (existing && (!force || existing.files === null)) return existing.pending;
    const entry: Entry = { scope, pending: fetch(), files: null, bytes: 0 };
    entry.pending = entry.pending.then((files) => {
      if (this.entries.get(key) !== entry) return files;
      entry.files = files;
      entry.bytes = files.reduce((sum, file) => sum + 2 * (file.patch.length + file.path.length), 0);
      let bytes = [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0);
      for (const [candidate, value] of this.entries) {
        if (this.entries.size <= 8 && bytes <= 32 * 1024 * 1024) break;
        if (value === entry || value.files === null) continue;
        bytes -= value.bytes;
        this.entries.delete(candidate);
      }
      return files;
    }).catch((error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.pending;
  }

  invalidate(scope: string) {
    for (const [key, entry] of this.entries) {
      if (entry.scope === scope) this.entries.delete(key);
    }
  }
}
