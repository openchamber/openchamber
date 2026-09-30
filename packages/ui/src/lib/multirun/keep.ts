import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { snapshotGitWorktree } from '@/lib/gitApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { listProjectWorktrees, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { listGlobalSessionPages, type SessionPageLister } from '@/stores/globalSessions';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { getMultiRunIdentity } from './identity';
import type { MultiRunSummary } from './runs';

const listSessionPage: SessionPageLister = (options) => opencodeClient.listSessionsPage(options);

type KeepFailureReason = 'membership-changed' | 'snapshot-failed' | 'archive-failed' | 'worktree-in-use' | 'worktree-removal-failed';

export type KeepRunResult = {
  keptSessionId: string;
  /** Members whose chat was archived (their worktree is gone unless listed in `failures`). */
  archivedIds: string[];
  failures: Array<{ sessionId: string; reason: KeepFailureReason }>;
};

/** Private ref that preserves a lane's complete work before its worktree is removed. */
export const runSnapshotRef = (run: Pick<MultiRunSummary, 'key' | 'groupSlug' | 'lanes' | 'fusions'>, sessionId: string): string => {
  const member = [...run.lanes, ...run.fusions].find((entry) => entry.sessionId === sessionId);
  const group = member?.identity.group;
  const groupPart = group?.kind === 'id' ? group.id : run.groupSlug.replace(/[^A-Za-z0-9._-]+/g, '-') || 'legacy';
  return `refs/openchamber/runs/${groupPart}/${sessionId.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
};

const projectRefFor = (path: string): ProjectRef => {
  const project = useProjectsStore.getState().projects.find((entry) => normalizePath(entry.path) === path);
  return { id: project?.id ?? `path:${path}`, path };
};

export type RunMemberLocation = { project: ProjectRef; worktree: WorktreeMetadata | null };

/**
 * Where a member lives: its project, and the worktree when it has one. A
 * member in the project root has no worktree and is never removed.
 */
export async function resolveRunMemberLocation(session: Session, run: MultiRunSummary): Promise<RunMemberLocation | null> {
  const directory = normalizePath(session.directory);
  if (!directory) return null;
  const known = useSessionUIStore.getState().getWorktreeMetadata(session.id);
  const knownProject = normalizePath(known?.projectDirectory);
  if (known && knownProject && normalizePath(known.path) === directory) {
    return { project: projectRefFor(knownProject), worktree: knownProject === directory ? null : known };
  }
  const member = [...run.lanes, ...run.fusions].find((entry) => entry.sessionId === session.id);
  const legacyScope = member?.identity.group.kind === 'legacy' ? normalizePath(member.identity.group.scope) : null;
  const projects = useProjectsStore.getState().projects
    .map((project) => normalizePath(project.path))
    .filter((path): path is string => Boolean(path));
  if (projects.includes(directory)) return { project: projectRefFor(directory), worktree: null };
  const candidates = legacyScope ? [legacyScope, ...projects.filter((path) => path !== legacyScope)] : projects;
  for (const projectPath of candidates) {
    const project = projectRefFor(projectPath);
    const worktree = (await listProjectWorktrees(project)).find((entry) => normalizePath(entry.path) === directory);
    if (worktree) return { project, worktree };
  }
  return null;
}

/**
 * Keeps one member of a run and cleans up the others. For every other member:
 * snapshot its worktree (tracked and untracked work) into a private ref, then
 * archive its chat, then remove the worktree and its local branch. A step that
 * fails stops cleanup for that member only and leaves its worktree in place.
 * The project root is never removed.
 */
export async function keepRunMember(
  run: MultiRunSummary,
  keptSessionId: string,
  sessionById: ReadonlyMap<string, Session>,
): Promise<KeepRunResult> {
  const runtimeKey = getRuntimeKey();
  const assertCurrent = () => {
    if (getRuntimeKey() !== runtimeKey) throw new Error('Runtime changed');
  };
  const result: KeepRunResult = { keptSessionId, archivedIds: [], failures: [] };
  const others = run.memberIds.filter((id) => id !== keptSessionId);

  for (const sessionId of others) {
    assertCurrent();
    const cached = sessionById.get(sessionId);
    if (!cached) {
      result.failures.push({ sessionId, reason: 'membership-changed' });
      continue;
    }
    let current: Session;
    try {
      current = await opencodeClient.getSession(sessionId, cached.directory);
    } catch {
      assertCurrent();
      result.failures.push({ sessionId, reason: 'membership-changed' });
      continue;
    }
    assertCurrent();
    const location = await resolveRunMemberLocation(current, run).catch(() => null);
    assertCurrent();
    const identity = getMultiRunIdentity(current, location?.project.path ?? current.directory);
    if (identity?.key !== run.key) {
      result.failures.push({ sessionId, reason: 'membership-changed' });
      continue;
    }

    const worktree = location?.worktree ?? null;
    if (worktree) {
      try {
        await snapshotGitWorktree(worktree.path, { ref: runSnapshotRef(run, sessionId) });
      } catch {
        assertCurrent();
        result.failures.push({ sessionId, reason: 'snapshot-failed' });
        continue;
      }
      assertCurrent();
    }

    const archived = await useSessionUIStore.getState().archiveSessions([sessionId], { expectedRuntimeKey: runtimeKey });
    assertCurrent();
    if (!archived.archivedIds.includes(sessionId)) {
      result.failures.push({ sessionId, reason: 'archive-failed' });
      continue;
    }
    result.archivedIds.push(sessionId);
    if (!worktree || !location) continue;

    try {
      // Another chat the user started in this worktree keeps it alive.
      const remaining = await listGlobalSessionPages(listSessionPage, { directory: worktree.path, pageSize: 500 });
      assertCurrent();
      if (remaining.some((session) => session.id !== sessionId && !session.time?.archived)) {
        result.failures.push({ sessionId, reason: 'worktree-in-use' });
        continue;
      }
      await removeProjectWorktree(location.project, worktree, { deleteLocalBranch: true });
      assertCurrent();
      const directoryStore = useDirectoryStore.getState();
      if (normalizePath(directoryStore.currentDirectory) === normalizePath(worktree.path)) {
        directoryStore.setDirectory(location.project.path, { showOverlay: false });
      }
    } catch {
      assertCurrent();
      result.failures.push({ sessionId, reason: 'worktree-removal-failed' });
    }
  }
  return result;
}
