export type SessionArchiveResult = {
  archivedIds: string[];
  failedIds: string[];
};

/**
 * Archives a worktree's sessions, then removes (or archives) the worktree. The sessions go
 * first because OpenCode can change a session only while its directory exists:
 * archived after the removal, each one would have to move to the project's
 * main folder first and carry a "moved" note in its transcript. A removal that
 * fails or throws restores the sessions it archived, so no archived session
 * stays attached to a worktree still on disk; a throw is passed on after that.
 */
export async function archiveSessionsThenRemoveWorktree(options: {
  sessionIds: string[];
  /** Gets the sessions it archived: an archive of the worktree records them. */
  removeWorktree: (archivedIds: string[]) => Promise<boolean>;
  archiveSessions: (sessionIds: string[]) => Promise<SessionArchiveResult>;
  restoreSessions: (sessionIds: string[]) => Promise<{ failedIds: string[] }>;
}): Promise<{ removed: boolean; archive: SessionArchiveResult }> {
  const archive = options.sessionIds.length > 0
    ? await options.archiveSessions(options.sessionIds)
    : { archivedIds: [], failedIds: [] };
  const restore = async () => {
    if (archive.archivedIds.length === 0) return;
    const { failedIds } = await options.restoreSessions(archive.archivedIds)
      .catch(() => ({ failedIds: archive.archivedIds }));
    if (failedIds.length > 0) {
      console.warn(`[worktrees] ${failedIds.length} session(s) stay archived after the worktree removal failed`);
    }
  };

  let removed: boolean;
  try {
    removed = await options.removeWorktree(archive.archivedIds);
  } catch (error) {
    await restore();
    throw error;
  }
  if (removed) return { removed, archive };
  await restore();
  return { removed, archive: { archivedIds: [], failedIds: [] } };
}
