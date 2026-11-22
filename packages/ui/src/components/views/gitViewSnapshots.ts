export type GitViewSnapshot = {
  directory?: string;
  commitMessage: string;
  generatedHighlights: string[];
};

const CAP = 20;

const snapshots = new Map<string, GitViewSnapshot>();

export const readGitViewSnapshot = (key: string) => snapshots.get(key) ?? null;

export const rememberGitViewSnapshot = (key: string, snapshot: GitViewSnapshot) => {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  if (snapshots.size > CAP) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
};
