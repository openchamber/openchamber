export type SessionArchiveResult = {
  archivedIds: string[];
  failedIds: string[];
};

export async function removeWorktreeThenArchiveSessions(options: {
  sessionIds: string[];
  removeWorktree: () => Promise<boolean>;
  archiveSessions: (sessionIds: string[]) => Promise<SessionArchiveResult>;
}): Promise<{ removed: boolean; archive: SessionArchiveResult }> {
  const removed = await options.removeWorktree();
  if (!removed || options.sessionIds.length === 0) {
    return { removed, archive: { archivedIds: [], failedIds: [] } };
  }

  return {
    removed: true,
    archive: await options.archiveSessions(options.sessionIds),
  };
}
