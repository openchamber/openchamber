import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { generateUuid } from '@/lib/uuid';
import { snapshotGitWorktree } from '@/lib/gitApi';
import { createWorktreeWithDefaults } from '@/lib/worktrees/worktreeCreate';
import { resolveCreatedWorktreeStartDirectory } from '@/lib/worktrees/worktreeStartDirectory';
import { registerMultiRunSession } from '@/stores/useMultiRunStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getMultiRunIdentity } from './identity';
import { createMultiRunSession } from './createSession';
import { resolveRunMemberLocation, runSnapshotRef } from './keep';
import type { MultiRunSummary } from './runs';
import type { FusionJudge } from './fusion';

type ParentCreationEffects = {
  readSession: typeof opencodeClient.getSession;
  locate: typeof resolveRunMemberLocation;
  snapshot: typeof snapshotGitWorktree;
  createWorktree: typeof createWorktreeWithDefaults;
  startDirectory: typeof resolveCreatedWorktreeStartDirectory;
  createSession: typeof createMultiRunSession;
  publish: typeof registerMultiRunSession;
  attachWorktree: ReturnType<typeof useSessionUIStore.getState>['setWorktreeMetadata'];
};
const parentCreationEffects: ParentCreationEffects = {
  readSession: (id, directory) => opencodeClient.getSession(id, directory),
  locate: resolveRunMemberLocation, snapshot: snapshotGitWorktree, createWorktree: createWorktreeWithDefaults,
  startDirectory: resolveCreatedWorktreeStartDirectory, createSession: createMultiRunSession, publish: registerMultiRunSession,
  attachWorktree: (...args) => useSessionUIStore.getState().setWorktreeMetadata(...args),
};

/** Creates a normal, editable parent chat on demand; creating it sends no prompt. */
export async function createRunParent(input: {
  run: MultiRunSummary;
  sessionById: ReadonlyMap<string, Session>;
  model: FusionJudge;
  title: string;
}, io: ParentCreationEffects = parentCreationEffects): Promise<Session> {
  const runtime = getRuntimeKey();
  const client = opencodeClient.getSdkClient();
  const current = () => {
    if (getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
  };
  const template = input.sessionById.get((input.run.lanes[0] ?? input.run.fusions[0])?.sessionId ?? '');
  if (!template) throw new Error('Run has no source session');
  const anchor = await io.readSession(template.id, template.directory);
  current();
  const location = await io.locate(anchor, input.run);
  current();
  const identity = getMultiRunIdentity(anchor, location?.project.path ?? anchor.directory);
  if (identity?.key !== input.run.key || anchor.time.archived) throw new Error('Run membership changed');
  let directory = location?.project.path ?? anchor.directory;
  let worktree: Awaited<ReturnType<typeof createWorktreeWithDefaults>> | null = null;
  if (location?.worktree) {
    const suffix = generateUuid();
    const snapshot = await io.snapshot(location.worktree.path, { ref: `${runSnapshotRef(input.run, anchor.id)}-parent-${suffix}` });
    current();
    const name = `${input.run.groupSlug}/parent-${suffix}`;
    worktree = await io.createWorktree(location.project, {
      preferredName: name, mode: 'new', branchName: name, worktreeName: name, startRef: snapshot.head,
      setupCommands: [], returnAfterDirectoryCreated: true,
    });
    current();
    directory = await io.startDirectory(location.project, worktree);
    current();
  }
  const session = await io.createSession({
    title: input.title, directory,
    identity: { group: identity.group, groupSlug: identity.groupSlug, title: input.run.title,
      role: 'parent', providerID: input.model.providerID, modelID: input.model.modelID },
    selection: { model: { providerID: input.model.providerID, id: input.model.modelID, variant: input.model.variant }, agent: input.model.agent },
  }, current);
  current();
  io.publish(session, directory);
  if (worktree) io.attachWorktree(session.id, { ...worktree, kind: 'standard' }, directory);
  return session;
}
